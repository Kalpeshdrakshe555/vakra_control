export interface CompletionResult {
    text: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

export interface StreamChunk {
    text: string;
    done: boolean;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

export interface IEngine {
    name: string;
    complete(prompt: string): Promise<CompletionResult>;
    /** Optional streaming support */
    completeStream?(prompt: string, onChunk: (chunk: StreamChunk) => void): Promise<CompletionResult>;
    /** Full chat support with history and optional function calling */
    completeWithHistory?(
        systemInstruction: string,
        history: Array<{ role: 'user' | 'model'; text: string }>,
        userMessage: string,
        stream?: boolean,
        onChunk?: (chunk: StreamChunk) => void,
        signal?: AbortSignal,
        tools?: any[],
        onToolCall?: (functionCall: any) => Promise<any>
    ): Promise<CompletionResult>;
}
