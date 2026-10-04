// src/state/inMemoryTaskPlanner.ts
// Session plan that lives in memory / extension state, streams to the webview, and never touches workspace files.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

/** Harness-checkable completion condition, so the model never has to manually edit checkboxes. */
export type StepCondition =
    | { kind: 'file_edited'; pathIncludes: string }
    | { kind: 'command_ok'; commandIncludes: string }
    | { kind: 'manual' }; // advanced by model via plan_done or by the user

export interface PlanStep {
    id: number;
    title: string;
    status: StepStatus;
    condition: StepCondition;
    note?: string;
}

export interface ToolEvent {
    tool: string;
    ok: boolean;
    filepath?: string;
    command?: string;
}

const STORAGE_KEY = 'vakra.plan.v1';

export class InMemoryTaskPlanner implements vscode.Disposable {
    private steps: PlanStep[] = [];
    private goal = '';
    private planOnlyTurns = 0;
    private readonly maxPlanOnlyTurns = 2;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(
        private readonly ctx?: vscode.ExtensionContext,
        private readonly postToWebview?: (msg: any) => void
    ) {
        if (ctx) {
            // Restore across reloads from workspaceState ONLY IF disk plan actually exists
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const root = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;
            const planPath = root ? path.join(root, '.ultra-light-ai', 'PLAN.md') : undefined;

            if (planPath && fs.existsSync(planPath)) {
                const saved = ctx.workspaceState.get<{ goal: string; steps: PlanStep[] }>(STORAGE_KEY);
                if (saved) {
                    this.goal = saved.goal || '';
                    this.steps = saved.steps || [];
                }
            } else {
                ctx.workspaceState.update(STORAGE_KEY, undefined);
                this.goal = '';
                this.steps = [];
            }
        }
    }

    /** Purges stale plan from memory if the disk plan was deleted or workspace was cleared. */
    syncWithDisk(workspaceRoot?: string): void {
        if (!workspaceRoot) return;
        const planPath = path.join(workspaceRoot, '.ultra-light-ai', 'PLAN.md');
        if (!fs.existsSync(planPath)) {
            this.clear();
        }
    }

    /* ---------------- model-facing tools ---------------- */

    private lastArchitecture?: { overview?: string; database?: string; ui_ux?: string; component_flow?: string };

    /** plan_set: Sets or re-initializes the execution steps with architecture documentation. */
    setPlan(
        goal: string,
        rawSteps: Array<string | { title: string; file?: string; command?: string; verify?: string }>,
        architecture?: { overview?: string; database?: string; ui_ux?: string; component_flow?: string }
    ): string {
        const steps = rawSteps.slice(0, 10).map((s, i): PlanStep => {
            const o = typeof s === 'string' ? { title: s } : s;
            const checkCmd = (o as any).verify || o.command;
            const condition: StepCondition = o.file ? { kind: 'file_edited', pathIncludes: o.file }
                : checkCmd ? { kind: 'command_ok', commandIncludes: checkCmd }
                : { kind: 'manual' };
            return { id: i + 1, title: (o.title || '').slice(0, 160), status: i === 0 ? 'active' : 'pending', condition };
        });
        if (!steps.length) return 'Plan must contain at least one step.';
        this.goal = (goal || '').slice(0, 300);
        this.steps = steps;
        this.lastArchitecture = architecture;
        this.planOnlyTurns = 0;
        this.commit();
        return `Plan created with ${steps.length} steps in PLAN.md. Start step 1 now: ${steps[0].title}`;
    }

    /** plan_done: for 'manual' steps only. */
    markCurrentDone(note?: string): string {
        const cur = this.current();
        if (!cur) return 'No active step.';
        cur.status = 'done';
        cur.note = note?.slice(0, 200);
        this.advance();
        this.commit();
        const next = this.current();
        return next ? `Step ${cur.id} done. Next: ${next.title}` : 'All steps done. Call final_answer.';
    }

    /** plan_update: updates step status, marks done, drops superseded steps, or updates plan on pivot. */
    updatePlan(args: { stepId?: number; status?: 'done' | 'dropped' | 'active'; reason?: string; note?: string; steps?: Array<string | { title: string; file?: string; command?: string }> }): string {
        this.planOnlyTurns = 0;
        if (args.steps && Array.isArray(args.steps) && args.steps.length > 0) {
            const completed = this.steps.filter(s => s.status === 'done');
            let nextId = completed.length ? Math.max(...completed.map(s => s.id)) + 1 : 1;
            const newMappedSteps: PlanStep[] = args.steps.slice(0, 8).map((s, idx) => {
                const o = typeof s === 'string' ? { title: s } : s;
                const checkCmd = (o as any).verify || o.command;
                const condition: StepCondition = o.file ? { kind: 'file_edited', pathIncludes: o.file }
                    : checkCmd ? { kind: 'command_ok', commandIncludes: checkCmd }
                    : { kind: 'manual' };
                return {
                    id: nextId + idx,
                    title: (o.title || '').slice(0, 120),
                    status: (idx === 0 && !completed.some(c => c.status === 'active')) ? 'active' : 'pending',
                    condition
                };
            });
            this.steps = [...completed, ...newMappedSteps];
            this.commit();
            return `Plan updated with ${newMappedSteps.length} new steps (${completed.length} finished steps preserved).`;
        }

        const target = args.stepId ? this.steps.find(s => s.id === args.stepId) : this.current();
        if (!target) {
            return 'No matching step to update.';
        }

        if (args.status === 'dropped' || args.reason) {
            target.status = 'skipped';
            target.note = args.reason || args.note || 'Dropped by plan_update';
            this.advance();
            this.commit();
            const next = this.current();
            return next ? `Step ${target.id} dropped. Next active step is ${next.id}: ${next.title}` : 'All remaining steps completed or dropped. Call final_answer.';
        }

        target.status = 'done';
        target.note = args.note?.slice(0, 200);
        this.advance();
        this.commit();
        const next = this.current();
        return next ? `Step ${target.id} marked done. Next: ${next.id}. ${next.title}` : 'All steps marked done. Call final_answer.';
    }

    /** Returns steps formatted for PromptBuilder / tail block. */
    getPromptPlanSteps(): import('../webview/promptBuilder').PlanStep[] {
        return this.steps.map(s => ({
            id: s.id,
            title: s.title,
            verify: s.condition.kind === 'command_ok' ? s.condition.commandIncludes : undefined,
            done: s.status === 'done',
            dropped: s.status === 'skipped' ? (s.note || 'dropped') : undefined
        }));
    }

    /* ---------------- harness-facing hooks ---------------- */

    /** Call after EVERY tool execution. Advances steps automatically. */
    onToolEvent(ev: ToolEvent): void {
        const cur = this.current();
        if (!cur) return;

        if (ev.tool.startsWith('plan_')) {
            this.planOnlyTurns++;
        } else {
            this.planOnlyTurns = 0;
            const c = cur.condition;
            if (ev.ok && c.kind === 'file_edited' && ev.filepath && ev.filepath.includes(c.pathIncludes)) {
                cur.status = 'done';
            } else if (ev.ok && c.kind === 'command_ok' && ev.command && ev.command.includes(c.commandIncludes)) {
                cur.status = 'done';
            } else if (!ev.ok && c.kind !== 'manual') {
                cur.note = `Last attempt failed (${ev.tool})`;
            }
        }
        if (cur.status === 'done') this.advance();
        this.commit();
    }

    /** Which plan tools to expose. */
    allowedPlanTools(): string[] {
        if (this.planOnlyTurns >= this.maxPlanOnlyTurns) return [];
        if (!this.hasActivePlan()) return ['plan_set'];
        return ['plan_update', 'plan_done', 'plan_set'];
    }

    hasActivePlan(): boolean {
        return this.steps.some(s => s.status === 'active' || s.status === 'pending');
    }

    /** Compact line for the tail block (see toolReanchor.ts). */
    currentStepText(): string | undefined {
        const cur = this.current();
        if (!cur) return undefined;
        return `${cur.id}/${this.steps.length} ${cur.title}`;
    }

    /** Optional richer view for the system prompt / summary. */
    renderCompact(): string {
        if (!this.steps.length) return '';
        const icon: Record<StepStatus, string> = { pending: '[ ]', active: '[>]', done: '[x]', failed: '[!]', skipped: '[-]' };
        return `PLAN: ${this.goal}\n` + this.steps.map(s => `${icon[s.status]} ${s.id}. ${s.title}`).join('\n');
    }

    /** User can skip/reset from the webview stepper. */
    handleWebviewMessage(msg: { type?: string; command?: string; stepId?: number }): boolean {
        const action = msg.command || msg.type;
        switch (action) {
            case 'plan_skip_step': {
                const s = this.steps.find(x => x.id === msg.stepId);
                if (s && s.status !== 'done') {
                    s.status = 'skipped';
                    if (this.current() === undefined) this.advance();
                    this.commit();
                }
                return true;
            }
            case 'plan_clear':
                this.clear();
                return true;
        }
        return false;
    }

    clear() {
        this.steps = [];
        this.goal = '';
        this.planOnlyTurns = 0;
        if (this.ctx) {
            this.ctx.workspaceState.update(STORAGE_KEY, undefined);
        }
        this.commit();
    }

    /* ---------------- internals ---------------- */

    private current(): PlanStep | undefined {
        return this.steps.find(s => s.status === 'active');
    }

    private advance() {
        if (this.current()) return;
        const next = this.steps.find(s => s.status === 'pending');
        if (next) next.status = 'active';
    }

    private commit() {
        if (this.ctx) {
            this.ctx.workspaceState.update(STORAGE_KEY, { goal: this.goal, steps: this.steps });
        }
        if (this.postToWebview) {
            this.postToWebview({ type: 'update_plan_stepper', goal: this.goal, steps: this.steps });
        }

        // Live Disk Sync: Write readable markdown plan to .ultra-light-ai/PLAN.md AND docs/
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            try {
                const root = workspaceFolders[0].uri.fsPath;
                const metaDir = path.join(root, '.ultra-light-ai');
                if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
                const planPath = path.join(metaDir, 'PLAN.md');
                
                if (this.steps.length === 0) {
                    if (fs.existsSync(planPath)) fs.unlinkSync(planPath);
                } else {
                    let md = `# 🎯 Project Plan: ${this.goal || 'Execution Roadmap'}\n\n`;
                    md += `*Last Updated: ${new Date().toLocaleTimeString()}*\n\n`;
                    for (const s of this.steps) {
                        const check = s.status === 'done' ? '[x]' : (s.status === 'active' ? '[>]' : (s.status === 'skipped' ? '[-]' : '[ ]'));
                        md += `- ${check} **Step ${s.id}:** ${s.title}\n`;
                        if (s.note) md += `  - *Note:* ${s.note}\n`;
                    }
                    fs.writeFileSync(planPath, md, 'utf8');

                    // Also mirror to root PLAN.md for workspace visibility if desired
                    try {
                        const rootPlanPath = path.join(root, 'PLAN.md');
                        if (fs.existsSync(rootPlanPath)) {
                            fs.writeFileSync(rootPlanPath, md, 'utf8');
                        }
                    } catch {}
                }
            } catch (e) {
                console.warn('Failed to write PLAN.md to disk', e);
            }
        }

        this._onDidChange.fire();
    }

    dispose() {
        this._onDidChange.dispose();
    }
}

/* ---------------- tool registry entries ---------------- */
export const planTools = [
    {
        name: 'plan_set',
        description: 'Set a multi-step plan. Automatically writes and updates PLAN.md in the workspace.',
        signature: 'plan_set(goal: string, steps: {title: string, file?: string, command?: string}[], architecture?: {ui_ux?: string, database?: string, component_flow?: string})',
        parameters: {
            type: 'object',
            properties: {
                goal: { type: 'string', description: 'Brief goal description' },
                steps: {
                    type: 'array',
                    description: 'Ordered steps to accomplish the goal',
                    items: {
                        type: 'object',
                        properties: {
                            title: { type: 'string', description: 'Actionable step title' },
                            file: { type: 'string', description: 'Target file path that auto-completes this step when edited' },
                            command: { type: 'string', description: 'Terminal command that auto-completes this step when exited with code 0' }
                        },
                        required: ['title']
                    }
                },
                architecture: {
                    type: 'object',
                    description: 'Optional architectural details included in PLAN.md',
                    properties: {
                        component_flow: { type: 'string', description: 'Component connections, module flow, and tech stack details' },
                        database: { type: 'string', description: 'Database schema, entities, fields, and relationships' },
                        ui_ux: { type: 'string', description: 'UI/UX design specs, layouts, color palette, and user flows' }
                    }
                }
            },
            required: ['goal', 'steps']
        }
    },
    {
        name: 'plan_done',
        description: 'Mark the current manual plan step as completed.',
        signature: 'plan_done(note?: string)',
        parameters: {
            type: 'object',
            properties: {
                note: { type: 'string', description: 'Summary of what was accomplished' }
            },
            required: []
        }
    }
];
