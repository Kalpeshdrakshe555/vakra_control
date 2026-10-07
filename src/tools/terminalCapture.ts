import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

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

            let effectiveCwd = safeCwd;

            // Smart CWD & manage.py resolution
            if (/\b(?:python|py|python3)\s+manage\.py\b/i.test(command)) {
                if (!fs.existsSync(path.join(safeCwd, 'manage.py'))) {
                    try {
                        const entries = fs.readdirSync(safeCwd, { withFileTypes: true });
                        for (const entry of entries) {
                            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                                const subManage = path.join(safeCwd, entry.name, 'manage.py');
                                if (fs.existsSync(subManage)) {
                                    effectiveCwd = path.join(safeCwd, entry.name);
                                    this.outputChannel.appendLine(`[Terminal Auto-Routing] 'manage.py' detected in ./${entry.name}. Executing with CWD: ${effectiveCwd}`);
                                    break;
                                }
                            }
                        }
                    } catch {}
                }
            } else if (/\b(?:npm|pnpm|yarn|npx)\b/i.test(command)) {
                if (!fs.existsSync(path.join(safeCwd, 'package.json'))) {
                    try {
                        const entries = fs.readdirSync(safeCwd, { withFileTypes: true });
                        for (const entry of entries) {
                            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                                const subPkg = path.join(safeCwd, entry.name, 'package.json');
                                if (fs.existsSync(subPkg)) {
                                    effectiveCwd = path.join(safeCwd, entry.name);
                                    this.outputChannel.appendLine(`[Terminal Auto-Routing] 'package.json' detected in ./${entry.name}. Executing with CWD: ${effectiveCwd}`);
                                    break;
                                }
                            }
                        }
                    } catch {}
                }
            }

            try {
                cp.exec(command, { cwd: effectiveCwd, maxBuffer: 1024 * 1024, timeout: 30000, shell }, (error, stdout, stderr) => {
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
                        this.outputChannel.appendLine(`Exit Code: ${exitCode}`);
                        if (!fullOutput.trim() && error.message) {
                            fullOutput += error.message + '\n';
                        }
                    }

                    const cleanOutput = fullOutput.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').trim();
                    const lines = cleanOutput.split('\n').filter(l => l.trim().length > 0);
                    let conciseOutput = '';

                    if (lines.length > 35) {
                        const head = lines.slice(0, 5).join('\n');
                        const tail = lines.slice(-30).join('\n');
                        conciseOutput = `${head}\n... [${lines.length - 35} lines omitted] ...\n${tail}`;
                    } else {
                        conciseOutput = cleanOutput;
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
