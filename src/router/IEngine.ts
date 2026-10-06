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

export interface CompleteWithHistoryOptions {
    prompt: string;
    images?: any[];
    signal?: AbortSignal;
    history?: Array<{ role: 'user' | 'model'; text: string }>;
    systemInstruction?: string;
    stream?: boolean;
    onChunk?: (chunk: StreamChunk) => void;
    tools?: any[];
    onToolCall?: (functionCall: any) => Promise<any>;
}

export interface IEngine {
    name: string;
    complete(prompt: string): Promise<CompletionResult>;
    /** Optional streaming support */
    completeStream?(prompt: string, onChunk: (chunk: StreamChunk) => void): Promise<CompletionResult>;
    /** Full chat support with history, multimodal images, and optional function calling */
    completeWithHistory?(
        systemInstructionOrOptions: string | CompleteWithHistoryOptions,
        history?: Array<{ role: 'user' | 'model'; text: string }>,
        userMessage?: string,
        stream?: boolean,
        onChunk?: (chunk: StreamChunk) => void,
        signal?: AbortSignal,
        tools?: any[],
        onToolCall?: (functionCall: any) => Promise<any>,
        images?: any[]
    ): Promise<CompletionResult>;
}
