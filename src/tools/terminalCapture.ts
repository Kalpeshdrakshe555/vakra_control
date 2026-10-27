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

export interface TerminalExecutionOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
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
    private static activeAbortControllers: Set<AbortController> = new Set();

    public static isDaemonCommand(command: string): boolean {
        const trimmed = (command || '').replace(/^[\$#>]\s*/, '').trim();
        return /\b(runserver|vite(?!\s+build\b)|npm\s+(?:run\s+)?(?:dev|start|serve|watch)|yarn\s+(?:run\s+)?(?:dev|start|serve|watch)|pnpm\s+(?:run\s+)?(?:dev|start|serve|watch)|flask\s+run|uvicorn\b|gunicorn\b|next\s+dev|nuxt\s+dev|ng\s+serve|nodemon\b|live-server\b|http-server\b|cargo\s+watch|tsc\s+.*(?:-w|--watch))\b/i.test(trimmed);
    }

    public static cancelActive(): void {
        for (const ctrl of this.activeAbortControllers) {
            try {
                ctrl.abort();
            } catch { /* ignore */ }
        }
        this.activeAbortControllers.clear();
    }

    public static async runAndCapture(
        command: string,
        workspaceRoot: string,
        options?: TerminalExecutionOptions
    ): Promise<TerminalExecutionResult> {
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`\n> ${command}`);

        // Prevent long-running continuous/daemon servers from hanging execution
        if (this.isDaemonCommand(command)) {
            const msg = `[BLOCKED]: '${command}' is a long-running continuous process and cannot be run synchronously. Use non-blocking verification commands instead.`;
            this.outputChannel.appendLine(msg);
            this.lastOutput = msg;
            return {
                output: msg,
                exitCode: 1,
                error: true
            };
        }
        
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

        const abortCtrl = new AbortController();
        let removeSignalListener: (() => void) | null = null;
        if (options?.signal) {
            if (options.signal.aborted) {
                abortCtrl.abort();
            } else {
                const onAbort = () => abortCtrl.abort();
                options.signal.addEventListener('abort', onAbort, { once: true });
                removeSignalListener = () => options.signal?.removeEventListener('abort', onAbort);
            }
        }
        this.activeAbortControllers.add(abortCtrl);

        try {
            if (abortCtrl.signal.aborted) {
                const msg = 'Operation cancelled by user.';
                this.outputChannel.appendLine(msg);
                this.lastOutput = msg;
                return {
                    output: msg,
                    exitCode: -1,
                    error: true
                };
            }

            const seqResult = await runCommandSequence(command, effectiveCwd, {
                workspaceRoot: safeCwd,
                timeoutMs: options?.timeoutMs ?? 60000,
                signal: abortCtrl.signal,
                onSegmentStart: (seg, curCwd) => {
                    this.outputChannel.appendLine(`[Running]: ${seg} in ${curCwd}`);
                }
            });

            const combinedOutput = seqResult.combinedOutput;
            if (combinedOutput) {
                this.outputChannel.appendLine(combinedOutput);
            }

            if (abortCtrl.signal.aborted) {
                const msg = 'Operation cancelled by user.';
                this.lastOutput = msg;
                return {
                    output: msg,
                    exitCode: -1,
                    error: true
                };
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
        } finally {
            this.activeAbortControllers.delete(abortCtrl);
            if (removeSignalListener) {
                removeSignalListener();
            }
        }
    }

    public static getLastOutput(): string {
        return this.lastOutput;
    }
    
    public static clearOutput(): void {
        this.lastOutput = '';
    }
}
