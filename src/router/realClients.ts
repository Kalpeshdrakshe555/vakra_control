import { IEngine, CompletionResult, StreamChunk } from './IEngine';

export class GeminiCloudClient implements IEngine {
    public readonly name = 'Cloud-Gemini';
    private currentKeyIndex = 0;
    private keys: string[];
    private model: string;
    private timeoutMs: number;
    private maxTokens: number;

    constructor(keys: string[], model: string, timeoutMs: number = 30000, maxTokens: number = 8000) {
        this.keys = keys || [];
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
        if (!this.keys || this.keys.length === 0) {
            throw new Error('Gemini API Key is missing. Please click the ⚙️ Gear icon in the chat panel to open Agent Configuration and add your API key.');
        }
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
                    
                    if (status === 429 || status === 403 || status === 400 || status >= 500) {
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
        if (!this.keys || this.keys.length === 0) {
            throw new Error('Gemini API Key is missing. Please click the ⚙️ Gear icon in the chat panel to open Agent Configuration and add your API key.');
        }
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
                    
                    if (status === 429 || status === 403 || status === 400 || status >= 500) {
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
        signal?: AbortSignal,
        tools?: any[],
        onToolCall?: (functionCall: any) => Promise<any>
    ): Promise<CompletionResult> {
        if (!this.keys || this.keys.length === 0) {
            throw new Error('Gemini API Key is missing. Please click the ⚙️ Gear icon in the chat panel to open Agent Configuration and add your API key.');
        }
        this.resetKeyRotation();

        const contents = [
            ...history.map(h => ({
                role: h.role,
                parts: [{ text: h.text }]
            })),
            { role: 'user', parts: [{ text: userMessage }] }
        ];

        let finalUsage: CompletionResult['usage'] | undefined;
        let fullText = '';
        let iteration = 0;

        while (iteration < 15) { // Max 15 tool calls per turn to prevent infinite loops
            iteration++;
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

            if (tools && tools.length > 0) {
                requestBody.tools = tools;
            }

            let functionCallToExecute: any = null;
            let successWithoutTool = false;

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
                if (signal) { signal.addEventListener('abort', abortHandler); }

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
                        if (status === 429 || status === 403 || status === 400 || status >= 500) {
                            this.currentKeyIndex++;
                            continue;
                        }
                        throw new Error(`Gemini API error (Status ${status}): ${errText}`);
                    }

                    if (stream && onChunk) {
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
                                        const funcCall = data?.candidates?.[0]?.content?.parts?.[0]?.functionCall;
                                        
                                        if (funcCall) {
                                            functionCallToExecute = funcCall;
                                        }

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
                            if (functionCallToExecute) break;
                        }
                    } else {
                        const data = (await response.json()) as any;
                        const funcCall = data?.candidates?.[0]?.content?.parts?.[0]?.functionCall;
                        if (funcCall) {
                            functionCallToExecute = funcCall;
                        } else {
                            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (text) { fullText += text; }
                        }
                        
                        if (data?.usageMetadata) {
                            finalUsage = {
                                promptTokens: data.usageMetadata.promptTokenCount || 0,
                                completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                                totalTokens: data.usageMetadata.totalTokenCount || 0
                            };
                        }
                    }

                    successWithoutTool = !functionCallToExecute;
                    break; // break the keys loop, we got a successful response (either tool or text)
                } catch (error: any) {
                    if (error.name === 'AbortError') {
                        if (signal?.aborted) throw new Error('Generation stopped by user.');
                        throw new Error(`Gemini API call timed out after ${this.timeoutMs / 1000} seconds.`);
                    }
                    throw error;
                } finally {
                    clearTimeout(timeoutId);
                    if (signal) signal.removeEventListener('abort', abortHandler);
                }
            } // end keys loop

            if (this.currentKeyIndex >= this.keys.length && !successWithoutTool && !functionCallToExecute) {
                throw new Error("All provided API keys have been exhausted or rate-limited.");
            }

            if (functionCallToExecute && onToolCall) {
                // Execute the tool locally
                if (onChunk) onChunk({ text: `\n> *⚙️ AI is using tool: \`${functionCallToExecute.name}\`*\n`, done: false });
                
                let toolResult;
                try {
                    toolResult = await onToolCall(functionCallToExecute);
                } catch (err: any) {
                    toolResult = `Error executing tool: ${err?.message}`;
                }

                // Add to contents for next API call
                contents.push({
                    role: 'model',
                    parts: [{ functionCall: functionCallToExecute }]
                });
                contents.push({
                    role: 'function',
                    parts: [{
                        functionResponse: {
                            name: functionCallToExecute.name,
                            response: { result: toolResult }
                        }
                    }]
                });
                continue; // Loop back and make the next API call
            }

            // Done generating!
            if (onChunk) onChunk({ text: '', done: true, usage: finalUsage });
            return { text: fullText, usage: finalUsage };
        } // end tool loop
        
        throw new Error("Exceeded maximum tool call iterations.");
    }
}

/**
 * Client for local models compatible with Ollama/OpenAI API.
 */
export class LocalOllamaClient implements IEngine {
    public readonly name = 'Local-Model';

    constructor(private model: string = 'llama3', private endpoint: string = 'http://127.0.0.1:11434', private apiKey?: string) {}

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
        signal?: AbortSignal,
        tools?: any[],
        onToolCall?: (functionCall: any) => Promise<any>
    ): Promise<CompletionResult> {
        let messages: any[] = [];
        if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
        
        history.forEach(h => {
            messages.push({ role: h.role === 'model' ? 'assistant' : 'user', content: h.text });
        });
        messages.push({ role: 'user', content: userMessage });

        const isOllama = this.endpoint.includes('11434');
        const url = isOllama ? `${this.endpoint}/api/chat` : `${this.endpoint}/v1/chat/completions`;

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        // Convert Gemini-format tools to OpenAI-format tools for Groq/OpenAI
        let openAITools: any[] | undefined;
        if (tools && tools[0]?.functionDeclarations && !isOllama) {
            openAITools = tools[0].functionDeclarations.map((f: any) => ({
                type: 'function',
                function: {
                    name: f.name,
                    description: f.description || '',
                    parameters: f.parameters || { type: 'object', properties: {} }
                }
            }));
        }

        const MAX_TOOL_ITERATIONS = 10;
        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
            const requestBody: any = {
                model: this.model,
                messages: messages,
                stream: (iteration === 0 || !onToolCall) ? stream : false // Only stream the final response
            };

            // Only add tools on non-streaming or tool-loop iterations
            if (openAITools && openAITools.length > 0) {
                requestBody.tools = openAITools;
                requestBody.tool_choice = 'auto';
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestBody),
                signal
            });

            if (!response.ok) {
                throw new Error(`Local model failed: ${response.status} ${await response.text()}`);
            }

            // --- STREAMING PATH (only for the final text response) ---
            if (requestBody.stream && onChunk) {
                let fullText = '';
                let toolCallsAccumulator: any[] = [];
                const body = response.body;
                if (!body) throw new Error('Response body is null');
                
                const reader = body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    
                    for (const line of lines) {
                        if (line.trim() === '') continue;
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
                                    if (dataStr.trim() === '[DONE]') continue;
                                    const data = JSON.parse(dataStr);
                                    const delta = data.choices?.[0]?.delta;
                                    
                                    // Handle streamed tool calls
                                    if (delta?.tool_calls) {
                                        for (const tc of delta.tool_calls) {
                                            if (tc.index !== undefined) {
                                                if (!toolCallsAccumulator[tc.index]) {
                                                    toolCallsAccumulator[tc.index] = { id: tc.id || '', name: '', arguments: '' };
                                                }
                                                if (tc.function?.name) toolCallsAccumulator[tc.index].name = tc.function.name;
                                                if (tc.function?.arguments) toolCallsAccumulator[tc.index].arguments += tc.function.arguments;
                                            }
                                        }
                                    }
                                    
                                    const content = delta?.content || '';
                                    if (content) {
                                        fullText += content;
                                        onChunk({ text: content, done: false });
                                    }
                                }
                            }
                        } catch (e) { 
                            console.error("Local stream parse error", e, "Line:", line);
                        }
                    }
                }
                // Parse remaining buffer
                if (buffer.trim() !== '') {
                    try {
                        if (isOllama) {
                            const data = JSON.parse(buffer);
                            if (data.message?.content) {
                                fullText += data.message.content;
                                onChunk({ text: data.message.content, done: false });
                            }
                        }
                    } catch (e) { console.error("Local stream buffer parse error", e); }
                }

                // If tool calls were streamed, handle them
                if (toolCallsAccumulator.length > 0 && onToolCall) {
                    messages.push({ role: 'assistant', content: null, tool_calls: toolCallsAccumulator.map((tc, i) => ({ id: tc.id || `call_${i}`, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) });
                    for (const tc of toolCallsAccumulator) {
                        try {
                            const args = JSON.parse(tc.arguments);
                            const result = await onToolCall({ name: tc.name, args });
                            messages.push({ role: 'tool', tool_call_id: tc.id || `call_${toolCallsAccumulator.indexOf(tc)}`, content: typeof result === 'string' ? result : JSON.stringify(result) });
                        } catch (e: any) {
                            messages.push({ role: 'tool', tool_call_id: tc.id || `call_${toolCallsAccumulator.indexOf(tc)}`, content: `Error: ${e.message}` });
                        }
                    }
                    continue; // Loop back for next API call
                }
                
                onChunk({ text: '', done: true });
                return { text: fullText };

            } else {
                // --- NON-STREAMING PATH ---
                let fullText = '';
                const rawText = await response.text();
                
                try {
                    if (isOllama) {
                        const lines = rawText.split('\n').filter(l => l.trim() !== '');
                        for (const line of lines) {
                            const data = JSON.parse(line);
                            fullText += data.message?.content || '';
                        }
                    } else {
                        const data = JSON.parse(rawText);
                        const choice = data.choices?.[0];
                        
                        // Check if the model wants to call tools
                        if (choice?.finish_reason === 'tool_calls' || choice?.message?.tool_calls) {
                            const toolCalls = choice.message.tool_calls;
                            if (toolCalls && toolCalls.length > 0 && onToolCall) {
                                // Add the assistant's tool call message to history
                                messages.push(choice.message);
                                
                                // Execute each tool call
                                for (const tc of toolCalls) {
                                    try {
                                        const args = JSON.parse(tc.function.arguments);
                                        if (onChunk) onChunk({ text: `\n> *⚙️ Tool: \`${tc.function.name}\`*\n`, done: false });
                                        const result = await onToolCall({ name: tc.function.name, args });
                                        messages.push({
                                            role: 'tool',
                                            tool_call_id: tc.id,
                                            content: typeof result === 'string' ? result : JSON.stringify(result)
                                        });
                                    } catch (e: any) {
                                        messages.push({
                                            role: 'tool',
                                            tool_call_id: tc.id,
                                            content: `Error executing tool: ${e.message}`
                                        });
                                    }
                                }
                                continue; // Loop back for next API call with tool results
                            }
                        }
                        
                        fullText = choice?.message?.content || '';
                    }
                } catch (e) {
                    fullText = rawText;
                }
                
                if (stream && onChunk) {
                    onChunk({ text: fullText, done: false });
                    onChunk({ text: '', done: true });
                }
                return { text: fullText };
            }
        }

        throw new Error('Exceeded maximum tool call iterations.');
    }
}
