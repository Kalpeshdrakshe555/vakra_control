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
import { executeDeepResearch, searchWebQuick, searchWebQuickDetailed } from '../../tools/researchDistiller';
import { SkillsManager } from '../../features/skillsManager';

export interface ToolExecutionContext {
    workspaceRoot: string;
    postMessage: (msg: any) => void;
    signal?: AbortSignal;
    isEditSessionAutoApproved: boolean;
    isTerminalSessionAutoApproved: boolean;
    pendingTerminalResolvers: Map<string, (approvedOrResult: any, autoApproveSession?: boolean, command?: string) => void>;
    pendingEditResolvers?: Map<string, (approved: boolean, autoApproveSession?: boolean) => void>;
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
            if (this.lastFailedCommand) {
                return `REJECTED: Cannot finish task because command '${this.lastFailedCommand}' failed. You must diagnose the error, fix the relevant file using edit_file/write_file, and verify the fix before calling finish.`;
            }
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
                this.consecutiveReadCount = 0;
                return "Notice: Multiple consecutive reads completed. The file context is already loaded. Please proceed with your plan/edit/test step instead of reading more files.";
            }
            this.consecutiveReadCount++;

            const startLine = typeof args.start_line === 'number' ? Math.max(1, args.start_line) : undefined;
            const endLine = typeof args.end_line === 'number' ? Math.max(1, args.end_line) : undefined;

            let targetFilepaths: string[] = filepaths.slice(0, 3);
            const joinedKey = targetFilepaths.slice().sort().join('|');
            if (this.lastReadFiles.has(joinedKey) && !this.filesModifiedSinceLastCommand) {
                return `Notice: Files [${targetFilepaths.join(', ')}] were already inspected recently and have not been modified. You already have this code context. Please proceed directly to writing/editing code or running a verification check.`;
            }
            this.lastReadFiles.add(joinedKey);

            postMessage({
                command: 'statusUpdate',
                text: `Reading files: ${targetFilepaths.join(', ')}...`
            });

            postMessage({
                command: 'toolCallEvent',
                tool: 'read_multiple_files',
                title: 'Inspecting Files',
                data: { count: targetFilepaths.length, files: targetFilepaths.join(', '), startLine, endLine }
            });

            let combinedResult = '';
            for (const fp of targetFilepaths) {
                const safeCheck = resolveSafeWorkspacePath(fp, workspaceRoot, false);
                if (!safeCheck.safe) {
                    combinedResult += `\n--- File: ${fp} (Blocked: outside workspace) ---\n`;
                    continue;
                }
                const fullPath = safeCheck.resolvedPath;
                if (!fs.existsSync(fullPath)) {
                    combinedResult += `\n--- File: ${fp} (Not Found) ---\n`;
                    continue;
                }

                const rawContent = fs.readFileSync(fullPath, 'utf8');
                const allLines = rawContent.split(/\r?\n/);
                const totalLines = allLines.length;

                // Case A: Specific line range requested
                if (startLine !== undefined || endLine !== undefined) {
                    const s = Math.max(1, startLine || 1);
                    const e = Math.min(totalLines, endLine || totalLines);
                    const slicedLines = allLines.slice(s - 1, e).map((line, idx) => `${s + idx} | ${line}`).join('\n');
                    combinedResult += `\n--- File: ${fp} (Lines ${s}-${e} of ${totalLines}) ---\n${slicedLines}\n`;
                    continue;
                }

                // Case B: Large file (> 350 lines or > 2000 tokens) without explicit range
                const estimatedTok = estimateTokens(rawContent);
                if (totalLines > 350 || estimatedTok > 2000) {
                    const previewLines = allLines.slice(0, 80).map((line, idx) => `${idx + 1} | ${line}`).join('\n');
                    
                    // Extract functions / classes outline
                    const symbols: string[] = [];
                    allLines.forEach((line, idx) => {
                        const m = line.match(/^\s*(?:export\s+)?(?:def|class|function|interface|type)\s+([A-Za-z0-9_]+)/);
                        if (m) symbols.push(`Line ${idx + 1}: ${m[0].trim()}`);
                    });

                    const outlineText = symbols.length > 0 
                        ? `\nSymbol Outline:\n${symbols.slice(0, 30).join('\n')}` 
                        : '';

                    combinedResult += `\n--- File: ${fp} [LARGE FILE: ${totalLines} lines, ~${estimatedTok} tokens] ---\n` +
                        `Top 80 lines:\n${previewLines}\n` +
                        `${outlineText}\n` +
                        `\n[NOTE: File is large. To inspect specific functions or code blocks, call read_multiple_files with start_line and end_line parameters.]\n`;
                    continue;
                }

                // Case C: Standard normal-sized file
                const numbered = allLines.map((line, idx) => `${idx + 1} | ${line}`).join('\n');
                combinedResult += `\n--- File: ${fp} (${totalLines} lines) ---\n${numbered}\n`;
            }

            SessionMemory.getInstance(workspaceRoot).recordToolResult('read_multiple_files', args, 'Files inspected', true);
            return combinedResult;
        }

        if (name === 'write_file') {
            this.consecutiveReadCount = 0;
            this.lastReadFiles.clear();
            if (!workspaceRoot) return "Error: No workspace open.";
            const { filepath } = args;

            postMessage({
                command: 'statusUpdate',
                text: `Writing file: ${filepath}...`
            });
            let content = args.content || '';
            content = content.replace(/^```[a-zA-Z]*\r?\n/, '').replace(/\r?\n```$/, '');

            const safeCheck = resolveSafeWorkspacePath(filepath, workspaceRoot, false);
            if (!safeCheck.safe) return `Invalid path: ${filepath}`;
            const fullPath = safeCheck.resolvedPath;

            const fileAlreadyExists = fs.existsSync(fullPath);
            const oldContent = fileAlreadyExists ? fs.readFileSync(fullPath, 'utf8') : '';

            let blastRadiusMsg = '';
            try {
                const dependents = DependencyGraph.getDependents(fullPath, workspaceRoot);
                if (dependents && dependents.length > 0) {
                    const relDependents = dependents.slice(0, 5).map(d => path.relative(workspaceRoot, d).replace(/\\/g, '/'));
                    blastRadiusMsg = `\n[BLAST RADIUS NOTICE: The following files import this file: ${relDependents.join(', ')}. Verify imports.]`;
                }
            } catch {}

            const callId = 'write_' + Date.now();

            const applyWriteToDisk = async () => {
                const parentDir = path.dirname(fullPath);
                if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
                if (fileAlreadyExists) {
                    try { FileVersioning.saveSnapshot(workspaceRoot, fullPath, oldContent); } catch {}
                }
                fs.writeFileSync(fullPath, content, 'utf8');
                try {
                    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === fullPath);
                    if (openDoc && openDoc.isDirty) await openDoc.save();
                } catch {}
                SessionMemory.getInstance(workspaceRoot).recordToolResult('write_file', args, 'File written successfully', true);
                this.filesModifiedSinceLastCommand = true;
                LivingIndex.refreshBlueprint(workspaceRoot).catch(() => {});
            };

            // If session is already auto-approved, write immediately
            if (ctx.isEditSessionAutoApproved) {
                await applyWriteToDisk();
                postMessage({
                    command: 'toolCallEvent',
                    tool: 'write_file',
                    title: fileAlreadyExists ? 'Updated File' : 'Created File',
                    data: { callId, filepath, content, oldContent, length: content.length, isNew: !fileAlreadyExists, isAutoApproved: true }
                });
                return `Successfully wrote file: ${filepath} (${content.length} characters).${blastRadiusMsg}`;
            }

            // Otherwise, pause and wait for user card approval
            postMessage({
                command: 'toolCallEvent',
                tool: 'write_file',
                title: fileAlreadyExists ? 'Update File Request' : 'Create File Request',
                data: { callId, filepath, content, oldContent, length: content.length, isNew: !fileAlreadyExists, isAutoApproved: false }
            });

            return await new Promise<string>((resolve) => {
                if (ctx.signal) {
                    ctx.signal.addEventListener('abort', () => resolve('Operation cancelled by user.'));
                }
                ctx.pendingEditResolvers?.set(callId, async (approved, autoApproveSession) => {
                    if (autoApproveSession) ctx.isEditSessionAutoApproved = true;
                    if (!approved) {
                        resolve(`User rejected write operation for ${filepath}.`);
                        return;
                    }
                    await applyWriteToDisk();
                    resolve(`Successfully wrote file: ${filepath} (${content.length} characters).${blastRadiusMsg}`);
                });
            });
        }

        if (name === 'edit_file') {
            this.consecutiveReadCount = 0;
            this.lastReadFiles.clear();
            if (!workspaceRoot) return "Error: No workspace open.";
            const { filepath } = args;

            postMessage({
                command: 'statusUpdate',
                text: `Editing file: ${filepath}...`
            });
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

            FileVersioning.saveSnapshot(workspaceRoot, fullPath, fileContent);
            fs.writeFileSync(fullPath, newContent, 'utf8');

            try {
                const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === fullPath);
                if (openDoc && openDoc.isDirty) {
                    await openDoc.save();
                }
            } catch {}

            SessionMemory.getInstance(workspaceRoot).recordToolResult('edit_file', args, 'File patch applied successfully', true);
            this.filesModifiedSinceLastCommand = true;
            LivingIndex.refreshBlueprint(workspaceRoot).catch(() => {});

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
                    isAutoApproved: true
                }
            });

            let blastRadiusMsg = '';
            try {
                const dependents = DependencyGraph.getDependents(fullPath, workspaceRoot);
                if (dependents && dependents.length > 0) {
                    const relDependents = dependents.slice(0, 5).map(d => path.relative(workspaceRoot, d).replace(/\\/g, '/'));
                    blastRadiusMsg = `\n[BLAST RADIUS NOTICE: The following files import this file: ${relDependents.join(', ')}. If you changed schemas, function signatures, or exports, verify whether these dependent files need updates.]`;
                }
            } catch {}

            return `Successfully edited file: ${filepath}.${blastRadiusMsg}`;
        }

        if (name === 'execute_terminal_command') {
            this.consecutiveReadCount = 0;
            if (!workspaceRoot) return "Error: No workspace open.";
            const { command } = args;
            if (!command) return "Error: command is required.";

            const trimmed = command.trim();
            if (/\bpython\b.*manage\.py\s+runserver\b/i.test(trimmed)) {
                return "BLOCKED: 'python manage.py runserver' is a blocking continuous process and will freeze the agent loop. Use non-blocking verification instead: run 'python manage.py check' to validate models/settings/routes, or execute a verification test script in '.ultra-light-ai/scratch/'.";
            }

            if (/^(?:from\s+[A-Za-z0-9_.]+\s+import|import\s+[A-Za-z0-9_.]+)/.test(trimmed) || /^(?:class|def)\s+[A-Za-z0-9_]+/.test(trimmed) || /^(?:python|python3|py)\s*$/i.test(trimmed) || /^(?:python|python3|py)\s+-i\b/i.test(trimmed)) {
                return "BLOCKED: Naked Python syntax or interactive REPL commands cannot run directly in the terminal shell. To execute Python code: write the code into a verification script with write_file (e.g. '.ultra-light-ai/scratch/verify.py') and then execute 'python .ultra-light-ai/scratch/verify.py', or use one-line 'python -c \"...\"'.";
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
                SessionMemory.getInstance(workspaceRoot).recordToolResult('execute_terminal_command', args, res.output || (res.error ? 'Error' : '') || '', res.exitCode === 0);
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

        if (name === 'read_skill') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const targetName = (args.skill_name || args.name || '').trim().toLowerCase();
            if (!targetName) {
                return "Error: 'skill_name' parameter is required for read_skill.";
            }

            const allSkills = SkillsManager.loadSkills(workspaceRoot);
            const found = allSkills.find(s => 
                s.name.toLowerCase() === targetName || 
                s.name.toLowerCase().includes(targetName) ||
                targetName.includes(s.name.toLowerCase()) ||
                s.triggerRules.some(t => t.toLowerCase() === targetName)
            );

            if (!found) {
                const available = allSkills.map(s => s.name).join(', ') || 'None';
                return `Skill '${targetName}' not found. Available skills in workspace: ${available}.`;
            }

            const relPath = found.filePath ? path.relative(workspaceRoot, found.filePath).replace(/\\/g, '/') : '';
            postMessage({
                command: 'toolCallEvent',
                tool: 'read_skill',
                title: `Skill Loaded: ${found.name}`,
                data: {
                    skillName: found.name,
                    description: found.description,
                    filePath: relPath
                }
            });

            return `[LOADED WORKSPACE SKILL: ${found.name.toUpperCase()}]\n${found.instructions}`;
        }

        if (name === 'search_codebase') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const query = args.query || args.term || '';
            if (!query) return "Error: 'query' parameter is required for search_codebase.";

            postMessage({
                command: 'toolCallEvent',
                tool: 'search_codebase',
                title: `Searching Code: "${query}"`,
                data: { query }
            });

            try {
                // Use LivingIndex / ToolRegistry to execute codebase search
                const results = await ToolRegistry.executeTool('search_codebase', JSON.stringify({ query }), workspaceRoot);
                SessionMemory.getInstance(workspaceRoot).recordToolResult('search_codebase', args, 'Codebase searched', true);
                return results || `No matches found for query: "${query}" in workspace.`;
            } catch (err: any) {
                return `Codebase search failed: ${err.message}`;
            }
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

        if (name === 'search_web') {
            const query = args.query || args.prompt || '';
            if (!query) return "Error: 'query' parameter is required for search_web.";

            postMessage({
                command: 'statusUpdate',
                text: `🔍 Live Web Search: "${query}"...`
            });

            try {
                const searchRes = await searchWebQuickDetailed(query);

                postMessage({
                    command: 'toolCallEvent',
                    tool: 'search_web',
                    title: `Web Search: ${query}`,
                    data: { query, sources: searchRes.sources }
                });

                const now = new Date();
                const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                const formatDate = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

                return `[REAL-TIME CALENDAR ANCHOR: Today is ${formatDate(now)}, Yesterday was ${formatDate(yesterday)}, Tomorrow is ${formatDate(tomorrow)}]
[LIVE WEB SEARCH RESULTS for "${query}" from Top 3 Authoritative Websites]:
${searchRes.text}

[CRITICAL INSTRUCTION]:
1. Synthesize these live facts directly into a clear, comprehensive answer with exact scores, runs, wickets, overs, and match status.
2. If the user asked in Hindi/Hinglish (e.g. "kal"), clarify the exact calendar date (${formatDate(yesterday)} for completed matches / ${formatDate(tomorrow)} for upcoming fixtures).
3. Present all facts and scores directly to the user. Do NOT deflect or say "I cannot provide live scores, visit website X".`;
            } catch (err: any) {
                return `Web search failed: ${err.message}`;
            }
        }

        if (name === 'research_web_docs') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const query = args.query || args.prompt || '';
            const urls = Array.isArray(args.urls) ? args.urls : [];

            if (!query && urls.length === 0) {
                return "Error: query or urls required for web research.";
            }

            postMessage({
                command: 'statusUpdate',
                text: `🌐 Deep research & dossier generation for: "${query}"...`
            });

            try {
                const res: any = await executeDeepResearch(query, urls, workspaceRoot);

                const sources = Array.isArray(res?.sources) ? res.sources : [];
                const filePath = res?.filePath || '';
                const resultText = res?.rawTextResult || (typeof res === 'string' ? res : JSON.stringify(res));

                postMessage({
                    command: 'toolCallEvent',
                    tool: 'research_web_docs',
                    title: `Dossier Created: ${query}`,
                    data: {
                        callId: 'research_' + Date.now(),
                        query,
                        filePath,
                        sources
                    }
                });

                // Dual Delivery: Save dossier to disk AND return extracted findings straight to context
                const keySnippet = resultText.length > 2500 ? resultText.substring(0, 2500) + '\n... (Full technical dossier saved to disk)' : resultText;

                return `[RESEARCH COMPLETE: Full technical dossier saved to \`${filePath}\`]\n\nEXTRACTED FINDINGS FOR IMMEDIATE USE:\n${keySnippet}`;
            } catch (err: any) {
                return `Web research failed: ${err.message}`;
            }
        }

        return `Tool '${name}' executed via fallback.`;
    }
}
