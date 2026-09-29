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

    public static async runAndCapture(command: string, workspaceRoot: string): Promise<TerminalExecutionResult> {
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`\n> ${command}`);
        
        return new Promise((resolve) => {
            const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';
            
            cp.exec(command, { cwd: workspaceRoot, maxBuffer: 1024 * 1024, shell }, (error, stdout, stderr) => {
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

                // Keep only last 100 lines
                const lines = fullOutput.trim().split('\n');
                let truncatedOutput = '';
                if (lines.length > 50) {
                    truncatedOutput = '... (output truncated) ...\n' + lines.slice(-50).join('\n');
                } else {
                    truncatedOutput = fullOutput.trim();
                }

                this.lastOutput = truncatedOutput;
                resolve({ output: this.lastOutput, exitCode, error: isError });
            });
        });
    }

    public static getLastOutput(): string {
        return this.lastOutput;
    }
    
    public static clearOutput(): void {
        this.lastOutput = '';
    }
}
