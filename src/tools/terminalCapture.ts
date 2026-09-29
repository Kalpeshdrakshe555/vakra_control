import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';

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
        
        return new Promise((resolve) => {
            const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';
            const safeCwd = (workspaceRoot && workspaceRoot.trim().length > 0)
                ? workspaceRoot
                : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd());

            try {
                cp.exec(command, { cwd: safeCwd, maxBuffer: 1024 * 1024, timeout: 30000, shell }, (error, stdout, stderr) => {
                    let fullOutput = '';
                    let exitCode = 0;
                    let isError = false;

                    if (stdout) {
                        fullOutput += stdout + '\n';
                        this.outputChannel.append(stdout);
                    }
                    if (stderr) {
                        fullOutput += stderr + '\n';
                        this.outputChannel.append(stderr);
                    }
                    if (error) {
                        exitCode = error.code ?? 1;
                        isError = true;
                        fullOutput += `Exit Code: ${exitCode}\n`;
                        this.outputChannel.appendLine(`Exit Code: ${exitCode}`);
                    }

                    // Extract last 15 lines for concise, high-signal AI feedback
                    const lines = fullOutput.trim().split('\n').filter(l => l.trim().length > 0);
                    let conciseOutput = '';
                    if (lines.length > 15) {
                        conciseOutput = lines.slice(-15).join('\n');
                    } else {
                        conciseOutput = fullOutput.trim();
                    }

                    this.lastOutput = conciseOutput || (isError ? `Execution failed with exit code ${exitCode}` : 'Command executed successfully (no output).');
                    resolve({ output: this.lastOutput, exitCode, error: isError });
                });
            } catch (syncErr: any) {
                const errMsg = syncErr?.message || String(syncErr);
                this.outputChannel.appendLine(`Execution Exception: ${errMsg}`);
                this.lastOutput = `Failed to spawn process: ${errMsg}`;
                resolve({ output: this.lastOutput, exitCode: 1, error: true });
            }
        });
    }

    public static getLastOutput(): string {
        return this.lastOutput;
    }
    
    public static clearOutput(): void {
        this.lastOutput = '';
    }
}
