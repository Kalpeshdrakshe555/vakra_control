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
import { UnifiedWebSearch } from '../../tools/unifiedWebSearch';
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
    recordFileBackup?: (filepath: string, oldContent: string | null) => void;
    config?: any;
}

export class ToolDispatcher {
    private static consecutiveReadCount = 0;
    private static lastReadFiles: Set<string> = new Set<string>();
    private static lastFailedCommand: string | null = null;
    private static filesModifiedSinceLastCommand: boolean = false;
    private static lastWebBrainPrompt: string = '';
    private static webBrainCallCountWithoutAction: number = 0;

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
            this.webBrainCallCountWithoutAction = 0;
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
                if (ctx.recordFileBackup) {
                    ctx.recordFileBackup(fullPath, fileAlreadyExists ? oldContent : null);
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
            this.webBrainCallCountWithoutAction = 0;
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
            if (ctx.recordFileBackup) {
                ctx.recordFileBackup(fullPath, fileContent);
            }
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
            this.webBrainCallCountWithoutAction = 0;
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

        /* ========================================================================= */
        /* [VERSION 1 - LEGACY DISPATCHER FOR search_web & research_web_docs - PRESERVED FOR ROLLBACK]
        // To rollback to Version 1 legacy tools, simply uncomment the block below and comment out Version 2.
        /*
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

                const sourcesList = (searchRes.sources || []).map((s, idx) => 
                    `[${idx + 1}] Title: "${s.title}" | Domain: ${s.domain} | URL: ${s.url}`
                ).join('\n');

                return `[REAL-TIME CALENDAR ANCHOR: Today is ${formatDate(now)}, Yesterday was ${formatDate(yesterday)}, Tomorrow is ${formatDate(tomorrow)}]

[VERIFIED SOURCES FOR CITATIONS]:
${sourcesList || 'No direct source URLs available.'}

[LIVE WEB SEARCH EXTRACTS for "${query}"]:
${searchRes.text}

[CRITICAL INSTRUCTION - FACT SYNTHESIS & CITATIONS]:
1. Synthesize these live facts directly into a clear, comprehensive, and well-structured answer.
2. MANDATORY CITATIONS & REFERENCES (Industry Standard):
   - You MUST cite the sources you used so the user can verify all facts, specs, and claims.
   - Use inline citation badges where relevant (e.g. [[1]](url) or [[2]](url)) next to key claims, specs, numbers, dates, or architectures.
   - At the VERY END of your response, ALWAYS provide a dedicated sources section:
     ### 🌐 Sources & References
     - [[1] Title or Domain](url) - Brief note on what data was retrieved from here
     - [[2] Title or Domain](url) - Brief note on what data was retrieved from here
   - Never fabricate or guess URLs. Use ONLY the exact URLs listed above under [VERIFIED SOURCES FOR CITATIONS].
3. For technical queries (models, embeddings, frameworks, APIs): provide exact model sizes, parameter counts, dimensions, context windows, and practical code snippets.
4. For live events/sports: provide exact scores, dates, and match status directly.
5. Present the synthesized facts directly without deflection.`;
            } catch (err: any) {
                return `Web search failed: ${err.message}`;
            }
        }

        if (name === 'research_web_docs') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const query = args.query || args.prompt || '';
            const urls = Array.isArray(args.urls) ? args.urls : [];
            const offset = typeof args.offset === 'number' ? args.offset : 0;
            const limit = typeof args.limit === 'number' ? args.limit : (typeof args.chunk_size === 'number' ? args.chunk_size : 8500);

            if (!query && urls.length === 0) {
                return "Error: query or urls required for web research.";
            }

            postMessage({
                command: 'statusUpdate',
                text: offset > 0 
                    ? `📖 Reading documentation slice (Offset: ${offset})...`
                    : `🌐 Deep research & dossier generation for: "${query}"...`
            });

            try {
                const res: any = await executeDeepResearch(query, urls, workspaceRoot, { offset, limit });

                const sources = Array.isArray(res?.sources) ? res.sources : [];
                const filePath = res?.filePath || '';
                const resultText = res?.rawTextResult || (typeof res === 'string' ? res : JSON.stringify(res));

                postMessage({
                    command: 'toolCallEvent',
                    tool: 'research_web_docs',
                    title: offset > 0 ? `Doc Slice Read: ${query}` : `Dossier Created: ${query}`,
                    data: {
                        callId: 'research_' + Date.now(),
                        query,
                        filePath,
                        sources,
                        offset
                    }
                });

                return resultText;
            } catch (err: any) {
                return `Web research failed: ${err.message}`;
            }
        }
        */
        /* ========================================================================= */

        /* ========================================================================= */
        /* [VERSION 2 - UNIFIED WEB SEARCH (5K CHUNK STREAMING & AUTO-PAGINATION)] */
        /* Both search_web and research_web_docs route to this single unified engine */
        /* ========================================================================= */
        if (name === 'search_web' || name === 'research_web_docs') {
            const query = args.query || args.prompt || '';
            const urls = Array.isArray(args.urls) ? args.urls : [];
            const offset = typeof args.offset === 'number' ? args.offset : 0;
            const chunkSize = typeof args.chunk_size === 'number' ? args.chunk_size : 5000;

            if (!query && urls.length === 0) {
                return "Error: 'query' or 'urls' parameter is required for web search.";
            }

            postMessage({
                command: 'statusUpdate',
                text: offset > 0
                    ? `📖 Streaming next 5k doc slice (Offset: ${offset})...`
                    : `🌐 Unified Web Search (5k/site extraction): "${query}"...`
            });

            try {
                const searchRes = await UnifiedWebSearch.execute({
                    query,
                    urls,
                    offset,
                    chunk_size: chunkSize
                }, workspaceRoot);

                const titleText = offset > 0
                    ? `Doc Slice (Offset ${offset}): ${query}`
                    : `Web Search: ${query}`;

                postMessage({
                    command: 'toolCallEvent',
                    tool: 'search_web',
                    title: titleText,
                    data: {
                        query,
                        sources: searchRes.sources,
                        offset: searchRes.offset,
                        isCached: searchRes.isCached
                    }
                });

                return searchRes.text;
            } catch (err: any) {
                return `Web search failed: ${err?.message || err}`;
            }
        }

        if (name === 'consult_web_brain') {
            const prompt = (args.prompt || args.query || args.message || '').trim();
            if (!prompt) return "Error: 'prompt' parameter is required to consult the web brain.";

            // Normalize prompt for duplicate loop prevention
            const normPrompt = prompt.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
            const normLast = this.lastWebBrainPrompt.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

            const isDuplicate = normPrompt.length > 10 && (normPrompt === normLast || normPrompt.startsWith(normLast) || normLast.startsWith(normPrompt));

            if (isDuplicate && this.webBrainCallCountWithoutAction > 0) {
                return `[REPEATED WEB BRAIN CONSULTATION BLOCKED]:
You have already received the complete guidance and code from Web Brain for this request in the previous turn.
Do NOT send duplicate requests to Web Brain!
You must now execute the provided steps immediately:
1. Call 'write_file' for EVERY file that Web Brain instructed to create or update.
2. Call 'execute_terminal_command' for any shell/setup commands provided.
Proceed immediately to file creation and code implementation.`;
            }

            if (this.webBrainCallCountWithoutAction >= 2) {
                return `[ACTION REQUIRED BEFORE NEXT WEB BRAIN CONSULTATION]:
Web Brain has already given you actionable instructions. You have queried Web Brain twice consecutively without creating files or running commands.
You MUST write the planned files using 'write_file' or execute terminal commands using 'execute_terminal_command' before consulting Web Brain again.`;
            }

            const provider = ctx.config?.webBrainBridge?.provider?.toUpperCase() || 'GEMINI';
            postMessage({
                command: 'statusUpdate',
                text: `🌐 Consulting ${provider} Web in Chrome...`
            });

            postMessage({
                command: 'toolCallEvent',
                tool: 'consult_web_brain',
                title: `Consulting ${provider} Web`,
                data: { prompt }
            });

            try {
                // Auto-enrich prompt with Windows PowerShell environment & micro-step rules
                let finalPromptToSend = prompt;
                if (!prompt.includes('[ENVIRONMENT & EXECUTION PROTOCOL')) {
                    const wsName = workspaceRoot ? path.basename(workspaceRoot) : 'workspace';
                    finalPromptToSend = `[ENVIRONMENT & EXECUTION PROTOCOL FOR GEMINI]:
- Operating System: Windows (PowerShell)
- Working Directory: Workspace Root ('${wsName}').
- PowerShell Rules: NEVER chain commands with '&&'. Output each command cleanly. Never use standalone 'cd <dir>'.
- MICRO-STEP DISCIPLINE: Provide STRICTLY ONE single step at a time!
  * If providing commands: provide ONLY the commands for this single step.
  * If providing code: provide ONLY ONE file at a time so the local agent can write it before proceeding.
  * Clearly specify what the next step will be.

[CURRENT REQUEST]:
${prompt}`;
                }
                const answer = await bridge.sendWebPromptAndGetResponse(finalPromptToSend, undefined, ctx.signal);

                this.lastWebBrainPrompt = prompt;
                this.webBrainCallCountWithoutAction++;

                postMessage({
                    command: 'statusUpdate',
                    text: `📥 Received response from ${provider} Web.`
                });

                return ToolDispatcher.formatWebBrainGuidance(answer);
            } catch (err: any) {
                return `Failed to consult Web Brain: ${err?.message || err}`;
            }
        }

        return `Tool '${name}' executed via fallback.`;
    }

    private static extractWebBrainActionItems(rawText: string): { files: string[]; commands: string[] } {
        const files: Set<string> = new Set();
        const commands: Set<string> = new Set();

        const codeBlockRegex = /```([a-zA-Z0-9_\-\.\/\\:]*)\r?\n([\s\S]*?)```/g;
        let match: RegExpExecArray | null;

        while ((match = codeBlockRegex.exec(rawText)) !== null) {
            const headerTag = (match[1] || '').trim();
            const codeContent = match[2];
            const matchStartIndex = match.index;

            let detectedFile: string | null = null;

            if (headerTag.includes(':')) {
                const part = headerTag.split(':')[1]?.trim();
                if (part && /\.[a-zA-Z0-9]{1,8}$/.test(part)) {
                    detectedFile = part.replace(/["']/g, '');
                }
            } else if (/file=["']?([^"'\s]+)["']?/i.test(headerTag)) {
                const m = headerTag.match(/file=["']?([^"'\s]+)["']?/i);
                if (m && m[1]) detectedFile = m[1];
            } else {
                const parts = headerTag.split(/\s+/);
                if (parts.length > 1 && /\.[a-zA-Z0-9]{1,8}$/.test(parts[1])) {
                    detectedFile = parts[1];
                }
            }

            if (!detectedFile) {
                const codeLines = codeContent.slice(0, 300).split(/\r?\n/).slice(0, 3);
                for (const cl of codeLines) {
                    const commentMatch = cl.match(/(?:\/\/|\/\*|#|<!--)\s*([a-zA-Z0-9_\-\.\/\\]+\.[a-zA-Z0-9]{1,8})(?:\s*\*\/|-->)?/);
                    if (commentMatch && commentMatch[1] && !commentMatch[1].startsWith('http')) {
                        const candidate = commentMatch[1].trim();
                        if (candidate.includes('/') || candidate.includes('\\') || candidate.includes('.')) {
                            detectedFile = candidate;
                            break;
                        }
                    }
                }
            }

            if (!detectedFile) {
                const precedingText = rawText.slice(Math.max(0, matchStartIndex - 300), matchStartIndex);
                const precedingLines = precedingText.split(/\r?\n/).filter(l => l.trim().length > 0);
                const lastLine = precedingLines[precedingLines.length - 1] || '';
                const secondLastLine = precedingLines[precedingLines.length - 2] || '';

                for (const pl of [lastLine, secondLastLine]) {
                    const preMatch = pl.match(/(?:file|path|create|update)?[:\s*#`]*([a-zA-Z0-9_\-\.\/\\]+\.[a-zA-Z0-9]{1,8})[`*:]*/i);
                    if (preMatch && preMatch[1] && !preMatch[1].startsWith('http') && !preMatch[1].startsWith('www')) {
                        const cand = preMatch[1].trim();
                        if ((cand.includes('/') || cand.includes('\\') || cand.includes('.')) && !cand.endsWith('.com') && !cand.endsWith('.org')) {
                            detectedFile = cand;
                            break;
                        }
                    }
                }
            }

            const isShellBlock = /^(bash|sh|zsh|shell|cmd|powershell)$/i.test(headerTag) ||
                /^\s*(npm|pnpm|yarn|npx|pip|python|django-admin|git|cd)\b/m.test(codeContent.trim());

            if (isShellBlock && !detectedFile) {
                const cmdLines = codeContent.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
                for (const cl of cmdLines) {
                    if (cl.length > 2 && cl.length < 200) {
                        commands.add(cl.replace(/^[\$#>]\s*/, ''));
                    }
                }
            } else if (detectedFile) {
                const cleanPath = detectedFile.replace(/[`"'()\[\]]/g, '').trim();
                if (cleanPath && !cleanPath.endsWith('.md') && !cleanPath.endsWith('.png') && !cleanPath.endsWith('.jpg')) {
                    files.add(cleanPath);
                }
            }
        }

        return {
            files: Array.from(files),
            commands: Array.from(commands)
        };
    }

    private static formatWebBrainGuidance(rawAnswer: string): string {
        const extracted = ToolDispatcher.extractWebBrainActionItems(rawAnswer);
        if (extracted.files.length === 0 && extracted.commands.length === 0) {
            return rawAnswer;
        }

        const fileList = extracted.files.length > 0
            ? extracted.files.map((f, i) => `  ${i + 1}. \`write_file\` -> "${f}"`).join('\n')
            : '  (No new code files detected)';

        const cmdList = extracted.commands.length > 0
            ? extracted.commands.slice(0, 8).map((c, i) => `  ${i + 1}. \`execute_terminal_command\` -> "${c}"`).join('\n')
            : '  (No terminal commands detected)';

        const banner = `[WEB BRAIN ACTION CHECKLIST - MANDATORY EXECUTION PROTOCOL]
================================================================================
⚠️ CRITICAL INSTRUCTION FOR AUTONOMOUS AGENT:
Web Brain has provided the complete code and instructions below.
You are strictly FORBIDDEN from stopping, calling finish prematurely, or re-querying Web Brain until EVERY file listed below is written to disk!

📋 REQUIRED FILES TO CREATE / UPDATE:
${fileList}

💻 REQUIRED COMMANDS TO EXECUTE:
${cmdList}

⚡ EXECUTION RULES:
1. Call 'write_file' for each file above sequentially. Copy the FULL implementation from the response below.
2. DO NOT skip any file. DO NOT insert placeholder comments like '// ... rest of code'.
3. DO NOT call 'consult_web_brain' again until all files above are created and all commands run.
================================================================================

`;

        return banner + rawAnswer;
    }
}
