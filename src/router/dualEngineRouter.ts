import { IEngine, CompletionResult, StreamChunk } from './IEngine';

export class DualEngineRouter implements IEngine {
    public name = 'DualEngineRouter';

    constructor(
        private mainExecutor: IEngine,
        private supportScout: IEngine | null,
        private advancedModeEnabled: boolean
    ) {}

    public async complete(prompt: string): Promise<CompletionResult> {
        return this.mainExecutor.complete(prompt);
    }

    public async completeStream(prompt: string, onChunk: (chunk: StreamChunk) => void): Promise<CompletionResult> {
        if (this.mainExecutor.completeStream) {
            return this.mainExecutor.completeStream(prompt, onChunk);
        }
        return this.mainExecutor.complete(prompt);
    }

    public async completeWithHistory(
        systemInstruction: string,
        history: Array<{ role: 'user' | 'model'; text: string }>,
        userMessage: string,
        stream?: boolean,
        onChunk?: (chunk: StreamChunk) => void,
        signal?: AbortSignal,
        tools?: any[],
        onToolCall?: (functionCall: any) => Promise<any>
    ): Promise<CompletionResult> {
        if (!this.advancedModeEnabled || !this.supportScout || !this.supportScout.completeWithHistory) {
            // Normal mode, or support scout invalid: Route directly to Main Executor
            if (this.mainExecutor.completeWithHistory) {
                return this.mainExecutor.completeWithHistory(systemInstruction, history, userMessage, stream, onChunk, signal, tools, onToolCall);
            }
            throw new Error('Main executor does not support chat history');
        }

        // --- ADVANCED MODE (Dual Engine) ---
        // 1. Send the request to the Scout to pick context and run tools.
        if (onChunk) onChunk({ text: '\n\n*(🕵️ Scout is analyzing context...)*\n\n', done: false });
        
        let scoutContext = '';
        
        // Filter out destructive tools for the scout. Only let it use read/search tools.
        const scoutTools = tools ? [{
            functionDeclarations: tools[0].functionDeclarations.filter((f: any) => 
                f.name === 'read_multiple_files' || f.name === 'search_codebase' || f.name === 'find_references'
            )
        }] : undefined;

        // Intercept tool calls for the scout
        const scoutOnToolCall = async (functionCall: any) => {
            if (onToolCall) {
                const result = await onToolCall(functionCall);
                // Save FULL result for the Main Executor
                scoutContext += `\n[Context from ${functionCall.name}]:\n${result}\n`;
                
                // Return TRUNCATED result to the Scout to protect its context limit
                if (typeof result === 'string' && result.length > 8000) {
                    return result.substring(0, 8000) + "\n... (Content truncated to save your context window. The Main Executor has received the full file).";
                }
                return result;
            }
            return "No tool call handler";
        };

        const scoutPrompt = `User Request: ${userMessage}\n\nTask: Determine which files or context are needed to answer the request.
CRITICAL: You MUST use the 'read_multiple_files' tool to read ['ARCHITECTURE.md'] first. This will give you the map of the project.
Then, use your tools (like 'search_codebase' or reading specific files) to fetch the exact code needed.
If you don't need any tools, or after you have gathered enough context, reply with a short summary of what you found.`;

        try {
            await this.supportScout.completeWithHistory(
                "You are a scout agent. Your ONLY job is to use your tools to find relevant code and architecture files for the user's request. DO NOT write code. DO NOT solve the problem. Use tools until you have enough context.",
                history.slice(-2), // Give minimal history to save tokens
                scoutPrompt,
                false, // no stream for scout, we just want it to finish in background
                undefined,
                signal,
                scoutTools,
                scoutOnToolCall
            );
        } catch (e: any) {
            if (onChunk) onChunk({ text: `\n\n*(⚠️ Scout encountered an error: ${e.message}. Falling back...)*\n\n`, done: false });
        }

        if (onChunk) onChunk({ text: `*(✅ Scout gathered context. Handing over to Main Executor...)*\n\n`, done: false });

        // 2. Append scout context to user message
        let finalMessage = userMessage;
        if (scoutContext.trim().length > 0) {
            finalMessage = `<scout_context>\n${scoutContext}\n</scout_context>\n\nUser Request: ${userMessage}`;
        }

        // 3. Send final enriched prompt to Main Executor
        if (this.mainExecutor.completeWithHistory) {
            return this.mainExecutor.completeWithHistory(
                systemInstruction,
                history,
                finalMessage,
                stream,
                onChunk,
                signal,
                tools, // Main Executor gets ALL tools (including write tools)
                onToolCall
            );
        }

        throw new Error('Main executor does not support chat history');
    }
}
