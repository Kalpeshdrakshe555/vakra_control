import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { runCommandSequence, findProjectAnchorDir, cleanOutput } from '../platform';

export interface TerminalExecutionResult {
    output: string;
    exitCode: number;
    error: boolean;
}

export class TerminalCapture {
    private static _outputChannel: vscode.OutputChannel | null = null;
    private static get outputChannel(): vscode.OutputChannel {
        if (!this._outputChannel) {
            this._outputChannel = vscode.window.createOutputChannel('Ultra Light AI Terminal');
        }
        return this._outputChannel;
    }
    private static lastOutput: string = '';

    public static isDaemonCommand(command: string): boolean {
        return /\b(runserver|vite|npm\s+run\s+dev|npm\s+start|yarn\s+dev|yarn\s+start|pnpm\s+dev|watch|serve|flask\s+run)\b/i.test(command.trim());
    }

    public static async runAndCapture(command: string, workspaceRoot: string): Promise<TerminalExecutionResult> {
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`\n> ${command}`);
        
        const safeCwd = (workspaceRoot && workspaceRoot.trim().length > 0)
            ? workspaceRoot
            : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd());

        let effectiveCwd = safeCwd;

        // Smart CWD resolution for manage.py or node projects using anchor search
        if (/\b(?:python|py|python3)\s+manage\.py\b/i.test(command)) {
            if (!fs.existsSync(path.join(safeCwd, 'manage.py'))) {
                const anchorDir = findProjectAnchorDir(safeCwd, 3);
                if (anchorDir && fs.existsSync(path.join(anchorDir, 'manage.py'))) {
                    effectiveCwd = anchorDir;
                    this.outputChannel.appendLine(`[Terminal Auto-Routing] 'manage.py' detected in ${effectiveCwd}`);
                }
            }
        } else if (/\b(?:npm|pnpm|yarn|npx)\b/i.test(command)) {
            if (!fs.existsSync(path.join(safeCwd, 'package.json'))) {
                const anchorDir = findProjectAnchorDir(safeCwd, 3);
                if (anchorDir && fs.existsSync(path.join(anchorDir, 'package.json'))) {
                    effectiveCwd = anchorDir;
                    this.outputChannel.appendLine(`[Terminal Auto-Routing] 'package.json' detected in ${effectiveCwd}`);
                }
            }
        }

        try {
            const seqResult = await runCommandSequence(command, effectiveCwd, {
                workspaceRoot: safeCwd,
                timeoutMs: 60000,
                onSegmentStart: (seg, curCwd) => {
                    this.outputChannel.appendLine(`[Running]: ${seg} in ${curCwd}`);
                }
            });

            const combinedOutput = seqResult.combinedOutput;
            if (combinedOutput) {
                this.outputChannel.appendLine(combinedOutput);
            }

            const failing = seqResult.results.find(r => !r.ok);
            const exitCode = failing ? (failing.exitCode ?? 1) : 0;
            const isError = !seqResult.ok;

            if (isError) {
                this.outputChannel.appendLine(`Exit Code: ${exitCode}`);
            }

            const cleaned = cleanOutput(combinedOutput, { maxLines: 50 });
            this.lastOutput = cleaned || (isError ? `Execution failed with exit code ${exitCode}` : 'Command executed successfully (no output).');

            return {
                output: this.lastOutput,
                exitCode,
                error: isError
            };
        } catch (syncErr: any) {
            const errMsg = syncErr?.message || String(syncErr);
            this.outputChannel.appendLine(`Execution Exception: ${errMsg}`);
            this.lastOutput = `Failed to spawn process: ${errMsg}`;
            return {
                output: this.lastOutput,
                exitCode: 1,
                error: true
            };
        }
    }

    public static getLastOutput(): string {
        return this.lastOutput;
    }
    
    public static clearOutput(): void {
        this.lastOutput = '';
    }
}
