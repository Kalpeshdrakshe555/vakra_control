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
    private readonly ragEngine?: any;

    constructor(stateMachine: StateMachine, router: EngineRouter, ragEngine?: any) {
        this.stateMachine = stateMachine;
        this.router = router;
        this.ragEngine = ragEngine;
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
        let payload: string | null = `Please analyze and refactor the following code to improve performance, readability, and maintainability.
Return the complete file with your improvements using the <<<<<<< SEARCH and >>>>>>> REPLACE block format.
Make sure to explain your changes briefly before the code blocks.

--- File Content ---
${fileBuffer}`;

        // Fetch external RAG context if enabled
        if (ragEnabled && this.ragEngine) {
            console.log('RAG Engine active: fetching relevant semantic context...');
            try {
                const ragResults = await this.ragEngine.search(fileBuffer.substring(0, 500), 3);
                if (ragResults && ragResults.length > 0) {
                    payload += `\n\n--- Relevant Codebase Context ---\n${ragResults.map((r: any) => `File: ${r.filepath}\n\`\`\`\n${r.content}\n\`\`\``).join('\n\n')}`;
                }
            } catch (err) {
                console.warn('RAG Engine search failed during sequential processing', err);
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

    private isCancelled: boolean = false;

    /**
     * Executes a Multi-Agent Architect Blueprint sequentially to prevent RPM limits and PC freezing.
     */
    public async runArchitectQueue(
        workspaceRoot: string,
        blueprint: { tasks: { file: string, description: string, injected_knowledge?: string }[] },
        onProgress?: (file: string, status: string) => void
    ): Promise<void> {
        this.isCancelled = false;
        if (!blueprint || !blueprint.tasks || blueprint.tasks.length === 0) return;
        
        let accumulatedProjectContext = '';
        
        for (let i = 0; i < blueprint.tasks.length; i++) {
            if (this.isCancelled) {
                if (onProgress) onProgress('Stopped', '🛑 Queue Cancelled by User.');
                break;
            }
            
            const task = blueprint.tasks[i];
            
            if (onProgress) {
                onProgress(task.file, `Spawning Coder Agent for ${task.file}...`);
            }

            const targetFile = path.isAbsolute(task.file)
                ? task.file
                : path.join(workspaceRoot, task.file);

            let existingContent = '';
            if (fs.existsSync(targetFile)) {
                existingContent = fs.readFileSync(targetFile, 'utf8');
            } else {
                // Create directory if not exists
                const dir = path.dirname(targetFile);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(targetFile, '', 'utf8');
            }

            let systemInstruction = `You are an expert Coder Agent in a multi-agent system.
Your ONLY job is to output code. DO NOT provide conversational text, greetings, explanations, or formatting outside of the requested code block.
Your output MUST be exclusively a valid markdown code block.`;

            let payload = `FILE: ${task.file}
TASK: ${task.description}

${task.injected_knowledge ? `--- ARCHITECT SHARED KNOWLEDGE ---\n${task.injected_knowledge}\n--------------------------------\n` : ''}`;

            if (accumulatedProjectContext) {
                payload += `\n--- PREVIOUSLY GENERATED FILES IN THIS SESSION ---\nUse these to ensure imports, variables, and structure match exactly!\n${accumulatedProjectContext}\n--------------------------------------------------\n`;
            }

            if (existingContent.trim()) {
                payload += `
The file already has content. You MUST use standard <<<<<<< SEARCH and >>>>>>> REPLACE blocks to modify it.

--- CURRENT FILE CONTENT ---
${existingContent}`;
            } else {
                payload += `
The file is currently completely EMPTY. 
You MUST output the FULL complete file content inside a single markdown code block. 
DO NOT use Search and Replace blocks. DO NOT provide explanations. JUST the code block.`;
            }

            try {
                let llmResponse = await this.router.executeWithSystemInstruction(systemInstruction, payload);
                applyDiff(targetFile, llmResponse.text);

                // Add newly generated file to the shared context for the next agents
                if (fs.existsSync(targetFile)) {
                    let finalContent = fs.readFileSync(targetFile, 'utf8');
                    // Truncate if too long to prevent context window explosion
                    if (finalContent.length > 3000) {
                        finalContent = finalContent.substring(0, 3000) + '\n...[truncated]';
                    }
                    accumulatedProjectContext += `\nFile: ${task.file}\n\`\`\`\n${finalContent}\n\`\`\`\n`;
                }

                if (onProgress) {
                    onProgress(task.file, `✔️ Coder Agent finished ${task.file}`);
                }
                
                // Smart Delay to avoid hitting 15 RPM (Gemini) or freezing Ollama
                if (i < blueprint.tasks.length - 1) {
                    if (onProgress) onProgress(task.file, `⏳ Cooldown... (Avoiding Rate Limits)`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            } catch (err: any) {
                if (onProgress) {
                    onProgress(task.file, `❌ Error on ${task.file}: ${err.message}`);
                }
            }
        }
        
        if (onProgress && !this.isCancelled) {
            onProgress('Done', `🚀 All Agents Finished Executing the Blueprint!`);
        }
    }

    public cancelQueue(): void {
        this.isCancelled = true;
    }
}
