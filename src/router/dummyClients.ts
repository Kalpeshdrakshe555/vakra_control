import { IEngine, CompletionResult } from './IEngine';

export class CloudClient implements IEngine {
    public readonly name = 'Cloud-Gemini-Dummy';

    public async complete(prompt: string): Promise<CompletionResult> {
        return new Promise<CompletionResult>((resolve) => {
            setTimeout(() => {
                resolve({
                    text: '// Cloud Dummy Patch Applied',
                    usage: {
                        promptTokens: 15,
                        completionTokens: 8,
                        totalTokens: 23
                    }
                });
            }, 1000);
        });
    }
}

export class LocalClient implements IEngine {
    public readonly name = 'Local-Gemma-Dummy';

    public async complete(prompt: string): Promise<CompletionResult> {
        // Throw an error to simulate model failure and test fallback cascade
        throw new Error('Local Model Failed');
    }
}
