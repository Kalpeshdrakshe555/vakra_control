import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';

export class TerminalCapture {
    private static outputChannel = vscode.window.createOutputChannel('Ultra Light AI Terminal');
    private static lastOutput: string = '';

    public static async runAndCapture(command: string, workspaceRoot: string): Promise<string> {
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`\n> ${command}`);
        
        return new Promise((resolve) => {
            const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';
            
            cp.exec(command, { cwd: workspaceRoot, maxBuffer: 1024 * 1024, shell }, (error, stdout, stderr) => {
                let fullOutput = '';
                if (stdout) {
                    fullOutput += stdout + '\n';
                    this.outputChannel.append(stdout);
                }
                if (stderr) {
                    fullOutput += stderr + '\n';
                    this.outputChannel.append(stderr);
                }
                if (error) {
                    fullOutput += `Exit Code: ${error.code}\n`;
                    this.outputChannel.appendLine(`Exit Code: ${error.code}`);
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
                resolve(this.lastOutput);
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
