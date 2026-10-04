import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveSafeWorkspacePath } from '../../operations/diffPatcher';
import { FileVersioning } from '../../operations/fileVersioning';
import { SessionMemory } from '../../state/sessionMemory';
import { ToolRegistry } from '../../tools/toolRegistry';
import { TerminalCapture } from '../../tools/terminalCapture';
import { estimateTokens, truncateToTokens } from '../../utils/tokenBudget';
import { DependencyGraph } from '../../utils/dependencyGraph';
import { extractBrandDNA, orchestrateAssets, DesignSemantics } from '../../utils/designBrain';
import { LivingIndex } from '../../indexer/livingIndex';
import { executeDeepResearch } from '../../tools/researchDistiller';
import { SkillsManager } from '../../features/skillsManager';

export interface ToolExecutionContext {
    workspaceRoot: string;
    postMessage: (msg: any) => void;
    signal?: AbortSignal;
    isEditSessionAutoApproved: boolean;
    isTerminalSessionAutoApproved: boolean;
    pendingTerminalResolvers: Map<string, (result: string) => void>;
    taskPlanner: any;
    currentTaskState?: any;
    ragEngine?: any;
}

export class ToolDispatcher {
    private static consecutiveReadCount = 0;
    private static lastReadFiles: Set<string> = new Set<string>();
    private static lastFailedCommand: string | null = null;
    private static filesModifiedSinceLastCommand: boolean = false;

    public static async dispatch(functionCall: any, ctx: ToolExecutionContext): Promise<any> {
        if (ctx.signal?.aborted) {
            throw new Error('Operation aborted by user.');
        }

        const { workspaceRoot, postMessage } = ctx;
        const name = functionCall.name;
        const args = functionCall.args || {};

        if (name === 'finish') {
            const summary = args.summary || 'Task completed successfully.';
            if (workspaceRoot) {
                SessionMemory.getInstance(workspaceRoot).recordToolResult('finish', args, summary, true);
            }
            return summary;
        }

        if (name === 'read_multiple_files') {
            if (!workspaceRoot) return "Error: No workspace open.";
            let filepaths: string[] = [];
            if (Array.isArray(args.paths)) {
                filepaths = args.paths;
            } else if (Array.isArray(args.filepaths)) {
                filepaths = args.filepaths;
            } else if (typeof args.filepath === 'string') {
                filepaths = [args.filepath];
            } else if (typeof args.path === 'string') {
                filepaths = [args.path];
            } else {
                return "Error: 'paths' must be an array of file paths.";
            }

            if (this.consecutiveReadCount >= 3) {
                return "Throttling Limit: Maximum 3 consecutive file read operations reached. Please provide plan or edits.";
            }
            this.consecutiveReadCount++;

            let targetFilepaths: string[] = filepaths.slice(0, 3);
            postMessage({
                command: 'toolCallEvent',
                tool: 'read_multiple_files',
                title: 'Inspecting Files',
                data: { count: targetFilepaths.length, files: targetFilepaths.join(', ') }
            });

            let combinedResult = '';
            for (const fp of targetFilepaths) {
                const safeCheck = resolveSafeWorkspacePath(fp, workspaceRoot, false);
                if (!safeCheck.safe) {
                    combinedResult += `\n--- File: ${fp} (Blocked: outside workspace) ---\n`;
                    continue;
                }
                const fullPath = safeCheck.resolvedPath;
                if (fs.existsSync(fullPath)) {
                    let content = fs.readFileSync(fullPath, 'utf8');
                    if (estimateTokens(content) > 3000) {
                        content = truncateToTokens(content, 3000) + '\n\n... (Truncated)';
                    }
                    combinedResult += `\n--- File: ${fp} ---\n${content}\n`;
                } else {
                    combinedResult += `\n--- File: ${fp} (Not Found) ---\n`;
                }
            }
            SessionMemory.getInstance(workspaceRoot).recordToolResult('read_multiple_files', args, 'Files inspected', true);
            return combinedResult;
        }

        if (name === 'write_file') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const { filepath } = args;
            let content = args.content || '';
            content = content.replace(/^```[a-zA-Z]*\r?\n/, '').replace(/\r?\n```$/, '');

            const safeCheck = resolveSafeWorkspacePath(filepath, workspaceRoot, false);
            if (!safeCheck.safe) return `Invalid path: ${filepath}`;
            const fullPath = safeCheck.resolvedPath;

            const fileAlreadyExists = fs.existsSync(fullPath);
            const oldContent = fileAlreadyExists ? fs.readFileSync(fullPath, 'utf8') : '';

            // If auto-approved, write immediately
            if (ctx.isEditSessionAutoApproved) {
                const parentDir = path.dirname(fullPath);
                if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
                if (fileAlreadyExists) {
                    try { FileVersioning.saveSnapshot(workspaceRoot, fullPath, oldContent); } catch {}
                }
                fs.writeFileSync(fullPath, content, 'utf8');
                SessionMemory.getInstance(workspaceRoot).recordToolResult('write_file', args, 'File written successfully', true);
                this.filesModifiedSinceLastCommand = true;
                LivingIndex.refreshBlueprint(workspaceRoot).catch(() => {});
            }

            const callId = 'write_' + Date.now();
            postMessage({
                command: 'toolCallEvent',
                tool: 'write_file',
                title: fileAlreadyExists ? 'Updated File' : 'Created File',
                data: {
                    callId,
                    filepath,
                    content,
                    oldContent,
                    length: content.length,
                    isNew: !fileAlreadyExists,
                    hasDiff: true,
                    isAutoApproved: ctx.isEditSessionAutoApproved
                }
            });

            return `Staged write for ${filepath}. ${ctx.isEditSessionAutoApproved ? 'Applied automatically.' : 'Waiting for user approval card.'}`;
        }

        if (name === 'edit_file') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const { filepath } = args;
            const oldText = args.old_text ?? args.oldText;
            const newText = args.new_text ?? args.newText;

            const safeCheck = resolveSafeWorkspacePath(filepath, workspaceRoot, false);
            if (!safeCheck.safe) return `Invalid path: ${filepath}`;
            const fullPath = safeCheck.resolvedPath;

            if (!fs.existsSync(fullPath)) return `Error: File not found: ${filepath}`;

            let fileContent = fs.readFileSync(fullPath, 'utf8');
            if (!fileContent.includes(oldText)) {
                return `edit_file failed: old_text snippet was not found in ${filepath}.`;
            }

            const newContent = fileContent.replace(oldText, newText);

            if (ctx.isEditSessionAutoApproved) {
                FileVersioning.saveSnapshot(workspaceRoot, fullPath, fileContent);
                fs.writeFileSync(fullPath, newContent, 'utf8');
                SessionMemory.getInstance(workspaceRoot).recordToolResult('edit_file', args, 'File patch applied successfully', true);
                this.filesModifiedSinceLastCommand = true;
                LivingIndex.refreshBlueprint(workspaceRoot).catch(() => {});
            }

            const callId = 'edit_' + Date.now();
            postMessage({
                command: 'toolCallEvent',
                tool: 'edit_file',
                title: 'Edited File',
                data: {
                    callId,
                    filepath,
                    oldText,
                    newText,
                    content: newContent,
                    oldContent: fileContent,
                    hasDiff: true,
                    isAutoApproved: ctx.isEditSessionAutoApproved
                }
            });

            return `Staged edit for ${filepath}. ${ctx.isEditSessionAutoApproved ? 'Applied automatically.' : 'Waiting for user approval card.'}`;
        }

        if (name === 'execute_terminal_command') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const { command } = args;
            if (!command) return "Error: command is required.";

            // Intercept blocking dev server commands to prevent indefinite hanging
            const trimmed = command.trim();
            if (/\bpython\b.*manage\.py\s+runserver\b/i.test(trimmed)) {
                return "BLOCKED: 'python manage.py runserver' is a blocking continuous process and will freeze the agent loop. Use non-blocking verification instead: run 'python manage.py check' to validate models/settings/routes, or execute a verification test script in '.ultra-light-ai/scratch/'.";
            }

            const cmd = (command || '').replace(/^[\$#>]\s*/, '').trim();
            const explanation = args.explanation || 'Running terminal command';

            if (ctx.isTerminalSessionAutoApproved) {
                const autoCallId = 'cmd_' + Date.now();
                postMessage({
                    command: 'toolCallEvent',
                    tool: 'execute_terminal_command',
                    title: 'Terminal Command (Session Auto-Approved)',
                    data: { command: cmd, explanation, callId: autoCallId, isAutoApproved: true }
                });
                const res = await TerminalCapture.runAndCapture(cmd, workspaceRoot);
                SessionMemory.getInstance(workspaceRoot).recordToolResult('execute_terminal_command', args, res.output || res.error || '', res.exitCode === 0);
                postMessage({
                    command: 'terminalCommandCompleted',
                    callId: autoCallId,
                    exitCode: res.exitCode,
                    error: res.error,
                    output: res.output,
                    commandText: cmd
                });
                return `[TERMINAL EXECUTION ${res.error ? 'FAILED' : 'SUCCESS'}]\nExit Code: ${res.exitCode}\nOutput: ${res.output || '(No output)'}`;
            }

            const callId = 'cmd_' + Date.now();
            postMessage({
                command: 'toolCallEvent',
                tool: 'execute_terminal_command',
                title: 'Terminal Command Requested',
                data: { command: cmd, explanation, callId }
            });

            return await new Promise<string>((resolve) => {
                ctx.pendingTerminalResolvers.set(callId, (resText) => {
                    SessionMemory.getInstance(workspaceRoot).recordToolResult('execute_terminal_command', args, resText, !resText.includes('FAILED'));
                    resolve(resText);
                });
            });
        }

        if (name === 'create_skill') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const { name: skillName, description, trigger_rules, instructions } = args;
            if (!skillName || !instructions) {
                return "Error: Both 'name' and 'instructions' are required to create a skill.";
            }

            const triggers = Array.isArray(trigger_rules) ? trigger_rules : [skillName];
            const savedPath = SkillsManager.saveCustomSkill(
                workspaceRoot,
                skillName,
                description || `Custom skill for ${skillName}`,
                triggers,
                instructions
            );

            const relPath = path.relative(workspaceRoot, savedPath).replace(/\\/g, '/');
            postMessage({
                command: 'toolCallEvent',
                tool: 'create_skill',
                title: `Skill Created: ${skillName}`,
                data: {
                    skillName,
                    triggers,
                    filePath: relPath
                }
            });

            return `Custom skill "${skillName}" created successfully! Saved to \`${relPath}\`. It will automatically trigger when prompts mention: ${triggers.join(', ')}.`;
        }

        if (name === 'list_directory_tree') {
            postMessage({
                command: 'toolCallEvent',
                tool: 'list_directory_tree',
                title: 'Directory Tree',
                data: { dir: args.dir || '.', depth: args.depth || 2 }
            });
            return await ToolRegistry.executeTool('list_directory_tree', JSON.stringify(args), workspaceRoot);
        }

        if (name === 'research_web_docs' || name === 'search_web') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const query = args.query || args.prompt || '';
            const urls = Array.isArray(args.urls) ? args.urls : [];

            if (!query && urls.length === 0) {
                return "Error: query or urls required for web research.";
            }

            postMessage({
                command: 'statusUpdate',
                text: `🌐 Researching verified docs for: "${query}"...`
            });

            try {
                const res: any = await executeDeepResearch(query, urls, workspaceRoot);

                const sources = Array.isArray(res?.sources) ? res.sources : [];
                const filePath = res?.filePath || '';
                const resultText = res?.rawTextResult || (typeof res === 'string' ? res : JSON.stringify(res));

                postMessage({
                    command: 'toolCallEvent',
                    tool: 'research_web_docs',
                    title: `Researched: ${query}`,
                    data: {
                        callId: 'research_' + Date.now(),
                        query,
                        filePath,
                        sources
                    }
                });

                return resultText;
            } catch (err: any) {
                return `Web research failed: ${err.message}`;
            }
        }

        return `Tool '${name}' executed via fallback.`;
    }
}
