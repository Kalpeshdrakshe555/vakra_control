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
import { guardTool } from '../../guards';
import { validateFile, formatValidationReport } from '../../validators';
import { redact, isSecretPath } from '../../security/secretsFilter';
import { getModelProfile } from '../../config/modelProfile';
import { RuntimePlugins } from '../../plugins/runtimePlugins';
import { StateLedger } from '../../state/stateLedger';
import { AgentRoleType } from '../../agents/types';
import { validateRoleToolCall } from '../../agents/permissions';

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
    userPrompt?: string;
    activeRole?: AgentRoleType;
}

export class ToolDispatcher {
    private static consecutiveReadCount = 0;
    private static lastReadFiles: Set<string> = new Set<string>();
    private static lastFailedCommand: string | null = null;
    private static lastCommandErrorText: string = '';
    private static webSearchPerformedForLastError: boolean = false;
    private static filesModifiedSinceLastCommand: boolean = false;

    public static getLastFailedCommand(): string | null {
        return this.lastFailedCommand;
    }

    public static setLastFailedCommand(cmd: string | null): void {
        this.lastFailedCommand = cmd;
    }

    public static clearFailedCommand(): void {
        this.lastFailedCommand = null;
    }

    public static resetSessionState(): void {
        this.consecutiveReadCount = 0;
        this.lastReadFiles.clear();
        this.lastFailedCommand = null;
        this.lastCommandErrorText = '';
        this.webSearchPerformedForLastError = false;
        this.filesModifiedSinceLastCommand = false;
    }

    public static async dispatch(functionCall: any, ctx: ToolExecutionContext): Promise<any> {
        const rawResult = await this.internalDispatch(functionCall, ctx);
        return await RuntimePlugins.afterToolExecute({
            toolName: functionCall.name,
            rawOutput: rawResult,
            workspaceRoot: ctx.workspaceRoot
        });
    }

    private static async internalDispatch(functionCall: any, ctx: ToolExecutionContext): Promise<any> {
        if (ctx.signal?.aborted) {
            return 'Operation cancelled by user.';
        }

        const { workspaceRoot, postMessage } = ctx;
        const name = functionCall?.name || functionCall?.function?.name;
        let args = functionCall?.args ?? functionCall?.arguments ?? functionCall?.function?.arguments ?? {};
        if (typeof args === 'string') {
            try {
                args = JSON.parse(args);
            } catch {}
        }

        // Dual-Layer Role Permission Gate
        if (ctx.activeRole) {
            const roleValidation = validateRoleToolCall(ctx.activeRole, name, args);
            if (!roleValidation.allowed) {
                return `Error: ${roleValidation.error || `Permission denied: Tool '${name}' is not permitted for role '${ctx.activeRole}'.`}`;
            }
        }

        if (name === 'finish') {
            if (this.lastFailedCommand) {
                return `REJECTED: Cannot finish task because command '${this.lastFailedCommand}' failed. You must diagnose the error, fix the relevant file using edit_file/write_file, and verify the fix before calling finish.`;
            }
            if (ctx.taskPlanner && typeof ctx.taskPlanner.getSteps === 'function') {
                const steps = ctx.taskPlanner.getSteps() || [];
                const incomplete = steps.filter((s: any) => {
                    if (s.status !== 'done') return true;
                    if (s.subSteps && s.subSteps.length > 0) {
                        return s.subSteps.some((sub: any) => sub.status !== 'done');
                    }
                    return false;
                });
                if (incomplete.length > 0) {
                    const stepSummary = incomplete.map((s: any) => `Step ${s.id}: ${s.title} [${s.status}]`).join(', ');
                    return `REJECTED: Cannot finish task because the following plan steps are incomplete: ${stepSummary}. All planned steps must be executed and marked done before calling finish.`;
                }
            }
            const summary = args.summary || 'Task completed successfully.';
            if (workspaceRoot) {
                SessionMemory.getInstance(workspaceRoot).recordToolResult('finish', args, summary, true);
            }
            return summary;
        }

        if (name === 'set_task_plan') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const rawSteps = args.steps || args.plan || [];
            const stepList = (Array.isArray(rawSteps) ? rawSteps : [rawSteps]).filter(Boolean).map((s: any) => typeof s === 'string' ? s.trim() : (s.title || s.step || ''));

            if (stepList.length === 0) {
                return "Error: 'steps' must be a non-empty array of high-level macro steps (e.g. ['Step 1: Setup Models', 'Step 2: Create Views', 'Step 3: Map URLs']).";
            }

            const userRequirements = args.user_requirements || args.requirements || ctx.userPrompt || 'Project Goal';
            const goal = args.goal || userRequirements.split('\n')[0].slice(0, 200);

            if (ctx.taskPlanner) {
                if (typeof ctx.taskPlanner.syncWithDisk === 'function') {
                    ctx.taskPlanner.syncWithDisk(workspaceRoot);
                }
                if (typeof ctx.taskPlanner.setMacroPlan === 'function') {
                    try {
                        ctx.taskPlanner.setMacroPlan(userRequirements, stepList);
                    } catch (e) {
                        console.error('Failed to update InMemoryTaskPlanner:', e);
                    }
                } else if (typeof ctx.taskPlanner.setPlan === 'function') {
                    try {
                        ctx.taskPlanner.setPlan(goal, stepList);
                    } catch (e) {}
                }
            }

            const planSteps = stepList.map((s, idx) => ({
                id: idx + 1,
                title: s,
                done: false
            }));

            if (ctx.currentTaskState) {
                ctx.currentTaskState.plan = planSteps;
                ctx.currentTaskState.phase = 'plan_approval';
            }

            postMessage({
                command: 'toolCallEvent',
                tool: 'set_task_plan',
                title: `High-Level Plan Established (${planSteps.length} Steps)`,
                data: {
                    userRequirements,
                    steps: planSteps.map(p => p.title)
                }
            });

            try {
                StateLedger.sync(workspaceRoot, {
                    goal: userRequirements,
                    steps: planSteps.map(p => ({
                        id: p.id,
                        title: p.title,
                        status: 'pending'
                    })),
                    latestActionSummary: `Macro plan established with ${planSteps.length} steps. Awaiting user approval.`
                });
            } catch (e) {
                console.error('[StateLedger] Sync error on set_task_plan:', e);
            }

            const planMarkdown = `# 🎯 User Requirements\n${userRequirements}\n--------------------------------------------------\n` + planSteps.map(p => `[ ] Step ${p.id}: ${p.title}`).join('\n');

            return `[PLAN.MD ESTABLISHED IN WORKSPACE]:\n\n${planMarkdown}\n\n🛑 STOP AND SHOW PLAN TO USER NOW:\nPresent this plan clearly to the user in your response and ask:\n"I have prepared this implementation plan based on your requirements. Please review and confirm if this looks good to proceed or if you would like any changes."\n\n⚠️ CRITICAL DIRECTIVE: DO NOT execute any code, file edits, or terminal commands until the user responds and approves this plan! Once the user approves, you will call 'expand_plan_step' to expand Step 1 into detailed micro sub-steps.`;
        }

        if (name === 'expand_plan_step') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const stepId = typeof args.step_id === 'number' ? args.step_id : parseInt(String(args.step_id || '1'), 10) || 1;
            const rawSubSteps = args.sub_steps || args.steps || [];
            const subStepList = (Array.isArray(rawSubSteps) ? rawSubSteps : [rawSubSteps]).filter(Boolean).map((s: any) => typeof s === 'string' ? s.trim() : (s.title || s.step || ''));

            if (subStepList.length === 0) {
                return "Error: 'sub_steps' must be a non-empty array of detailed micro steps (e.g. ['Step 1.1: Create Profile model', 'Step 1.2: Add migrations']).";
            }

            if (ctx.taskPlanner) {
                if (typeof ctx.taskPlanner.syncWithDisk === 'function') {
                    ctx.taskPlanner.syncWithDisk(workspaceRoot);
                }
                if (typeof ctx.taskPlanner.expandStep === 'function') {
                    ctx.taskPlanner.expandStep(stepId, subStepList);
                }
            }

            if (ctx.currentTaskState) {
                ctx.currentTaskState.activeStepId = stepId;
                ctx.currentTaskState.phase = 'execute';
            }

            postMessage({
                command: 'toolCallEvent',
                tool: 'expand_plan_step',
                title: `Step ${stepId} Expanded (${subStepList.length} Sub-Steps)`,
                data: { stepId, subSteps: subStepList }
            });

            const subStepsFormatted = subStepList.map((s, idx) => `      [ ] Step ${stepId}.${idx + 1}: ${s}`).join('\n');

            return `[STEP ${stepId} EXPANDED IN PLAN.MD]:\n${subStepsFormatted}\n\n👉 CURRENT ACTIVE SUB-STEP: Step ${stepId}.1\n\n⚡ MANDATORY SUB-STEP REASONING: Before writing or editing any code, output a 2-3 line [STEP ${stepId}.1 BLUEPRINT] stating:\n1. Target file and exact functions/classes to add or modify\n2. Logic, types, and imports\n3. Verification command\nThen execute Step ${stepId}.1 and immediately call complete_plan_step upon completion.`;
        }

        if (name === 'complete_plan_step') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const rawSubId = args.sub_step_id ?? args.subStepId ?? args.sub_step ?? args.step_id ?? args.stepId ?? args.step ?? args.id ?? args.step_number;
            const subStepId = rawSubId !== undefined && rawSubId !== null ? String(rawSubId) : undefined;
            const summary = args.summary || args.title || args.note || args.description || 'Step completed';
            const rawFiles = args.modified_files || args.files || args.modifiedFiles || args.touched_files;
            const modifiedFiles = rawFiles ? (Array.isArray(rawFiles) ? rawFiles.map(String) : [String(rawFiles)]) : undefined;
            const logicSummary = args.logic_summary || args.logicSummary || args.logic || summary;

            let completionResult: { parentStepDone: boolean; completedTitle: string; nextActive?: string; parentStepId?: number } = {
                parentStepDone: false,
                completedTitle: summary
            };

            if (ctx.taskPlanner) {
                if (typeof ctx.taskPlanner.syncWithDisk === 'function') {
                    ctx.taskPlanner.syncWithDisk(workspaceRoot);
                }
                if (typeof ctx.taskPlanner.completeSubStep === 'function') {
                    try {
                        completionResult = ctx.taskPlanner.completeSubStep(subStepId, summary, modifiedFiles, logicSummary);
                    } catch (e) {
                        console.error('Failed to complete sub-step in InMemoryTaskPlanner:', e);
                    }
                } else if (typeof ctx.taskPlanner.updatePlan === 'function') {
                    try {
                        ctx.taskPlanner.updatePlan({ stepId: subStepId ? parseInt(subStepId, 10) : undefined, status: 'done', note: summary });
                    } catch (e) {}
                }
            }

            const completedTitle = completionResult.completedTitle || summary;
            SessionMemory.getInstance(workspaceRoot).recordSubTaskDone(completedTitle);

            postMessage({
                command: 'toolCallEvent',
                tool: 'complete_plan_step',
                title: completionResult.parentStepDone ? `Finished Step ${completionResult.parentStepId || ''}` : `Done: ${completedTitle}`,
                data: { completedTitle, summary, parentStepDone: completionResult.parentStepDone }
            });

            try {
                StateLedger.sync(workspaceRoot, {
                    goal: ctx.userPrompt,
                    latestActionSummary: completionResult.parentStepDone 
                        ? `Finished Step ${completionResult.parentStepId || ''}: ${completedTitle}`
                        : `Sub-step completed: ${completedTitle}`
                });
            } catch (e) {}

            // CRITICAL USER HANDOFF: When ALL sub-steps of a parent step are completed, STOP AND WAIT FOR USER INPUT!
            if (completionResult.parentStepDone) {
                const finishedId = completionResult.parentStepId || 1;
                const nextStepId = finishedId + 1;

                return `🎉 ALL SUB-STEPS FOR STEP ${finishedId} ARE COMPLETE!\n[x] Step ${finishedId} is now verified and marked complete in PLAN.md.\n\n🛑 STOP AND HANDOFF TO USER:\nOutput a clean, concise summary of what was completed and verified in Step ${finishedId}.\nThen ask the user:\n"Step ${finishedId} has been successfully completed and PLAN.md is updated. Shall we proceed to Step ${nextStepId}?"\n\n⚠️ DO NOT EXECUTE OR START STEP ${nextStepId} UNTIL THE USER RESPONDS!`;
            }

            // Otherwise, advance to the next active sub-step within the same parent step
            const nextActiveSub = completionResult.nextActive || 'Next Sub-Step';
            return `✅ Sub-step completed: "${completedTitle}" in PLAN.md.\n\n👉 NEXT ACTIVE SUB-STEP: "${nextActiveSub}".\n\n⚡ Formulate your 2-3 line [BLUEPRINT] for ${nextActiveSub}, make the edit, verify, and call complete_plan_step.`;
        }

        if (name === 'read_state_ledger') {
            if (!workspaceRoot) return "Error: No workspace open.";
            const planPath = path.join(workspaceRoot, '.ultra-light-ai', 'PLAN.md');
            let ledgerContent = '';
            if (fs.existsSync(planPath)) {
                ledgerContent = fs.readFileSync(planPath, 'utf8');
            } else {
                ledgerContent = StateLedger.read(workspaceRoot);
            }
            postMessage({
                command: 'toolCallEvent',
                tool: 'read_state_ledger',
                title: 'Consulted Plan & Architecture (PLAN.md)',
                data: { length: ledgerContent.length }
            });
            return ledgerContent;
        }

        if (name === 'read_multiple_files') {
            if (!workspaceRoot) return "Error: No workspace open.";
            let filepaths: string[] = [];
            if (Array.isArray(args.paths)) {
                filepaths = args.paths;
            } else if (Array.isArray(args.filepaths)) {
                filepaths = args.filepaths;
            } else if (Array.isArray(args.files)) {
                filepaths = args.files;
            } else if (typeof args.filepath === 'string') {
                filepaths = [args.filepath];
            } else if (typeof args.path === 'string') {
                filepaths = [args.path];
            } else {
                return "Error: 'paths' must be an array of file paths.";
            }

            const startLine = typeof args.start_line === 'number' ? Math.max(1, args.start_line) : undefined;
            const endLine = typeof args.end_line === 'number' ? Math.max(1, args.end_line) : undefined;

            let targetFilepaths: string[] = filepaths.slice(0, 3);
            const joinedKey = targetFilepaths.slice().sort().join('|') + `:${startLine || 0}-${endLine || 0}`;
            if (this.lastReadFiles.has(joinedKey) && !this.filesModifiedSinceLastCommand) {
                return `Notice: File section [${targetFilepaths.join(', ')}] was already inspected recently and has not been modified. Please proceed to writing/editing code or running a verification check.`;
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

                // Priority 1: Check sensitive/secret file access
                const relPath = path.relative(workspaceRoot, fullPath);
                let isSecret = isSecretPath(fp, workspaceRoot) || isSecretPath(relPath, workspaceRoot);
                if (!isSecret && fs.existsSync(fullPath)) {
                    try {
                        const realPath = fs.realpathSync(fullPath);
                        if (isSecretPath(realPath, workspaceRoot)) {
                            isSecret = true;
                        }
                    } catch (_) {}
                }

                if (isSecret) {
                    combinedResult += `\n--- File: ${fp} (ACCESS DENIED: Sensitive credential or secret file restricted by security policy) ---\n`;
                    continue;
                }

                if (!fs.existsSync(fullPath)) {
                    combinedResult += `\n--- File: ${fp} (Not Found) ---\n`;
                    continue;
                }

                try {
                    const st = fs.statSync(fullPath);
                    if (st.isDirectory()) {
                        combinedResult += `\n--- File: ${fp} (Is a Directory. Use list_directory_tree to view directory contents) ---\n`;
                        continue;
                    }
                } catch (_) {}

                const rawContent = fs.readFileSync(fullPath, 'utf8');
                // Defense-in-depth: redact accidental credentials from outbound content
                const safeContent = redact(rawContent).text;
                const allLines = safeContent.split(/\r?\n/);
                const totalLines = allLines.length;

                // Case A: Specific line range or chunk requested
                if (startLine !== undefined || endLine !== undefined) {
                    const s = Math.max(1, startLine || 1);
                    const maxChunk = 1500;
                    const requestedEnd = endLine !== undefined ? endLine : (s + maxChunk - 1);
                    const e = Math.min(totalLines, requestedEnd);
                    const slicedLines = allLines.slice(s - 1, e).map((line, idx) => `${s + idx} | ${line}`).join('\n');
                    const hasMore = e < totalLines;
                    const chunkNotice = hasMore
                        ? `\n[NOTE: Displaying lines ${s}-${e} of ${totalLines}. Use start_line=${e + 1} and end_line=${Math.min(totalLines, e + maxChunk)} to read the next chunk.]`
                        : '';
                    combinedResult += `\n--- File: ${fp} (Lines ${s}-${e} of ${totalLines}) ---\n${slicedLines}${chunkNotice}\n`;
                    continue;
                }

                // Full code inspection: Deliver all lines up to 1,500 lines directly with line numbers
                const numbered = allLines.slice(0, 1500).map((line, idx) => `${idx + 1} | ${line}`).join('\n');
                const notice = totalLines > 1500
                    ? `\n[NOTE: Displaying first 1500 of ${totalLines} lines. Call with start_line=1501 and end_line=${Math.min(totalLines, 3000)} to inspect the next chunk.]`
                    : '';
                combinedResult += `\n--- File: ${fp} (${totalLines} lines) ---\n${numbered}${notice}\n`;
                continue;
            }

            SessionMemory.getInstance(workspaceRoot).recordToolResult('read_multiple_files', args, 'Files inspected', true);
            return combinedResult;
        }

        if (name === 'write_file') {
            this.consecutiveReadCount = 0;
            this.lastReadFiles.clear();
            if (!workspaceRoot) return "Error: No workspace open.";
            const { filepath } = args;
            if (!filepath || typeof filepath !== 'string' || !filepath.trim()) {
                return "Error: filepath is required.";
            }

            postMessage({
                command: 'statusUpdate',
                text: `Writing file: ${filepath}...`
            });
            let content = args.content || '';
            content = content.replace(/^```[a-zA-Z]*\r?\n/, '').replace(/\r?\n```$/, '');

            const safeCheck = resolveSafeWorkspacePath(filepath, workspaceRoot, false);
            if (!safeCheck.safe) return `Invalid path: ${filepath}`;
            if (isSecretPath(filepath, workspaceRoot)) {
                return `ACCESS DENIED: Modifying sensitive credential file '${filepath}' is restricted by security policy.`;
            }
            const fullPath = safeCheck.resolvedPath;

            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
                return `Error: Path '${filepath}' is a directory, not a file.`;
            }

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

            const applyWriteToDisk = async (): Promise<string | null> => {
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

                // Execute Runtime Plugin afterFileWrite syntax guard
                const pluginCheck = await RuntimePlugins.afterFileWrite({
                    filePath: fullPath,
                    fileContent: content,
                    oldContent: fileAlreadyExists ? oldContent : null,
                    workspaceRoot
                });
                if (!pluginCheck.success && pluginCheck.revertRequested) {
                    return pluginCheck.feedback || 'File syntax error detected. Reverted.';
                }

                SessionMemory.getInstance(workspaceRoot).recordToolResult('write_file', args, 'File written successfully', true);
                this.filesModifiedSinceLastCommand = true;
                LivingIndex.refreshBlueprint(workspaceRoot).catch(() => {});
                return null;
            };

            const getValidationSuffix = async (): Promise<string> => {
                if (workspaceRoot) {
                    const valResults = await validateFile(fullPath, { workspaceRoot });
                    return formatValidationReport(fullPath, valResults);
                }
                return '';
            };

            // If session is already auto-approved, write immediately
            if (ctx.isEditSessionAutoApproved) {
                const writeErr = await applyWriteToDisk();
                if (writeErr) return writeErr;
                postMessage({
                    command: 'toolCallEvent',
                    tool: 'write_file',
                    title: fileAlreadyExists ? 'Updated File' : 'Created File',
                    data: { callId, filepath, content, oldContent, length: content.length, isNew: !fileAlreadyExists, isAutoApproved: true }
                });
                const valSuffix = await getValidationSuffix();
                return `Successfully wrote file: ${filepath} (${content.length} characters).${blastRadiusMsg}${valSuffix}`;
            }

            // Otherwise, pause and wait for user card approval
            postMessage({
                command: 'toolCallEvent',
                tool: 'write_file',
                title: fileAlreadyExists ? 'Update File Request' : 'Create File Request',
                data: { callId, filepath, content, oldContent, length: content.length, isNew: !fileAlreadyExists, isAutoApproved: false }
            });

            return await new Promise<string>((resolve) => {
                let abortHandler: (() => void) | null = null;
                if (ctx.signal) {
                    if (ctx.signal.aborted) {
                        ctx.pendingEditResolvers?.delete(callId);
                        resolve('Operation cancelled by user.');
                        return;
                    }
                    abortHandler = () => {
                        ctx.pendingEditResolvers?.delete(callId);
                        resolve('Operation cancelled by user.');
                    };
                    ctx.signal.addEventListener('abort', abortHandler, { once: true });
                }
                ctx.pendingEditResolvers?.set(callId, async (approved, autoApproveSession) => {
                    if (abortHandler && ctx.signal) {
                        ctx.signal.removeEventListener('abort', abortHandler);
                    }
                    if (autoApproveSession) ctx.isEditSessionAutoApproved = true;
                    if (!approved) {
                        resolve(`User rejected write operation for ${filepath}.`);
                        return;
                    }
                    const writeErr = await applyWriteToDisk();
                    if (writeErr) {
                        resolve(writeErr);
                        return;
                    }
                    const valSuffix = await getValidationSuffix();
                    resolve(`Successfully wrote file: ${filepath} (${content.length} characters).${blastRadiusMsg}${valSuffix}`);
                });
            });
        }

        if (name === 'edit_file') {
            this.consecutiveReadCount = 0;
            this.lastReadFiles.clear();
            if (!workspaceRoot) return "Error: No workspace open.";
            const { filepath } = args;
            if (!filepath || typeof filepath !== 'string' || !filepath.trim()) {
                return "Error: filepath is required.";
            }

            postMessage({
                command: 'statusUpdate',
                text: `Editing file: ${filepath}...`
            });
            const oldText = args.old_text ?? args.oldText;
            const newText = args.new_text ?? args.newText;
            const startLine = typeof args.start_line === 'number' ? args.start_line : (typeof args.startLine === 'number' ? args.startLine : undefined);
            const endLine = typeof args.end_line === 'number' ? args.end_line : (typeof args.endLine === 'number' ? args.endLine : undefined);

            if (typeof newText !== 'string' || (typeof oldText !== 'string' && startLine === undefined)) {
                return "Error: Both 'old_text' and 'new_text' strings are required for edit_file (or provide 'start_line'/'end_line' with 'new_text').";
            }

            const safeCheck = resolveSafeWorkspacePath(filepath, workspaceRoot, false);
            if (!safeCheck.safe) return `Invalid path: ${filepath}`;
            if (isSecretPath(filepath, workspaceRoot)) {
                return `ACCESS DENIED: Modifying sensitive credential file '${filepath}' is restricted by security policy.`;
            }
            const fullPath = safeCheck.resolvedPath;

            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
                return `Error: Path '${filepath}' is a directory, not a file.`;
            }

            if (!fs.existsSync(fullPath)) return `Error: File not found: ${filepath}`;

            let fileContent = fs.readFileSync(fullPath, 'utf8');

            // 0. Line-numbered replacement fallback (Extremely reliable for small models)
            let matchedOldText = null;
            if (startLine !== undefined) {
                const lines = fileContent.split(/\r?\n/);
                const s = Math.max(1, startLine);
                const e = Math.min(lines.length, endLine !== undefined ? endLine : s);
                if (s <= lines.length) {
                    matchedOldText = lines.slice(s - 1, e).join('\n');
                    fileContent = lines.join('\n');
                }
            }

            // 1. Try exact match
            if (!matchedOldText && typeof oldText === 'string') {
                if (fileContent.includes(oldText)) {
                    matchedOldText = oldText;
                } else {
                    // 2. Try normalized line endings (Windows CRLF vs LF)
                    const normFile = fileContent.replace(/\r\n/g, '\n');
                    const normOld = oldText.replace(/\r\n/g, '\n');
                    if (normFile.includes(normOld)) {
                        fileContent = normFile;
                        matchedOldText = normOld;
                    } else {
                        // 3. Line-by-line trimmed fallback match (ignores trailing spaces / indentation quirks)
                        const fileLines = fileContent.split(/\r?\n/);
                        const oldLines = oldText.split(/\r?\n/).map(l => l.trimEnd());

                        if (oldLines.length > 0 && oldLines[0].trim().length > 0) {
                            let foundIdx = -1;
                            for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
                                let match = true;
                                for (let j = 0; j < oldLines.length; j++) {
                                    if (fileLines[i + j].trimEnd() !== oldLines[j]) {
                                        match = false;
                                        break;
                                    }
                                }
                                if (match) {
                                    foundIdx = i;
                                    break;
                                }
                            }

                            if (foundIdx !== -1) {
                                fileContent = fileLines.join('\n');
                                matchedOldText = fileLines.slice(foundIdx, foundIdx + oldLines.length).join('\n');
                            }
                        }
                    }
                }
            }

            if (!matchedOldText) {
                // Unblock re-reads so the model is NEVER trapped in a blind loop!
                this.lastReadFiles.clear();
                this.consecutiveReadCount = 0;
                const sampleLines = fileContent.split(/\r?\n/).slice(0, 35).map((l, i) => `${i + 1}: ${l}`).join('\n');
                return `edit_file failed: old_text snippet was not found in ${filepath}.\n[DIAGNOSTIC]: File has been unlocked. Inspect the exact line content below and provide the matching lines:\n${sampleLines.slice(0, 900)}`;
            }

            const newContent = fileContent.replace(matchedOldText, newText);
            const callId = 'edit_' + Date.now();

            const applyEditToDisk = async (): Promise<string | null> => {
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

                // Execute Runtime Plugin afterFileWrite syntax guard
                const pluginCheck = await RuntimePlugins.afterFileWrite({
                    filePath: fullPath,
                    fileContent: newContent,
                    oldContent: fileContent,
                    workspaceRoot
                });
                if (!pluginCheck.success && pluginCheck.revertRequested) {
                    return pluginCheck.feedback || 'File syntax error detected. Reverted.';
                }

                SessionMemory.getInstance(workspaceRoot).recordToolResult('edit_file', args, 'File patch applied successfully', true);
                this.filesModifiedSinceLastCommand = true;
                LivingIndex.refreshBlueprint(workspaceRoot).catch(() => {});
                return null;
            };

            let blastRadiusMsg = '';
            try {
                const dependents = DependencyGraph.getDependents(fullPath, workspaceRoot);
                if (dependents && dependents.length > 0) {
                    const relDependents = dependents.slice(0, 5).map(d => path.relative(workspaceRoot, d).replace(/\\/g, '/'));
                    blastRadiusMsg = `\n[BLAST RADIUS NOTICE: The following files import this file: ${relDependents.join(', ')}. If you changed schemas, function signatures, or exports, verify whether these dependent files need updates.]`;
                }
            } catch {}

            const getValidationSuffix = async (): Promise<string> => {
                if (workspaceRoot) {
                    const valResults = await validateFile(fullPath, { workspaceRoot });
                    return formatValidationReport(fullPath, valResults);
                }
                return '';
            };

            // If session is already auto-approved, apply edit immediately
            if (ctx.isEditSessionAutoApproved) {
                const editErr = await applyEditToDisk();
                if (editErr) return editErr;
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
                const valSuffix = await getValidationSuffix();
                return `Successfully edited file: ${filepath}.${blastRadiusMsg}${valSuffix}`;
            }

            // Otherwise, pause and wait for user card approval in the trusted execution layer
            postMessage({
                command: 'toolCallEvent',
                tool: 'edit_file',
                title: 'Edit File Request',
                data: {
                    callId,
                    filepath,
                    oldText,
                    newText,
                    content: newContent,
                    oldContent: fileContent,
                    hasDiff: true,
                    isAutoApproved: false
                }
            });

            return await new Promise<string>((resolve) => {
                let abortHandler: (() => void) | null = null;
                if (ctx.signal) {
                    if (ctx.signal.aborted) {
                        ctx.pendingEditResolvers?.delete(callId);
                        resolve('Operation cancelled by user.');
                        return;
                    }
                    abortHandler = () => {
                        ctx.pendingEditResolvers?.delete(callId);
                        resolve('Operation cancelled by user.');
                    };
                    ctx.signal.addEventListener('abort', abortHandler, { once: true });
                }
                ctx.pendingEditResolvers?.set(callId, async (approved, autoApproveSession) => {
                    if (abortHandler && ctx.signal) {
                        ctx.signal.removeEventListener('abort', abortHandler);
                    }
                    if (autoApproveSession) ctx.isEditSessionAutoApproved = true;
                    if (!approved) {
                        resolve(`User rejected edit operation for ${filepath}.`);
                        return;
                    }
                    const editErr = await applyEditToDisk();
                    if (editErr) {
                        resolve(editErr);
                        return;
                    }
                    const valSuffix = await getValidationSuffix();
                    resolve(`Successfully edited file: ${filepath}.${blastRadiusMsg}${valSuffix}`);
                });
            });
        }

        if (name === 'execute_terminal_command') {
            this.consecutiveReadCount = 0;
            if (!workspaceRoot) return "Error: No workspace open.";
            const { command } = args;
            if (!command) return "Error: command is required.";

            const trimmed = command.trim();
            if (TerminalCapture.isDaemonCommand(trimmed)) {
                return `BLOCKED: '${trimmed}' is a continuous/daemon process and cannot run synchronously in tool execution. Use non-blocking verification instead (e.g. build, lint, check, or test scripts).`;
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
                const res = await TerminalCapture.runAndCapture(cmd, workspaceRoot, { signal: ctx.signal });
                const isSuccess = res.exitCode === 0 && !res.error;
                if (isSuccess) {
                    this.lastFailedCommand = null;
                } else {
                    this.lastFailedCommand = cmd;
                }
                SessionMemory.getInstance(workspaceRoot).recordToolResult('execute_terminal_command', args, res.output || (res.error ? 'Error' : '') || '', isSuccess);
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
                let abortListener: (() => void) | null = null;
                if (ctx.signal) {
                    abortListener = () => {
                        TerminalCapture.cancelActive();
                        resolve('Operation cancelled by user.');
                    };
                    ctx.signal.addEventListener('abort', abortListener, { once: true });
                }
                ctx.pendingTerminalResolvers.set(callId, (resText) => {
                    if (abortListener && ctx.signal) {
                        ctx.signal.removeEventListener('abort', abortListener);
                    }
                    const isSuccess = !resText.includes('FAILED') && !resText.includes('SKIPPED');
                    if (isSuccess) {
                        this.lastFailedCommand = null;
                    } else {
                        this.lastFailedCommand = cmd;
                    }
                    SessionMemory.getInstance(workspaceRoot).recordToolResult('execute_terminal_command', args, resText, isSuccess);
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
                let results: string | null = null;
                if (ctx.ragEngine && typeof ctx.ragEngine.searchWithSnippets === 'function') {
                    const snippets = ctx.ragEngine.searchWithSnippets(query, 5);
                    if (snippets && snippets.length > 0) {
                        results = snippets.map((s: any) => s.snippet).join('\n\n---\n\n');
                    }
                }

                if (!results) {
                    results = await ToolRegistry.executeTool('search_codebase', JSON.stringify({ query }), workspaceRoot);
                }

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

        if (name === 'get_code_diagnostics') {
            try {
                const fp = args?.filepath || args?.path;
                if (fp && workspaceRoot) {
                    const targetUri = vscode.Uri.file(path.resolve(workspaceRoot, fp));
                    const diags = vscode.languages.getDiagnostics(targetUri);
                    const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                    if (errors.length === 0) return 'No active compiler or syntax errors found in target file.';
                    return errors.map(d => `[Line ${d.range.start.line + 1}] Error: ${d.message}`).join('\n');
                } else {
                    const allDiags = vscode.languages.getDiagnostics();
                    const errors: Array<{ uri: vscode.Uri; d: vscode.Diagnostic }> = [];
                    for (const [uri, diags] of allDiags) {
                        for (const d of diags) {
                            if (d.severity === vscode.DiagnosticSeverity.Error) {
                                errors.push({ uri, d });
                            }
                        }
                    }
                    if (errors.length === 0) return 'No active compiler or syntax errors found in workspace.';
                    return errors.slice(0, 15).map(({ uri, d }) => `[${workspaceRoot ? path.relative(workspaceRoot, uri.fsPath) : uri.fsPath}:${d.range.start.line + 1}] Error: ${d.message}`).join('\n');
                }
            } catch (err) {
                return 'No active compiler or syntax errors found in workspace.';
            }
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
            this.webSearchPerformedForLastError = true;
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

        if (ToolRegistry.hasTool(name)) {
            try {
                const rawArgs = typeof args === 'string' ? args : JSON.stringify(args || {});
                return await ToolRegistry.executeTool(name, rawArgs, workspaceRoot);
            } catch (err: any) {
                return `Error executing tool '${name}': ${err?.message || err}`;
            }
        }

        return `Error: Unknown or unsupported tool '${name}'.`;
    }
}
