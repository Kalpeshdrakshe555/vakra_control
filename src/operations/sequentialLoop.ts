import * as fs from 'fs';
import * as path from 'path';
import { StateMachine } from '../state/stateMachine';
import { EngineRouter } from '../router/engineRouter';
import { applyDiff } from './diffPatcher';
import { fetchWebContext } from '../tools/scraper';
import { CompletionResult } from '../router/IEngine';

export class SequentialOperator {
    private readonly stateMachine: StateMachine;
    private readonly router: EngineRouter;

    constructor(stateMachine: StateMachine, router: EngineRouter) {
        this.stateMachine = stateMachine;
        this.router = router;
    }

    /**
     * Entry point to run the file queue sequentially.
     */
    public async runQueue(
        workspaceRoot: string, 
        ragEnabled?: boolean,
        onProgress?: (file: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }) => void
    ): Promise<void> {
        const state = this.stateMachine.readState();

        // Prevent concurrent queue processing runs
        if (state.status === 'PROCESSING') {
            console.warn('Queue processing is already active.');
            return;
        }

        // Return early if no files exist or queue already completed
        if (!state.fileQueue || state.fileQueue.length === 0 || state.currentFileIndex >= state.fileQueue.length) {
            console.log('File queue is empty or already processed.');
            return;
        }

        // Update status to PROCESSING and persist
        state.status = 'PROCESSING';
        this.stateMachine.writeState(state);

        try {
            await this.processNext(workspaceRoot, ragEnabled, onProgress);
        } catch (error) {
            // Re-read current state, transition to ERROR, and write back
            const errState = this.stateMachine.readState();
            errState.status = 'ERROR';
            this.stateMachine.writeState(errState);
            throw error;
        }
    }

    /**
     * Core sequential processing step executed recursively.
     */
    private async processNext(
        workspaceRoot: string, 
        ragEnabled?: boolean,
        onProgress?: (file: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }) => void
    ): Promise<void> {
        const state = this.stateMachine.readState();

        if (state.currentFileIndex >= state.fileQueue.length) {
            state.status = 'IDLE';
            this.stateMachine.writeState(state);
            return;
        }

        // 1. Scope Isolation: Resolve current file path
        const relativeOrAbsolutePath = state.fileQueue[state.currentFileIndex];
        const targetFile = path.isAbsolute(relativeOrAbsolutePath)
            ? relativeOrAbsolutePath
            : path.join(workspaceRoot, relativeOrAbsolutePath);

        // 2. Payload Construction
        let fileBuffer: string | null = fs.readFileSync(targetFile, 'utf8');
        let payload: string | null = "Refactor this:\n" + fileBuffer;

        // Fetch external RAG context if enabled
        if (ragEnabled) {
            console.log('RAG Scraper active: fetching Python tutorial context...');
            const webContext = await fetchWebContext('https://docs.python.org/3/tutorial/index.html');
            if (webContext) {
                payload += `\n\nAdditional Python Docs Context:\n${webContext}`;
            }
        }

        // 3. LLM Execution
        let llmResponse: CompletionResult | null = await this.router.execute(payload);

        // 4. Patch Execution
        applyDiff(targetFile, llmResponse.text);

        if (onProgress) {
            onProgress(targetFile, llmResponse.usage);
        }

        // 5. EXPLICIT MEMORY FLUSH: Reassign references to null
        // Highly critical for the V8 engine to reclaim large buffer strings from memory 
        // immediately as we do not have direct access to run --expose-gc in VS Code.
        fileBuffer = null;
        payload = null;
        const usage = llmResponse.usage;
        llmResponse = null;

        // 6. State Update: Increment index
        state.currentFileIndex++;
        this.stateMachine.writeState(state);

        // 7. Loop / Cooldown Gate
        if (state.currentFileIndex < state.fileQueue.length) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            await this.processNext(workspaceRoot, ragEnabled, onProgress);
        } else {
            // 8. Completion: If done, set status to IDLE
            state.status = 'IDLE';
            this.stateMachine.writeState(state);
        }
    }
}
