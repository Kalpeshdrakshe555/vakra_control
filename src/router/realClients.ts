import { IEngine, CompletionResult, StreamChunk } from './IEngine';

export class GeminiCloudClient implements IEngine {
    public readonly name = 'Cloud-Gemini';
    private currentKeyIndex = 0;
    private keys: string[];
    private model: string;
    private timeoutMs: number;
    private maxTokens: number;

    constructor(keys: string[], model: string, timeoutMs: number = 30000, maxTokens: number = 8000) {
        if (!keys || keys.length === 0) {
            throw new Error('Gemini API Key is missing. Please click the ⚙️ Gear icon in the chat panel to open Agent Configuration and add your API key.');
        }
        this.keys = keys;
        this.model = model;
        this.timeoutMs = timeoutMs;
        this.maxTokens = maxTokens;
    }

    /**
     * Resets key rotation index — call when starting a new conversation turn.
     */
    public resetKeyRotation(): void {
        this.currentKeyIndex = 0;
    }

    /**
     * Executes content completion using Google's Gemini API (non-streaming).
     * Enforces a configurable timeout logic, trying keys sequentially in case of 429, 403, or 400.
     */
    public async complete(prompt: string): Promise<CompletionResult> {
        this.resetKeyRotation();
        while (this.currentKeyIndex < this.keys.length) {
            const apiKey = this.keys[this.currentKeyIndex].trim();
            if (!apiKey) {
                this.currentKeyIndex++;
                continue;
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contents: [
                            {
                                parts: [
                                    {
                                        text: prompt
                                    }
                                ]
                            }
                        ]
                    }),
                    signal: controller.signal
                });

                if (!response.ok) {
                    const status = response.status;
                    const errText = await response.text();
                    
                    if (status === 429 || status === 403 || status === 400) {
                        console.warn(`Gemini API key index ${this.currentKeyIndex} failed with status ${status}. Trying next key. Error: ${errText}`);
                        this.currentKeyIndex++;
                        continue;
                    }
                    
                    throw new Error(`Gemini API error (Status ${status}): ${errText}`);
                }

                const data = (await response.json()) as any;
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

                if (typeof text !== 'string') {
                    throw new Error('Invalid or empty response format from Gemini API.');
                }

                const usage = data?.usageMetadata ? {
                    promptTokens: data.usageMetadata.promptTokenCount || 0,
                    completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                    totalTokens: data.usageMetadata.totalTokenCount || 0
                } : undefined;

                return { text, usage };
            } catch (error: any) {
                if (error.name === 'AbortError') {
                    throw new Error(`Gemini API call timed out after ${this.timeoutMs / 1000} seconds.`);
                }
                throw error;
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw new Error("All provided API keys have been exhausted or rate-limited.");
    }

    /**
     * Streaming content completion — delivers tokens incrementally via onChunk callback.
     * Uses Gemini's streamGenerateContent endpoint with SSE.
     */
    public async completeStream(prompt: string, onChunk: (chunk: StreamChunk) => void): Promise<CompletionResult> {
        this.resetKeyRotation();
        while (this.currentKeyIndex < this.keys.length) {
            const apiKey = this.keys[this.currentKeyIndex].trim();
            if (!apiKey) {
                this.currentKeyIndex++;
                continue;
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${apiKey}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contents: [
                            {
                                parts: [
                                    {
                                        text: prompt
                                    }
                                ]
                            }
                        ]
                    }),
                    signal: controller.signal
                });

                if (!response.ok) {
                    const status = response.status;
                    const errText = await response.text();
                    
                    if (status === 429 || status === 403 || status === 400) {
                        console.warn(`Gemini Streaming: key index ${this.currentKeyIndex} failed with status ${status}. Trying next key.`);
                        this.currentKeyIndex++;
                        continue;
                    }
                    
                    throw new Error(`Gemini Streaming API error (Status ${status}): ${errText}`);
                }

                // Process SSE stream
                let fullText = '';
                let finalUsage: CompletionResult['usage'] | undefined;

                const body = response.body;
                if (!body) {
                    throw new Error('Gemini streaming response body is null.');
                }

                const reader = body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) { break; }

                    buffer += decoder.decode(value, { stream: true });
                    
                    // Parse SSE events from buffer
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const jsonStr = line.slice(6).trim();
                            if (!jsonStr || jsonStr === '[DONE]') { continue; }

                            try {
                                const data = JSON.parse(jsonStr);
                                const chunkText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                                
                                if (chunkText) {
                                    fullText += chunkText;
                                    onChunk({ text: chunkText, done: false });
                                }

                                // Capture usage from the final chunk
                                if (data?.usageMetadata) {
                                    finalUsage = {
                                        promptTokens: data.usageMetadata.promptTokenCount || 0,
                                        completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                                        totalTokens: data.usageMetadata.totalTokenCount || 0
                                    };
                                }
                            } catch {
                                // Skip malformed JSON chunks
                            }
                        }
                    }
                }

                // Signal completion
                onChunk({ text: '', done: true, usage: finalUsage });
                return { text: fullText, usage: finalUsage };

            } catch (error: any) {
                if (error.name === 'AbortError') {
                    throw new Error(`Gemini streaming call timed out after ${this.timeoutMs / 1000} seconds.`);
                }
                throw error;
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw new Error("All provided API keys have been exhausted or rate-limited.");
    }

    /**
     * Constructs the full multi-turn Gemini API payload with system instruction and history.
     */
    public async completeWithHistory(
        systemInstruction: string,
        history: Array<{ role: 'user' | 'model'; text: string }>,
        userMessage: string,
        stream: boolean = false,
        onChunk?: (chunk: StreamChunk) => void,
        signal?: AbortSignal
    ): Promise<CompletionResult> {
        this.resetKeyRotation();

        const contents = [
            ...history.map(h => ({
                role: h.role,
                parts: [{ text: h.text }]
            })),
            { role: 'user', parts: [{ text: userMessage }] }
        ];

        const requestBody: any = {
            contents,
            systemInstruction: {
                parts: [{ text: systemInstruction }]
            },
            generationConfig: {
                temperature: 0.7,
                topP: 0.95,
                topK: 40,
                maxOutputTokens: this.maxTokens
            }
        };

        while (this.currentKeyIndex < this.keys.length) {
            const apiKey = this.keys[this.currentKeyIndex].trim();
            if (!apiKey) {
                this.currentKeyIndex++;
                continue;
            }

            const endpoint = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:${endpoint}${stream ? '&' : '?'}key=${apiKey}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
            
            const abortHandler = () => controller.abort();
            if (signal) {
                signal.addEventListener('abort', abortHandler);
            }

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });

                if (!response.ok) {
                    const status = response.status;
                    const errText = await response.text();
                    if (status === 429 || status === 403 || status === 400) {
                        this.currentKeyIndex++;
                        continue;
                    }
                    throw new Error(`Gemini API error (Status ${status}): ${errText}`);
                }

                if (stream && onChunk) {
                    let fullText = '';
                    let finalUsage: CompletionResult['usage'] | undefined;
                    const body = response.body;
                    if (!body) { throw new Error('Response body is null.'); }

                    const reader = body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) { break; }
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const jsonStr = line.slice(6).trim();
                                if (!jsonStr || jsonStr === '[DONE]') { continue; }
                                try {
                                    const data = JSON.parse(jsonStr);
                                    const chunkText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                                    if (chunkText) {
                                        fullText += chunkText;
                                        onChunk({ text: chunkText, done: false });
                                    }
                                    if (data?.usageMetadata) {
                                        finalUsage = {
                                            promptTokens: data.usageMetadata.promptTokenCount || 0,
                                            completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                                            totalTokens: data.usageMetadata.totalTokenCount || 0
                                        };
                                    }
                                } catch { /* skip malformed */ }
                            }
                        }
                    }
                    onChunk({ text: '', done: true, usage: finalUsage });
                    return { text: fullText, usage: finalUsage };
                } else {
                    const data = (await response.json()) as any;
                    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (typeof text !== 'string') {
                        throw new Error('Invalid or empty response from Gemini API.');
                    }
                    const usage = data?.usageMetadata ? {
                        promptTokens: data.usageMetadata.promptTokenCount || 0,
                        completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                        totalTokens: data.usageMetadata.totalTokenCount || 0
                    } : undefined;
                    return { text, usage };
                }
            } catch (error: any) {
                if (error.name === 'AbortError') {
                    if (signal?.aborted) {
                        throw new Error('Generation stopped by user.');
                    }
                    throw new Error(`Gemini API call timed out after ${this.timeoutMs / 1000} seconds.`);
                }
                throw error;
            } finally {
                clearTimeout(timeoutId);
                if (signal) {
                    signal.removeEventListener('abort', abortHandler);
                }
            }
        }

        throw new Error("All provided API keys have been exhausted or rate-limited.");
    }
}

/**
 * Client for local models compatible with Ollama/OpenAI API.
 */
export class LocalOllamaClient implements IEngine {
    public readonly name = 'Local-Model';

    constructor(private model: string = 'llama3', private endpoint: string = 'http://127.0.0.1:11434') {}

    public async complete(prompt: string): Promise<CompletionResult> {
        return this.completeWithHistory('', [], prompt);
    }

    public async completeStream(prompt: string, onChunk: (chunk: StreamChunk) => void): Promise<CompletionResult> {
        return this.completeWithHistory('', [], prompt, true, onChunk);
    }

    public async completeWithHistory(
        systemInstruction: string,
        history: Array<{ role: 'user' | 'model'; text: string }>,
        userMessage: string,
        stream: boolean = false,
        onChunk?: (chunk: StreamChunk) => void,
        signal?: AbortSignal
    ): Promise<CompletionResult> {
        let messages = [];
        if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
        
        history.forEach(h => {
            messages.push({ role: h.role === 'model' ? 'assistant' : 'user', content: h.text });
        });
        messages.push({ role: 'user', content: userMessage });

        const isOllama = this.endpoint.includes('11434');
        const url = isOllama ? `${this.endpoint}/api/chat` : `${this.endpoint}/v1/chat/completions`;

        const requestBody = {
            model: this.model,
            messages: messages,
            stream: stream
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal
        });

        if (!response.ok) {
            throw new Error(`Local model failed: ${response.status} ${await response.text()}`);
        }

        if (stream && onChunk) {
            let fullText = '';
            const body = response.body;
            if (!body) throw new Error('Response body is null');
            
            const reader = body.getReader();
            const decoder = new TextDecoder();
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(l => l.trim() !== '');
                
                for (const line of lines) {
                    try {
                        if (isOllama) {
                            const data = JSON.parse(line);
                            if (data.message?.content) {
                                fullText += data.message.content;
                                onChunk({ text: data.message.content, done: false });
                            }
                        } else {
                            if (line.startsWith('data: ')) {
                                const dataStr = line.slice(6);
                                if (dataStr === '[DONE]') continue;
                                const data = JSON.parse(dataStr);
                                const content = data.choices?.[0]?.delta?.content || '';
                                if (content) {
                                    fullText += content;
                                    onChunk({ text: content, done: false });
                                }
                            }
                        }
                    } catch { /* skip */ }
                }
            }
            onChunk({ text: '', done: true });
            return { text: fullText };
        } else {
            let fullText = '';
            const rawText = await response.text();
            
            try {
                if (isOllama) {
                    // Ollama non-streaming returns JSON Lines unless stream: false is respected
                    const lines = rawText.split('\n').filter(l => l.trim() !== '');
                    for (const line of lines) {
                        const data = JSON.parse(line);
                        fullText += data.message?.content || '';
                    }
                } else {
                    const data = JSON.parse(rawText);
                    fullText = data.choices?.[0]?.message?.content || '';
                }
            } catch (e) {
                fullText = rawText;
            }
            return { text: fullText };
        }
    }
}
