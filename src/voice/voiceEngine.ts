import * as fs from 'fs';
import * as path from 'path';
import { VoiceConfig } from '../config';

export const VOICE_CONSTANTS = {
    SAMPLE_RATE: 16000,
    VAD_RMS_IDLE_THRESHOLD: 0.015,
    VAD_RMS_INTERRUPT_THRESHOLD: 0.075,
    BARGE_IN_DEBOUNCE_FRAMES: 2,
    SILENCE_TRIGGER_MS: 850
} as const;

/**
 * Calculates RMS audio level of 16-bit PCM mono.
 * Matches Blueprint mathematical specification.
 */
export function computeRMS(pcmBytes: Buffer | Uint8Array): number {
    if (!pcmBytes || pcmBytes.length === 0) return 0;
    const sampleCount = Math.floor(pcmBytes.length / 2);
    if (sampleCount === 0) return 0;

    const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
    let sumSq = 0;
    for (let i = 0; i < sampleCount; i++) {
        const s = view.getInt16(i * 2, true) / 32768.0;
        sumSq += s * s;
    }
    return Math.sqrt(sumSq / sampleCount);
}

/**
 * Wraps raw 16kHz 16-bit Mono PCM bytes into a standard in-memory WAV container.
 */
export function pcmToWav(pcmBytes: Buffer | Uint8Array, sampleRate = VOICE_CONSTANTS.SAMPLE_RATE): Buffer {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataLength = pcmBytes.length;
    const buffer = Buffer.alloc(44 + dataLength);

    // RIFF chunk descriptor
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);

    // fmt sub-chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    buffer.writeUInt16LE(1, 20);  // AudioFormat (1 for PCM)
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);

    // data sub-chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);
    Buffer.from(pcmBytes).copy(buffer, 44);

    return buffer;
}

/**
 * Transcribes audio via OpenAI-compatible Whisper STT endpoint
 * (faster-whisper-server on :8000, Groq Whisper API, or local Whisper.cpp).
 */
export async function transcribeAudio(
    pcmOrWavBytes: Buffer | Uint8Array,
    voiceConfig?: VoiceConfig
): Promise<string> {
    const endpoint = (voiceConfig?.whisperEndpoint || 'http://127.0.0.1:8000/v1/audio/transcriptions').trim();
    const apiKey = voiceConfig?.whisperApiKey || '';

    // If input is raw PCM (no RIFF header), wrap to WAV
    let wavBuffer: Buffer;
    if (pcmOrWavBytes.length > 4 && pcmOrWavBytes[0] === 0x52 && pcmOrWavBytes[1] === 0x49 && pcmOrWavBytes[2] === 0x46 && pcmOrWavBytes[3] === 0x46) {
        wavBuffer = Buffer.from(pcmOrWavBytes);
    } else {
        wavBuffer = pcmToWav(pcmOrWavBytes);
    }

    const formData = new FormData();
    const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });
    formData.append('file', audioBlob, 'speech.wav');
    formData.append('model', 'whisper-large-v3');
    formData.append('response_format', 'json');

    const headers: Record<string, string> = {};
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: formData
    });

    if (!response.ok) {
        throw new Error(`Whisper STT request failed with status ${response.status}: ${await response.text()}`);
    }

    const json = await response.json() as any;
    return (json.text || json.transcript || '').trim();
}

/**
 * Synthesizes speech using external TTS server (e.g. Kokoro-82M on :8002 or Edge TTS)
 * and returns base64-encoded audio.
 */
export async function synthesizeSpeech(
    text: string,
    voiceConfig?: VoiceConfig
): Promise<string | null> {
    const endpoint = (voiceConfig?.ttsEndpoint || 'http://127.0.0.1:8002/v1/audio/speech').trim();
    if (!endpoint || voiceConfig?.ttsProvider === 'browser') {
        return null;
    }

    const requestBody = {
        model: 'kokoro-82M',
        input: text,
        voice: 'af_bella',
        response_format: 'mp3'
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        throw new Error(`TTS synthesis failed with status ${response.status}: ${await response.text()}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');
}
