import * as fs from 'fs';
import * as path from 'path';
import { resolvePython } from '../platform/python';
import { runProcess } from '../platform/process';

export interface FileWriteContext {
    filePath: string;
    fileContent: string;
    oldContent: string | null;
    workspaceRoot: string;
}

export interface FileWriteResult {
    success: boolean;
    revertRequested?: boolean;
    feedback?: string;
}

export interface ToolExecuteContext {
    toolName: string;
    rawOutput: any;
    workspaceRoot: string;
}

export class RuntimePlugins {
    private static cachedPluginModule: any = null;
    private static lastPluginMtime = 0;

    /**
     * Safely loads .ultra-light-ai/plugins.js from workspace if it exists.
     */
    private static loadWorkspacePlugin(workspaceRoot: string): any {
        if (!workspaceRoot) return null;
        const pluginPath = path.join(workspaceRoot, '.ultra-light-ai', 'plugins.js');
        if (!fs.existsSync(pluginPath)) return null;

        try {
            const stat = fs.statSync(pluginPath);
            if (!this.cachedPluginModule || stat.mtimeMs > this.lastPluginMtime) {
                delete require.cache[require.resolve(pluginPath)];
                this.cachedPluginModule = require(pluginPath);
                this.lastPluginMtime = stat.mtimeMs;
            }
            return this.cachedPluginModule;
        } catch (err) {
            console.warn('[RuntimePlugins] Failed to load workspace plugins.js:', err);
            return null;
        }
    }

    /**
     * Hook 1: afterFileWrite
     * Executes immediately after write_file or edit_file writes code to disk.
     * If syntax validation fails, triggers automatic rollback and provides critical corrective feedback to the LLM.
     */
    public static async afterFileWrite(ctx: FileWriteContext): Promise<FileWriteResult> {
        const { filePath, fileContent, oldContent, workspaceRoot } = ctx;
        const plugin = this.loadWorkspacePlugin(workspaceRoot);

        // 1. User-defined hook from .ultra-light-ai/plugins.js
        if (plugin && typeof plugin.afterFileWrite === 'function') {
            try {
                const userRes = await plugin.afterFileWrite({
                    filePath,
                    fileContent,
                    workspaceRoot,
                    oldContent
                });
                if (userRes && userRes.success === false) {
                    if (userRes.revertRequested) {
                        this.rollbackFile(filePath, oldContent);
                    }
                    return userRes;
                }
            } catch (pluginErr: any) {
                console.warn('[RuntimePlugins] User afterFileWrite hook threw an error:', pluginErr);
            }
        }

        // 2. Built-in Deterministic Syntax Guard & Auto-Revert
        const ext = path.extname(filePath).toLowerCase();

        // Python Syntax Guard
        if (ext === '.py') {
            try {
                const pyRes = await resolvePython(workspaceRoot);
                if (!pyRes.ok) {
                    console.warn(`[RuntimePlugins] Python interpreter unavailable: ${pyRes.hint}. Python syntax check skipped.`);
                    return { success: true };
                }

                const compileRes = await runProcess({
                    exe: pyRes.exe,
                    args: [...pyRes.preArgs, '-m', 'py_compile', filePath],
                    cwd: workspaceRoot,
                    timeoutMs: 5000
                });

                if (!compileRes.ok) {
                    const compileErr = (compileRes.stderr || compileRes.stdout || compileRes.error || 'Syntax compilation error').trim();
                    // Revert file to avoid compounding syntax errors
                    this.rollbackFile(filePath, oldContent);
                    return {
                        success: false,
                        revertRequested: true,
                        feedback: `🚨 [SYNTAX GUARD INTERCEPTED BROKEN CODE]:\n${compileErr}\n\n⚠️ ACTION TAKEN: The file has been automatically REVERTED to its last clean state to prevent corrupting the codebase. Fix the syntax error (check colons, indentation, brackets, or unclosed quotes) and re-apply cleanly.`
                    };
                }
            } catch (err: any) {
                console.warn('[RuntimePlugins] Error during Python syntax check execution:', err);
                return { success: true };
            }
        }

        // JSON Syntax Guard
        if (ext === '.json') {
            try {
                JSON.parse(fileContent);
            } catch (err: any) {
                this.rollbackFile(filePath, oldContent);
                return {
                    success: false,
                    revertRequested: true,
                    feedback: `🚨 [SYNTAX GUARD INTERCEPTED INVALID JSON]:\n${err.message}\n\n⚠️ ACTION TAKEN: The JSON file was automatically REVERTED. Ensure valid JSON without trailing commas or unquoted keys.`
                };
            }
        }

        return { success: true };
    }

    /**
     * Hook 2: afterToolExecute
     * Strips noisy node_modules / site-packages frames and truncates oversized terminal logs to save LLM attention budget.
     */
    public static async afterToolExecute(ctx: ToolExecuteContext): Promise<string> {
        const { toolName, rawOutput, workspaceRoot } = ctx;
        if (typeof rawOutput !== 'string') return String(rawOutput ?? '');

        const plugin = this.loadWorkspacePlugin(workspaceRoot);

        // 1. User-defined hook from .ultra-light-ai/plugins.js
        if (plugin && typeof plugin.afterToolExecute === 'function') {
            try {
                const customOutput = await plugin.afterToolExecute({ toolName, rawOutput, workspaceRoot });
                if (typeof customOutput === 'string') return customOutput;
            } catch (err) {
                console.warn('[RuntimePlugins] User afterToolExecute hook error:', err);
            }
        }

        // 2. Built-in Terminal Noise Filter & Attention Protection
        if (toolName === 'execute_terminal_command' || toolName === 'run_in_terminal') {
            const rawLines = rawOutput.split(/\r?\n/);
            const compressedLines = this.compressTraceback(rawLines, workspaceRoot);

            // If log output still exceeds 35 lines, slice to preserve head (command start) and tail (root error/result)
            if (compressedLines.length > 35) {
                const topSlice = compressedLines.slice(0, 10).join('\n');
                const bottomSlice = compressedLines.slice(-25).join('\n');
                return `${topSlice}\n\n[... TRUNCATED ${compressedLines.length - 35} INTERMEDIARY LOG LINES TO CONSERVE 4B CONTEXT BUDGET ...]\n\n${bottomSlice}`;
            }

            return compressedLines.join('\n');
        }

        return rawOutput;
    }

    /**
     * Intelligently compresses Python/Node stack traces by collapsing external library
     * frames while preserving root cause, local workspace frames, and final error lines.
     */
    public static compressTraceback(lines: string[], workspaceRoot?: string): string[] {
        const tbIdx = lines.findIndex(l => l.includes('Traceback (most recent call last):'));
        if (tbIdx === -1) {
            // General output: remove standalone site-packages/node_modules chatter
            return lines.filter(l => {
                const isLib = l.includes('site-packages') || l.includes('node_modules') || l.includes('node:internal');
                return !isLib;
            });
        }

        const headLines = lines.slice(0, tbIdx + 1);
        const tbLines = lines.slice(tbIdx + 1);

        const resultTb: string[] = [];
        let hiddenLibFrames = 0;
        let i = 0;

        while (i < tbLines.length) {
            const line = tbLines[i];
            const isFileFrame = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)/.test(line);

            if (isFileFrame) {
                const isExternal = line.includes('site-packages') || line.includes('dist-packages') || line.includes('lib\\') || line.includes('Lib/');
                const isWorkspace = workspaceRoot ? line.includes(workspaceRoot) : false;

                if (isExternal && !isWorkspace) {
                    hiddenLibFrames++;
                    i++;
                    // Skip accompanying indented code line if present
                    if (i < tbLines.length && !/^\s*File\s+"/.test(tbLines[i]) && !/^[A-Za-z0-9_.]+(?:Error|Exception):/.test(tbLines[i])) {
                        i++;
                    }
                    continue;
                } else {
                    if (hiddenLibFrames > 0) {
                        resultTb.push(`    [... ${hiddenLibFrames} external framework frames hidden ...]`);
                        hiddenLibFrames = 0;
                    }
                    resultTb.push(line);
                    i++;
                    if (i < tbLines.length && !/^\s*File\s+"/.test(tbLines[i]) && !/^[A-Za-z0-9_.]+(?:Error|Exception):/.test(tbLines[i])) {
                        resultTb.push(tbLines[i]);
                        i++;
                    }
                    continue;
                }
            }

            if (hiddenLibFrames > 0) {
                resultTb.push(`    [... ${hiddenLibFrames} external framework frames hidden ...]`);
                hiddenLibFrames = 0;
            }

            // Preserves final exception lines (e.g. "TemplateDoesNotExist: products.html")
            resultTb.push(line);
            i++;
        }

        if (hiddenLibFrames > 0) {
            resultTb.push(`    [... ${hiddenLibFrames} external framework frames hidden ...]`);
        }

        return [...headLines, ...resultTb];
    }

    /**
     * Reverts a file to oldContent if oldContent is present, or unlinks if it was a new file.
     */
    private static rollbackFile(filePath: string, oldContent: string | null): void {
        try {
            if (oldContent !== null && oldContent !== undefined) {
                fs.writeFileSync(filePath, oldContent, 'utf8');
            } else if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (e) {
            console.error(`[RuntimePlugins] Rollback failed for ${filePath}:`, e);
        }
    }
}
