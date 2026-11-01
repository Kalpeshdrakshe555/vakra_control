// src/state/inMemoryTaskPlanner.ts
// Hierarchical 2-Level Session Planner: Macro Roadmap + Expandable Micro Sub-Steps.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export type StepCondition =
    | { kind: 'file_edited'; pathIncludes: string }
    | { kind: 'command_ok'; commandIncludes: string }
    | { kind: 'manual' };

export interface SubStep {
    id: string; // e.g. "1.1", "1.2"
    title: string;
    status: StepStatus;
    note?: string;
    modifiedFiles?: string[];
    logicSummary?: string;
    acceptanceCriteria?: string[];
    attempts?: number;
    verificationResult?: any;
}

export interface PlanStep {
    id: number;
    title: string;
    status: StepStatus;
    subSteps?: SubStep[];
    file?: string;
    command?: string;
    verify?: string;
    condition?: StepCondition;
    note?: string;
    modifiedFiles?: string[];
    logicSummary?: string;
    acceptanceCriteria?: string[];
    attempts?: number;
    verificationResult?: any;
}

export interface ToolEvent {
    tool: string;
    ok: boolean;
    filepath?: string;
    command?: string;
}

const STORAGE_KEY = 'vakra.plan.v2';

export class InMemoryTaskPlanner implements vscode.Disposable {
    private steps: PlanStep[] = [];
    private goal = '';
    private userRequirements = '';
    private planOnlyTurns = 0;
    private workspaceRoot?: string;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(
        private readonly ctx?: vscode.ExtensionContext,
        private readonly postToWebview?: (msg: any) => void
    ) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const root = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;
        if (root) {
            this.workspaceRoot = root;
            this.syncWithDisk(root);
        } else if (ctx) {
            const saved = ctx.workspaceState.get<{ goal: string; userRequirements?: string; steps: PlanStep[] }>(STORAGE_KEY);
            if (saved) {
                this.goal = saved.goal || '';
                this.userRequirements = saved.userRequirements || '';
                this.steps = saved.steps || [];
            }
        }
    }

    /**
     * Reads PLAN.md directly from workspace disk if available.
     */
    public loadFromDisk(workspaceRoot: string): boolean {
        if (!workspaceRoot) return false;
        this.workspaceRoot = workspaceRoot;
        const rootPlan = path.join(workspaceRoot, 'PLAN.md');
        const aiPlan = path.join(workspaceRoot, '.ultra-light-ai', 'PLAN.md');
        const planPath = fs.existsSync(rootPlan) ? rootPlan : (fs.existsSync(aiPlan) ? aiPlan : undefined);
        if (!planPath) return false;

        try {
            const content = fs.readFileSync(planPath, 'utf8');
            if (!content || !content.trim()) return false;

            const lines = content.split('\n');
            let parsingRequirements = false;
            let reqLines: string[] = [];
            const parsedSteps: PlanStep[] = [];
            let currentStep: PlanStep | null = null;

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('# 🎯 User Requirements')) {
                    parsingRequirements = true;
                    continue;
                }
                if (parsingRequirements) {
                    if (trimmed.startsWith('--------------------------------------------------') || trimmed.startsWith('---')) {
                        parsingRequirements = false;
                        continue;
                    }
                    reqLines.push(line);
                    continue;
                }

                // Check for step: [x] Step 1: title or [ ] Step 1.1: title or [>] Step 1: title
                const stepMatch = line.match(/^\s*(\[[ x>]\])\s*Step\s*(\d+(?:\.\d+)?)\s*:\s*(.*)$/i);
                if (stepMatch) {
                    const check = stepMatch[1].toLowerCase();
                    const numStr = stepMatch[2];
                    const title = stepMatch[3].trim();
                    const status: StepStatus = check === '[x]' ? 'done' : (check === '[>]' ? 'active' : 'pending');

                    if (numStr.includes('.')) {
                        // Sub-step (e.g. 1.1)
                        const parentId = parseInt(numStr.split('.')[0], 10);
                        let parent = parsedSteps.find(s => s.id === parentId);
                        if (!parent) {
                            parent = { id: parentId, title: `Step ${parentId}`, status: 'pending', subSteps: [] };
                            parsedSteps.push(parent);
                        }
                        if (!parent.subSteps) parent.subSteps = [];
                        parent.subSteps.push({
                            id: numStr,
                            title,
                            status
                        });
                    } else {
                        // Main step (e.g. 1)
                        const id = parseInt(numStr, 10);
                        currentStep = {
                            id,
                            title,
                            status,
                            subSteps: []
                        };
                        parsedSteps.push(currentStep);
                    }
                }
            }

            if (parsedSteps.length > 0) {
                this.steps = parsedSteps;
                this.userRequirements = reqLines.join('\n').trim();
                this.goal = this.userRequirements.split('\n')[0].slice(0, 200) || 'Task Execution Plan';
                if (this.ctx) {
                    this.ctx.workspaceState.update(STORAGE_KEY, {
                        goal: this.goal,
                        userRequirements: this.userRequirements,
                        steps: this.steps
                    });
                }
                return true;
            }
        } catch (e) {
            console.warn('[InMemoryTaskPlanner] Failed to load PLAN.md from disk:', e);
        }
        return false;
    }

    public syncWithDisk(workspaceRoot?: string): void {
        if (!workspaceRoot) return;
        this.workspaceRoot = workspaceRoot;
        const rootPlan = path.join(workspaceRoot, 'PLAN.md');
        const aiPlan = path.join(workspaceRoot, '.ultra-light-ai', 'PLAN.md');
        const planExists = fs.existsSync(rootPlan) || fs.existsSync(aiPlan);

        if (planExists) {
            this.loadFromDisk(workspaceRoot);
        } else if (this.steps.length > 0) {
            // Memory has plan, ensure disk is synced
            this.commit();
        }
    }

    public getGoal(): string {
        return this.goal;
    }

    public getUserRequirements(): string {
        return this.userRequirements;
    }

    public getSteps(): PlanStep[] {
        return [...this.steps];
    }

    public getPromptPlanSteps(): Array<{ id: number; title: string; done: boolean; file?: string; command?: string; verify?: string }> {
        return this.steps.map(s => ({
            id: s.id,
            title: s.title,
            done: s.status === 'done',
            file: s.file,
            command: s.command,
            verify: s.verify
        }));
    }

    /**
     * Phase 1: Establishes initial High-Level Macro Plan with User Requirements.
     */
    public setMacroPlan(userRequirements: string, stepTitles: string[]): string {
        this.userRequirements = (userRequirements || '').trim();
        this.goal = this.userRequirements.split('\n')[0].slice(0, 200) || 'Task Execution Plan';
        this.steps = stepTitles.map((title, i): PlanStep => ({
            id: i + 1,
            title: title.trim(),
            status: 'pending',
            subSteps: []
        }));
        this.commit();
        return `Macro plan with ${this.steps.length} steps created in PLAN.md.`;
    }

    /**
     * Backwards-compatible setPlan implementation.
     */
    public setPlan(
        goal: string,
        rawSteps: Array<string | { title: string; file?: string; command?: string; verify?: string }>
    ): string {
        const stepTitles = rawSteps.map(s => typeof s === 'string' ? s : s.title);
        return this.setMacroPlan(goal, stepTitles);
    }

    /**
     * Phase 3: Expands the active step into detailed micro sub-steps (e.g. 1.1, 1.2, 1.3).
     */
    public expandStep(stepId: number, subStepTitles: string[]): string {
        if (this.steps.length === 0 && this.workspaceRoot) {
            this.loadFromDisk(this.workspaceRoot);
        }

        let step = this.steps.find(s => s.id === stepId);
        if (!step) {
            step = {
                id: stepId,
                title: `Step ${stepId}`,
                status: 'active',
                subSteps: []
            };
            this.steps.push(step);
            this.steps.sort((a, b) => a.id - b.id);
        }

        step.status = 'active';
        step.subSteps = subStepTitles.map((sub, idx): SubStep => {
            const cleanTitle = sub.replace(/^\d+(\.\d+)?\s*[:\.-]?\s*/, '').trim();
            return {
                id: `${stepId}.${idx + 1}`,
                title: cleanTitle,
                status: idx === 0 ? 'active' : 'pending'
            };
        });

        // Set other non-done steps to pending
        this.steps.forEach(s => {
            if (s.id !== stepId && s.status !== 'done') {
                s.status = 'pending';
            }
        });

        this.commit();
        return `Step ${stepId} expanded with ${step.subSteps.length} sub-steps in PLAN.md.`;
    }

    /**
     * Phase 4: Marks a sub-step or step as completed.
     * When all sub-steps of the active step are completed, marks the parent step as done.
     */
    public completeSubStep(
        subStepId?: string,
        summary?: string,
        modifiedFiles?: string[],
        logicSummary?: string
    ): { parentStepDone: boolean; completedTitle: string; nextActive?: string; parentStepId?: number } {
        if (this.steps.length === 0 && this.workspaceRoot) {
            this.loadFromDisk(this.workspaceRoot);
        }

        // Auto-initialize step 1 if no plan existed yet
        if (this.steps.length === 0) {
            const title = summary || (subStepId ? `Step ${subStepId}` : 'Task Execution');
            this.userRequirements = this.userRequirements || summary || 'Autonomous Task Execution';
            this.goal = this.userRequirements.split('\n')[0].slice(0, 200);
            this.steps.push({
                id: 1,
                title: title,
                status: 'done',
                modifiedFiles: modifiedFiles,
                logicSummary: logicSummary || summary,
                note: summary
            });
            this.commit();
            return {
                parentStepDone: true,
                completedTitle: `Step 1: ${title}`,
                parentStepId: 1
            };
        }

        // Normalize subStepId and find target parent step
        let targetParentId: number | undefined;
        if (subStepId) {
            const clean = String(subStepId).replace(/^step\s*/i, '').trim();
            if (clean.includes('.')) {
                const p = parseInt(clean.split('.')[0], 10);
                if (!isNaN(p)) targetParentId = p;
            } else {
                const p = parseInt(clean, 10);
                if (!isNaN(p)) targetParentId = p;
            }
        }

        let targetStep = targetParentId ? this.steps.find(s => s.id === targetParentId) : undefined;
        if (!targetStep) {
            targetStep = this.steps.find(s => s.status === 'active') || this.steps.find(s => s.status === 'pending') || this.steps[this.steps.length - 1];
        }

        let completedTitle = summary || `Step ${targetStep.id} completed`;

        if (targetStep.subSteps && targetStep.subSteps.length > 0) {
            const cleanSubId = subStepId ? String(subStepId).replace(/^step\s*/i, '').trim() : undefined;
            let targetSub = cleanSubId ? targetStep.subSteps.find(sub => sub.id === cleanSubId) : undefined;
            if (!targetSub) {
                targetSub = targetStep.subSteps.find(sub => sub.status === 'active') || targetStep.subSteps.find(sub => sub.status === 'pending') || targetStep.subSteps[0];
            }

            if (targetSub) {
                targetSub.status = 'done';
                targetSub.note = summary;
                targetSub.modifiedFiles = modifiedFiles;
                targetSub.logicSummary = logicSummary || summary;
                completedTitle = `${targetSub.id}: ${targetSub.title}`;
            }

            // Find next pending sub-step
            const nextSub = targetStep.subSteps.find(sub => sub.status === 'pending');
            if (nextSub) {
                nextSub.status = 'active';
                this.commit();
                return {
                    parentStepDone: false,
                    completedTitle,
                    nextActive: `${nextSub.id}: ${nextSub.title}`,
                    parentStepId: targetStep.id
                };
            } else {
                // All sub-steps in targetStep are finished!
                targetStep.status = 'done';
                targetStep.note = summary;
                const accumulatedFiles = Array.from(new Set([
                    ...(modifiedFiles || []),
                    ...targetStep.subSteps.flatMap(sub => sub.modifiedFiles || [])
                ]));
                if (accumulatedFiles.length > 0) {
                    targetStep.modifiedFiles = accumulatedFiles;
                }
                targetStep.logicSummary = logicSummary || summary;
                this.commit();
                return {
                    parentStepDone: true,
                    completedTitle: `Step ${targetStep.id}: ${targetStep.title}`,
                    parentStepId: targetStep.id
                };
            }
        } else {
            // Direct parent step completion
            targetStep.status = 'done';
            targetStep.note = summary;
            targetStep.modifiedFiles = modifiedFiles;
            targetStep.logicSummary = logicSummary || summary;
            this.commit();
            return {
                parentStepDone: true,
                completedTitle: `Step ${targetStep.id}: ${targetStep.title}`,
                parentStepId: targetStep.id
            };
        }
    }

    /**
     * Legacy updatePlan support.
     */
    public updatePlan(args: { stepId?: number; status?: 'done' | 'dropped' | 'active'; reason?: string; note?: string }): string {
        const res = this.completeSubStep(args.stepId ? String(args.stepId) : undefined, args.note || args.reason);
        return `Step updated in PLAN.md: ${res.completedTitle}`;
    }

    public clear(): void {
        this.steps = [];
        this.goal = '';
        this.userRequirements = '';
        this.planOnlyTurns = 0;
        if (this.ctx) {
            this.ctx.workspaceState.update(STORAGE_KEY, undefined);
        }
        const root = this.workspaceRoot || (vscode.workspace && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined);
        if (root) {
            try {
                const candidates = [
                    path.join(root, '.ultra-light-ai', 'PLAN.md'),
                    path.join(root, 'PLAN.md'),
                    path.join(root, 'plan.md'),
                    path.join(root, 'PLAN.json')
                ];
                for (const c of candidates) {
                    if (fs.existsSync(c)) {
                        try { fs.unlinkSync(c); } catch {}
                    }
                }
            } catch {}
        }
        this.commit();
    }

    /**
     * Writes PLAN.md to disk using the exact User Requirements + Hierarchical format requested.
     */
    public generatePlanMarkdown(): string {
        if (this.steps.length === 0) return '';

        let md = `# 🎯 User Requirements\n`;
        md += `${this.userRequirements || this.goal || 'General implementation goal.'}\n\n`;
        md += `--------------------------------------------------\n`;

        for (const s of this.steps) {
            const check = s.status === 'done' ? '[x]' : (s.status === 'active' ? '[>]' : '[ ]');
            md += `${check} Step ${s.id}: ${s.title}\n`;
            if (s.status === 'done') {
                if (s.modifiedFiles && s.modifiedFiles.length > 0) {
                    md += `      *Modified*: ${s.modifiedFiles.join(', ')}\n`;
                }
                if (s.logicSummary || s.note) {
                    md += `      *Logic & Summary*: ${s.logicSummary || s.note}\n`;
                }
            }
            if (s.subSteps && s.subSteps.length > 0) {
                for (const sub of s.subSteps) {
                    const subCheck = sub.status === 'done' ? '[x]' : (sub.status === 'active' ? '[>]' : '[ ]');
                    md += `      ${subCheck} Step ${sub.id}: ${sub.title}\n`;
                    if (sub.status === 'done' && (sub.logicSummary || sub.note)) {
                        md += `         *Outcome*: ${sub.logicSummary || sub.note}\n`;
                    }
                }
            }
        }
        return md;
    }

    private commit(): void {
        if (this.ctx) {
            this.ctx.workspaceState.update(STORAGE_KEY, {
                goal: this.goal,
                userRequirements: this.userRequirements,
                steps: this.steps
            });
        }
        if (this.postToWebview) {
            this.postToWebview({
                type: 'update_plan_stepper',
                goal: this.userRequirements || this.goal,
                steps: this.steps
            });
        }

        const root = this.workspaceRoot || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined);
        if (root) {
            try {
                const rootPlan = path.join(root, 'PLAN.md');
                const rootPlanJson = path.join(root, 'PLAN.json');
                const legacyPlan = path.join(root, '.ultra-light-ai', 'PLAN.md');

                if (this.steps.length === 0) {
                    if (fs.existsSync(rootPlan)) fs.unlinkSync(rootPlan);
                    if (fs.existsSync(rootPlanJson)) fs.unlinkSync(rootPlanJson);
                    if (fs.existsSync(legacyPlan)) fs.unlinkSync(legacyPlan);
                } else {
                    const md = this.generatePlanMarkdown();
                    fs.writeFileSync(rootPlan, md, 'utf8');
                    try {
                        const jsonPayload = JSON.stringify({
                            goal: this.goal,
                            userRequirements: this.userRequirements,
                            steps: this.steps
                        }, null, 2);
                        fs.writeFileSync(rootPlanJson, jsonPayload, 'utf8');
                    } catch {}
                    // Clean up duplicate legacy plan in .ultra-light-ai if present
                    if (fs.existsSync(legacyPlan)) {
                        try { fs.unlinkSync(legacyPlan); } catch {}
                    }
                }
            } catch (e) {
                console.warn('[InMemoryTaskPlanner] Failed to write PLAN.md:', e);
            }
        }

        this._onDidChange.fire();
    }

    dispose() {
        this._onDidChange.dispose();
    }
}
