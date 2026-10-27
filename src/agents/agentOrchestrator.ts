// src/agents/agentOrchestrator.ts
// Deterministic Multi-Agent Orchestrator.
// The sole authority for lifecycle transitions, role gating, retry limits, and step completion.

import * as path from 'path';
import {
    AgentRoleType,
    TaskStatePhase,
    OrchestratorTaskSession,
    TaskStepContract,
    RoleTurnInput,
    RoleTurnResult,
    VerificationResult
} from './types';
import { PlannerRoleHandler } from './roles/plannerRole';
import { ResearcherRoleHandler } from './roles/researcherRole';
import { CoderRoleHandler } from './roles/coderRole';
import { VerifierRoleHandler } from './roles/verifierRole';
import { PromptClassifier } from '../utils/promptClassifier';
import { StateLedger } from '../state/stateLedger';
import { LoopDetector } from '../guards/loopDetector';

export interface OrchestratorContext {
    workspaceRoot: string;
    config: any;
    client: any;
    tools: any[];
    taskPlanner: any;
    postMessage: (msg: any) => void;
    dispatchTool: (call: any, activeRole: AgentRoleType) => Promise<any>;
    signal?: AbortSignal;
    userPrompt: string;
    images?: any[];
    architectMode?: boolean;
    thinkingBudget?: string;
    repoMap?: string;
}

export class AgentOrchestrator {
    private session: OrchestratorTaskSession;
    private loopDetector: LoopDetector;

    constructor(private ctx: OrchestratorContext) {
        const config = ctx.config;
        const maxTokens = config?.contextLimits?.maxContextTokens || 40000;
        const maxToolSteps = config?.maxAutonomousToolSteps || 40;

        this.session = {
            sessionId: 'orch_' + Date.now(),
            userPrompt: ctx.userPrompt,
            workspaceRoot: ctx.workspaceRoot,
            status: 'idle',
            activeRole: 'planner',
            budget: {
                maxTotalTokens: maxTokens,
                usedTotalTokens: 0,
                maxToolIterations: maxToolSteps,
                usedToolIterations: 0,
                maxStepRetries: 2,
                timeoutSeconds: 300
            },
            plan: [],
            historySummaries: [],
            lastFailedCommand: null,
            abortController: new AbortController()
        };

        if (ctx.signal) {
            ctx.signal.addEventListener('abort', () => {
                this.session.status = 'aborted';
                this.session.abortController.abort();
            }, { once: true });
        }

        this.loopDetector = new LoopDetector();
    }

    public getSession(): Readonly<OrchestratorTaskSession> {
        return this.session;
    }

    /**
     * Executes the task through the deterministic multi-agent lifecycle.
     */
    public async execute(): Promise<{ text: string; status: TaskStatePhase }> {
        if (this.session.abortController.signal.aborted) {
            this.session.status = 'aborted';
            return { text: 'Operation cancelled by user.', status: 'aborted' };
        }

        const category = PromptClassifier.classifyPrompt(this.ctx.userPrompt);

        // 1. FAST-PATH: Greeting / Pure Conversational
        if (category === 'chat') {
            this.session.status = 'completed';
            const chatResult = await this.ctx.client.completeWithHistory({
                prompt: this.ctx.userPrompt,
                systemInstruction: "You are Vakra AI, an autonomous coding agent for VS Code. Respond politely and concisely in text, welcoming the user and asking what coding task they want to tackle.",
                history: [],
                stream: true,
                signal: this.ctx.signal,
                onChunk: (chunk: any) => {
                    if (chunk.text) {
                        this.ctx.postMessage({ command: 'streamChunk', text: chunk.text, done: false });
                    }
                }
            });
            this.ctx.postMessage({ command: 'streamChunk', text: '', done: true });
            return { text: chatResult?.text || 'Hello! How can I assist with your code today?', status: 'completed' };
        }

        // 2. FAST-PATH: Simple Info / Explanation Query
        if (category === 'info') {
            this.session.status = 'researching';
            this.session.activeRole = 'researcher';
            this.ctx.postMessage({ command: 'statusUpdate', text: '🔍 Researching information...' });

            const infoResult = await ResearcherRoleHandler.execute(
                {
                    role: 'researcher',
                    userPrompt: this.ctx.userPrompt,
                    workspaceRoot: this.ctx.workspaceRoot,
                    signal: this.ctx.signal
                },
                this.ctx.client,
                this.ctx.tools,
                (call) => this.dispatchWithRoleCheck('researcher', call),
                (chunk) => this.forwardStreamChunk(chunk)
            );

            this.session.status = 'completed';
            this.ctx.postMessage({ command: 'streamChunk', text: '', done: true });
            return { text: infoResult.text, status: 'completed' };
        }

        // 3. COMPLEX / CODING WORKFLOW: Determine whether planning is needed
        let planSteps = this.syncPlanFromPlanner();

        if (planSteps.length === 0) {
            // PHASE: PLANNING
            this.session.status = 'planning';
            this.session.activeRole = 'planner';
            this.ctx.postMessage({ command: 'statusUpdate', text: '📋 Formulating task plan...' });

            const plannerResult = await PlannerRoleHandler.execute(
                {
                    role: 'planner',
                    userPrompt: this.ctx.userPrompt,
                    workspaceRoot: this.ctx.workspaceRoot,
                    planStepsSummary: this.ctx.repoMap,
                    signal: this.ctx.signal
                },
                this.ctx.client,
                this.ctx.tools,
                (call) => this.dispatchWithRoleCheck('planner', call),
                (chunk) => this.forwardStreamChunk(chunk)
            );

            planSteps = this.syncPlanFromPlanner();
            if (plannerResult.planCreated || planSteps.length > 0) {
                this.session.status = 'awaiting_plan_approval';
            }
        }

        // If no structured plan was created and it's a direct task, formulate a single atomic step
        if (planSteps.length === 0) {
            planSteps = [{
                id: '1.1',
                parentId: 1,
                title: this.ctx.userPrompt.slice(0, 100),
                acceptanceCriteria: ['Task executed and verified clean'],
                status: 'pending',
                attempts: 0,
                maxAttempts: 2
            }];
            this.session.plan = planSteps;
        }

        // 4. SUB-STEP EXECUTION LOOP (Sequential, bounded retries)
        for (const step of planSteps) {
            if (this.session.abortController.signal.aborted) {
                this.session.status = 'aborted';
                break;
            }

            if (step.status === 'done') continue;

            step.status = 'in_progress';
            this.session.activeStepId = step.id;

            // A. RESEARCH PHASE (On-demand)
            let researchFindings = step.research;
            if (!researchFindings) {
                this.session.status = 'researching';
                this.session.activeRole = 'researcher';
                this.ctx.postMessage({ command: 'statusUpdate', text: `🔍 Inspecting context for Step ${step.id}...` });

                const researchRes = await ResearcherRoleHandler.execute(
                    {
                        role: 'researcher',
                        userPrompt: this.ctx.userPrompt,
                        workspaceRoot: this.ctx.workspaceRoot,
                        activeStep: step,
                        signal: this.ctx.signal
                    },
                    this.ctx.client,
                    this.ctx.tools,
                    (call) => this.dispatchWithRoleCheck('researcher', call),
                    (chunk) => this.forwardStreamChunk(chunk)
                );
                researchFindings = researchRes.research;
                step.research = researchFindings;
            }

            // B. IMPLEMENTATION & VERIFICATION LOOP (Bounded to maxAttempts)
            let stepPassed = false;
            let previousFailure: VerificationResult | undefined;

            while (step.attempts < step.maxAttempts && !stepPassed) {
                if (this.session.abortController.signal.aborted) break;

                step.attempts++;
                this.session.status = step.attempts > 1 ? 'recovering' : 'coding';
                this.session.activeRole = 'coder';

                const attemptLabel = step.attempts > 1 ? ` (Correction Attempt ${step.attempts}/${step.maxAttempts})` : '';
                this.ctx.postMessage({
                    command: 'statusUpdate',
                    text: `✏️ Implementing Step ${step.id}${attemptLabel}...`
                });

                // Coder turn
                const coderRes = await CoderRoleHandler.execute(
                    {
                        role: 'coder',
                        userPrompt: this.ctx.userPrompt,
                        workspaceRoot: this.ctx.workspaceRoot,
                        activeStep: step,
                        researchFindings,
                        previousFailure,
                        signal: this.ctx.signal
                    },
                    this.ctx.client,
                    this.ctx.tools,
                    (call) => this.dispatchWithRoleCheck('coder', call),
                    (chunk) => this.forwardStreamChunk(chunk)
                );
                step.codeResult = coderRes.codeResult;

                if (this.session.abortController.signal.aborted) break;

                // Verifier turn
                this.session.status = 'verifying';
                this.session.activeRole = 'verifier';
                this.ctx.postMessage({
                    command: 'statusUpdate',
                    text: `🔍 Verifying Step ${step.id}...`
                });

                const verifierRes = await VerifierRoleHandler.execute(
                    {
                        role: 'verifier',
                        userPrompt: this.ctx.userPrompt,
                        workspaceRoot: this.ctx.workspaceRoot,
                        activeStep: step,
                        coderResult: coderRes.codeResult,
                        signal: this.ctx.signal
                    },
                    this.ctx.client,
                    this.ctx.tools,
                    (call) => this.dispatchWithRoleCheck('verifier', call),
                    (chunk) => this.forwardStreamChunk(chunk)
                );

                const verdict = verifierRes.verification;
                step.verdict = verdict;

                if (verdict?.passed) {
                    stepPassed = true;
                    step.status = 'done';
                    this.commitStepProgress(step, coderRes.text || 'Step verified.');
                } else {
                    previousFailure = verdict;
                    if (step.attempts >= step.maxAttempts) {
                        this.session.status = 'failed';
                        const failMsg = `⚠️ Step ${step.id} failed after ${step.maxAttempts} attempts.\n\nVerification Failure: ${verdict?.failureReason || 'Verification check failed.'}`;
                        this.ctx.postMessage({ command: 'streamChunk', text: `\n\n${failMsg}`, done: true });
                        return { text: failMsg, status: 'failed' };
                    }
                }
            }

            if (!stepPassed && this.session.status === 'failed') {
                break;
            }
        }

        // 5. TASK COMPLETION
        const allDone = planSteps.every(s => s.status === 'done');
        if (allDone && this.session.status !== 'aborted') {
            this.session.status = 'completed';
            this.ctx.postMessage({ command: 'statusUpdate', text: '✅ All task steps verified and complete.' });
            this.ctx.postMessage({ command: 'streamChunk', text: '', done: true });
            return { text: 'All planned steps verified and successfully completed.', status: 'completed' };
        }

        return {
            text: this.session.status === 'aborted' ? 'Task aborted.' : 'Execution finished.',
            status: this.session.status
        };
    }

    /**
     * Dual-Layer Tool Dispatch with strict role permission checking and loop prevention.
     */
    private async dispatchWithRoleCheck(role: AgentRoleType, call: any): Promise<any> {
        if (this.session.abortController.signal.aborted) {
            return 'Operation cancelled by user.';
        }

        // Loop detection
        const argsHash = LoopDetector.hashArgs(call.args || {});
        const loopCheck = this.loopDetector.check({ tool: call.name, argsHash });
        if (loopCheck.repeat) {
            return `[LOOP PREVENTED]: Tool '${call.name}' with identical parameters was already called recently. Halting repeated execution.`;
        }

        // Dispatch through authoritative ToolDispatcher
        const result = await this.ctx.dispatchTool(call, role);
        const resStr = typeof result === 'string' ? result : JSON.stringify(result);
        const resultOk = typeof result !== 'string' || (
            !resStr.startsWith('Error:') &&
            !resStr.startsWith('REJECTED:') &&
            !resStr.startsWith('BLOCKED:') &&
            !resStr.startsWith('[LOOP PREVENTED]') &&
            !resStr.includes('FAILED') &&
            !/Exit Code:\s*[1-9]/i.test(resStr)
        );
        this.loopDetector.record({
            tool: call.name,
            argsHash,
            resultOk
        });
        return result;
    }

    /**
     * Synchronizes plan steps from the active InMemoryTaskPlanner.
     */
    private syncPlanFromPlanner(): TaskStepContract[] {
        const steps: TaskStepContract[] = [];
        if (!this.ctx.taskPlanner) return steps;

        const rawSteps = typeof this.ctx.taskPlanner.getSteps === 'function' ? this.ctx.taskPlanner.getSteps() : [];
        for (const s of rawSteps) {
            if (s.subSteps && s.subSteps.length > 0) {
                for (const sub of s.subSteps) {
                    steps.push({
                        id: String(sub.id),
                        parentId: s.id,
                        title: sub.title,
                        acceptanceCriteria: sub.acceptanceCriteria || [`Verify ${sub.title}`],
                        status: sub.status === 'done' ? 'done' : 'pending',
                        attempts: sub.attempts || 0,
                        maxAttempts: 2
                    });
                }
            } else {
                steps.push({
                    id: String(s.id),
                    parentId: s.id,
                    title: s.title,
                    acceptanceCriteria: s.acceptanceCriteria || [`Verify ${s.title}`],
                    status: s.status === 'done' ? 'done' : 'pending',
                    attempts: s.attempts || 0,
                    maxAttempts: 2
                });
            }
        }

        this.session.plan = steps;
        return steps;
    }

    /**
     * Commits step progress to disk memory and updates the planner.
     */
    private commitStepProgress(step: TaskStepContract, summary: string): void {
        try {
            if (typeof this.ctx.taskPlanner.completeSubStep === 'function') {
                this.ctx.taskPlanner.completeSubStep(
                    step.id,
                    summary,
                    step.codeResult?.changes.map(c => c.filepath),
                    step.codeResult?.blueprint?.logicAddedOrModified
                );
            }
        } catch {}

        try {
            StateLedger.sync(this.ctx.workspaceRoot, {
                goal: this.ctx.userPrompt,
                latestActionSummary: `Completed Step ${step.id}: ${step.title}`
            });
        } catch {}
    }

    private forwardStreamChunk(chunk: any): void {
        if (this.session.abortController.signal.aborted) return;
        if (chunk.text) {
            this.ctx.postMessage({
                command: chunk.isThinking ? 'thinkingChunk' : 'streamChunk',
                text: chunk.text,
                done: false
            });
        }
    }
}
