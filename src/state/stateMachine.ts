import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface AiState {
    currentFileIndex: number;
    fileQueue: string[];
    status: 'IDLE' | 'PROCESSING' | 'ERROR';
    activeEngine: string;
    circuitBreakers: Record<string, { tripsAt: number; cooldownMs: number }>;
}

export class StateMachine {
    private readonly stateFilePath: string;

    constructor(workspaceRoot?: string) {
        if (workspaceRoot) {
            this.stateFilePath = path.join(workspaceRoot, '.ai_state.json');
        } else {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                this.stateFilePath = path.join(workspaceFolders[0].uri.fsPath, '.ai_state.json');
            } else {
                // Fallback if no active workspace folder is open
                this.stateFilePath = path.join(process.cwd(), '.ai_state.json');
            }
        }
    }

    /**
     * Reads the AI state from the workspace configuration file synchronously.
     * Returns the default state if the file does not exist.
     */
    public readState(): AiState {
        try {
            if (fs.existsSync(this.stateFilePath)) {
                const data = fs.readFileSync(this.stateFilePath, 'utf8');
                return JSON.parse(data) as AiState;
            }
        } catch (error) {
            console.error('Error reading AI state file. Returning default state.', error);
        }
        return this.getDefaultState();
    }

    /**
     * Writes the AI state to the workspace configuration file synchronously
     * to prevent race conditions.
     */
    public writeState(state: AiState): void {
        try {
            const data = JSON.stringify(state, null, 2);
            fs.writeFileSync(this.stateFilePath, data, 'utf8');
        } catch (error) {
            console.error('Error writing AI state file.', error);
        }
    }

    /**
     * Generates a clean default AiState object.
     */
    private getDefaultState(): AiState {
        return {
            currentFileIndex: 0,
            fileQueue: [],
            status: 'IDLE',
            activeEngine: '',
            circuitBreakers: {}
        };
    }
}
