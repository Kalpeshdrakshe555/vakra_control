# 🎙️ Production-Grade Full-Duplex Voice Assistant Integration Blueprint

## 1. Overview & Architectural Goal
This document provides the complete, self-contained architecture and implementation logic for building an **Open-Source, Low-Latency (<500ms), Full-Duplex Real-Time Voice Assistant** with natural barge-in (interruption) capability and acoustic echo immunity.

You can hand this document directly to an AI coding agent or engineering team to implement in any project (FastAPI, Django Channels, Node.js, Python AsyncIO, etc.).

---

## 2. Core Full-Duplex Pipeline

```
[ Human User (Browser / Mobile / WebRTC Mic) ]
       │
       ▼ (16kHz 16-bit Mono Raw PCM Chunks via Persistent WebSocket)
┌────────────────────────────────────────────────────────────────────────┐
│                   CLIENT-SIDE / EDGE DSP (BROWSER)                     │
│ 1. Native Hardware Echo Cancellation (googEchoCancellation, AGC, NS)   │
│ 2. Dynamic Gating: Idle = 0.015 RMS | AI Speaking = 0.075 RMS           │
│ 3. Client Debounce: >= 2 frames (~500ms) speech -> Instantly abort audio│
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼ WebSocket Stream
┌────────────────────────────────────────────────────────────────────────┐
│                   BACKEND FULL-DUPLEX ENGINE (SERVER)                  │
│                                                                        │
│  [ Inbound Stream Handler ]                                            │
│        │                                                               │
│        ├──► [ Server VAD & Interruption Guard ]                        │
│        │        - If RMS >= 0.075 sustained for 2 frames (~500ms)      │
│        │        - Cancel running asyncio task: `active_task.cancel()`  │
│        │        - Send `{"event": "clear_buffer"}` to client           │
│        │                                                               │
│        └──► [ Audio Buffer Accumulator ]                               │
│                 - Silence > 800ms -> Sentence complete                 │
│                 - Dispatch `process_audio()` pipeline                  │
│                                                                        │
│  [ Open-Source AI Stack ]                                              │
│        │                                                               │
│        ├──► 1. STT: Whisper (faster-whisper / Whisper.cpp / Groq API) │
│        ├──► 2. LLM: Llama-3.3-70B / Qwen-2.5 / Mistral (vLLM / Ollama)│
│        └──► 3. TTS: Kokoro-82M / Piper TTS / Edge TTS (Neural natural) │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Recommended 100% Open-Source Model Stack

| Component | Model / Engine | Why This Choice? | Latency Target |
| :--- | :--- | :--- | :--- |
| **STT (Speech-to-Text)** | **faster-whisper** (`large-v3` / `distil-large-v3`) OR **Groq Whisper** | Batched CTranslate2 inference, 4x faster than vanilla Whisper, zero cost self-hosted. | ~150ms - 300ms |
| **LLM (Brain)** | **vLLM + Llama-3.3-70B-Instruct** (or **Qwen-2.5-14B/32B**) | Tensor parallelism, streaming tokens, continuous batching. | ~150ms - 250ms (TTFT) |
| **TTS (Text-to-Speech)** | **Kokoro-82M** (Apache 2.0) OR **Piper TTS** OR **Microsoft Edge TTS** | Kokoro-82M is ultra-realistic, open-weights, sounds completely human, runs locally on CPU/GPU. | ~100ms - 200ms |

---

## 4. Frontend / Client Logic (Browser Audio Capture & Echo Shield)

### Critical WebRTC Constraints
Microphone capture **MUST** enforce deep acoustic echo cancellation constraints so laptop/phone speakers do not bleed back into the mic:

```javascript
// 1. Initialize Microphone with Hardware DSP Flags
const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        googEchoCancellation: true,
        googAutoGainControl: true,
        googNoiseSuppression: true,
        googHighpassFilter: true,
        googTypingNoiseDetection: true
    },
    video: false
});

// 2. Setup AudioContext & ScriptProcessor (16kHz PCM streaming)
const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
const source = audioCtx.createMediaStreamSource(stream);
const processor = audioCtx.createScriptProcessor(4096, 1, 1); // ~256ms chunk buffer

let isAiSpeaking = false;
let speechFrameCount = 0;
let silenceTimer = null;
let currentAudioPlayer = null;

processor.onaudioprocess = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    const inputData = e.inputBuffer.getChannelData(0);

    // Calculate RMS Volume
    let sumSquares = 0;
    for (let i = 0; i < inputData.length; i++) {
        sumSquares += inputData[i] * inputData[i];
    }
    const rms = Math.sqrt(sumSquares / inputData.length);

    // ADAPTIVE ENERGY THRESHOLD:
    // If AI is speaking over speakers: elevate threshold to 0.075 to reject acoustic bleed.
    // When AI is silent: sensitive threshold 0.015 to catch natural voice.
    const dynamicThreshold = isAiSpeaking ? 0.075 : 0.015;

    // Convert Float32 to 16-bit PCM Buffer
    const pcmBuffer = new ArrayBuffer(inputData.length * 2);
    const view = new DataView(pcmBuffer);
    for (let i = 0; i < inputData.length; i++) {
        let s = Math.max(-1, Math.min(1, inputData[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    const b64Data = btoa(String.fromCharCode(...new Uint8Array(pcmBuffer)));

    if (rms > dynamicThreshold) {
        speechFrameCount++;

        // INSTANT CLIENT BARGE-IN:
        // If AI is playing and user speaks for >= 2 consecutive frames (~500ms):
        if (isAiSpeaking && speechFrameCount >= 2) {
            console.log("[Barge-In] User interrupted bot. Stopping local audio.");
            if (currentAudioPlayer) {
                currentAudioPlayer.pause();
                currentAudioPlayer = null;
            }
            isAiSpeaking = false;
            ws.send(JSON.stringify({ event: "interrupt" }));
        }

        silenceTimer = null;
        ws.send(JSON.stringify({ event: "media", is_speech: true, payload: b64Data }));
    } else {
        // Trailing silence detection (850ms silence = user finished speaking)
        if (!silenceTimer) {
            silenceTimer = Date.now();
        } else if (Date.now() - silenceTimer > 850) {
            if (speechFrameCount >= 2) {
                ws.send(JSON.stringify({ event: "stop" })); // Trigger inference
            }
            speechFrameCount = 0;
            silenceTimer = null;
        }
        // Send ambient frame tagged is_speech: false for server VAD tracking
        ws.send(JSON.stringify({ event: "media", is_speech: false, payload: b64Data }));
    }
};

source.connect(processor);
processor.connect(audioCtx.destination);
```

---

## 5. Backend Server Implementation (Python AsyncIO / WebSockets)

The backend maintains state, handles cancellations gracefully via `asyncio.Task`, and streams responses:

```python
import asyncio
import base64
import json
import logging
import math
import struct
import io
import wave

logger = logging.getLogger("FullDuplexVoice")

class FullDuplexVoiceEngine:
    VAD_RMS_INTERRUPT_THRESHOLD = 0.075  # Tuned for loudspeaker bleed immunity
    SAMPLE_RATE = 16000

    def __init__(self, websocket_send_fn):
        self.send = websocket_send_fn
        self.audio_buffer = bytearray()
        self.active_response_task = None     # Holds running LLM+TTS asyncio.Task
        self.is_bot_speaking = False
        self.bot_speech_start_time = 0.0
        self.consecutive_speech_frames = 0

    def compute_rms(self, pcm_bytes: bytes) -> float:
        """Calculates RMS audio level of 16-bit PCM mono."""
        if not pcm_bytes:
            return 0.0
        sample_count = len(pcm_bytes) // 2
        if sample_count == 0:
            return 0.0
        shorts = struct.unpack(f"<{sample_count}h", pcm_bytes)
        sum_sq = sum((s / 32768.0) ** 2 for s in shorts)
        return math.sqrt(sum_sq / sample_count)

    async def handle_interruption_check(self, chunk_bytes: bytes):
        """Server-side VAD Barge-in detector."""
        if not (self.is_bot_speaking or (self.active_response_task and not self.active_response_task.done())):
            self.consecutive_speech_frames = 0
            return

        # Cooldown grace period (first 850ms of audio startup)
        now = asyncio.get_event_loop().time()
        if (now - self.bot_speech_start_time) < 0.85:
            self.consecutive_speech_frames = 0
            return

        rms = self.compute_rms(chunk_bytes)
        if rms >= self.VAD_RMS_INTERRUPT_THRESHOLD:
            self.consecutive_speech_frames += 1
        else:
            self.consecutive_speech_frames = 0

        # Debounce: require 2 sustained frames (~500ms) to abort
        if self.consecutive_speech_frames >= 2:
            logger.info(f"Barge-In detected on server (RMS: {rms:.3f}). Aborting bot response...")
            await self.cancel_active_response()
            self.consecutive_speech_frames = 0

    async def cancel_active_response(self):
        """Cancels background generation and instructs client to purge audio player."""
        if self.active_response_task and not self.active_response_task.done():
            self.active_response_task.cancel()
            self.active_response_task = None

        self.is_bot_speaking = False
        self.audio_buffer.clear()

        # Tell client to mute immediately
        await self.send(json.dumps({"event": "clear_buffer"}))

    async def on_receive_message(self, raw_json: str):
        data = json.loads(raw_json)
        event = data.get("event")

        if event == "media":
            payload = base64.b64decode(data.get("payload", ""))
            await self.handle_interruption_check(payload)
            if data.get("is_speech", False):
                self.audio_buffer.extend(payload)

        elif event == "interrupt":
            await self.cancel_active_response()

        elif event == "stop":
            # Sentence ended -> process user speech
            if len(self.audio_buffer) > 9600:  # > 300ms minimum speech
                pcm_data = bytes(self.audio_buffer)
                self.audio_buffer.clear()

                # Cancel previous generation if still lingering
                if self.active_response_task and not self.active_response_task.done():
                    self.active_response_task.cancel()

                # Launch async response task
                self.active_response_task = asyncio.create_task(self.pipeline_execute(pcm_data))

    async def pipeline_execute(self, pcm_bytes: bytes):
        """End-to-End: STT -> LLM -> TTS Streaming."""
        try:
            # 1. Open-Source STT (faster-whisper)
            user_text = await self.run_stt(pcm_bytes)
            if not user_text:
                return

            await self.send(json.dumps({"event": "transcript", "text": user_text}))

            # 2. Open-Source LLM (vLLM / Ollama / Llama-3.3)
            ai_text = await self.run_llm(user_text)

            # 3. Open-Source TTS (Kokoro-82M / Piper / Edge TTS)
            await self.run_tts_stream(ai_text)

        except asyncio.CancelledError:
            logger.info("Pipeline task cancelled cleanly mid-execution due to barge-in.")
            raise

    async def run_stt(self, pcm_bytes: bytes) -> str:
        """Call faster-whisper or local Whisper API."""
        # Wrap PCM into WAV container in-memory
        wav_io = io.BytesIO()
        with wave.open(wav_io, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(self.SAMPLE_RATE)
            wav.writeframes(pcm_bytes)
        wav_data = wav_io.getvalue()
        
        # Example using faster-whisper (or call your local STT endpoint)
        # segments, _ = whisper_model.transcribe(io.BytesIO(wav_data))
        # return "".join(s.text for s in segments).strip()
        return "User query string"

    async def run_llm(self, prompt: str) -> str:
        """Call vLLM or local Ollama."""
        # e.g., POST http://localhost:8000/v1/chat/completions
        return "Hello! How can I help you today?"

    async def run_tts_stream(self, text: str):
        """Generates natural audio frames and streams base64 to client."""
        self.is_bot_speaking = True
        self.bot_speech_start_time = asyncio.get_event_loop().time()
        
        # Stream audio chunks or complete synthesized audio to client
        # await self.send(json.dumps({"event": "audio_response", "payload": b64_audio}))
        self.is_bot_speaking = False
```

---

## 6. How to Deploy on Local / Cloud GPU (Docker Stack)

For zero-cost open-source deployment on an RTX 3060/4090 or Cloud GPU (RunPod/Lambda):

1. **STT Service:** Run `faster-whisper-server` on port `8000` (Docker container: `fedirz/faster-whisper-server`).
2. **LLM Brain:** Run `vLLM` hosting `meta-llama/Llama-3.3-70B-Instruct` (with 4-bit AWQ) on port `8001`.
3. **TTS Service:** Run `kokoro-fastapi` on port `8002` (generates human-grade speech in <150ms).
4. **WebSocket Gateway:** Run the Python script above on port `8080`.

---

## 7. Key Production Gotchas & Checklist

- [x] **Never use hard-coded low RMS (like 0.02) during playback:** Laptop speaker acoustic feedback will immediately cancel the bot. Always elevate threshold to `0.075` during playback.
- [x] **Debounce Interruption:** Require at least 2 consecutive frames (~400-500ms) of human speech before firing cancel. This filters keyboard clicks, throat-clearing, and speaker bleed transients.
- [x] **AsyncIO Task Cancellation:** Always save running tasks in `self.active_response_task = asyncio.create_task(...)` and catch `asyncio.CancelledError` cleanly.
- [x] **Flush Signal:** When barge-in fires, send `{"event": "clear_buffer"}` to tell the client audio player to immediately stop speaker playback (`audio.pause(); audio.currentTime = 0;`).
