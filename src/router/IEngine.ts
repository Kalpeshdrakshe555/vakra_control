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
    /** Optional streaming support — engines that support it should implement this */
    completeStream?(prompt: string, onChunk: (chunk: StreamChunk) => void): Promise<CompletionResult>;
}
