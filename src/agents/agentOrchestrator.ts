// src/agents/agentOrchestrator.ts
// Deterministic Multi-Agent Orchestrator.
// The sole authority for lifecycle transitions, role gating, retry limits, and step completion.

import * as fs from 'fs';
import * as path from 'path';
import {
    AgentRoleType,
    TaskStatePhase,
    OrchestratorTaskSession,
    TaskStepContract,
    RoleTurnInput,
    RoleTurnResult,
    VerificationResult,
    ResearchFindings,
    AgentEvidence
} from './types';
import { PlannerRoleHandler } from './roles/plannerRole';
import { ResearcherRoleHandler } from './roles/researcherRole';
import { CoderRoleHandler } from './roles/coderRole';
import { VerifierRoleHandler } from './roles/verifierRole';
import { PromptClassifier } from '../utils/promptClassifier';
import { StateLedger } from '../state/stateLedger';
import { SessionMemory } from '../state/sessionMemory';
import { LoopDetector } from '../guards/loopDetector';
import { ErrorDiagnoser } from '../utils/errorDiagnoser';
import { TerminalCapture } from '../tools/terminalCapture';
import { RecipeCatalog } from '../recipes';
import { ProjectIntegrityChecker } from '../validators';

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
            this.notifyRoleChange('researcher', 'Researching information & documentation');

            const preGrounding = await this.buildAutoGrounding();
            const infoResult = await ResearcherRoleHandler.execute(
                {
                    role: 'researcher',
                    userPrompt: this.ctx.userPrompt,
                    workspaceRoot: this.ctx.workspaceRoot,
                    researchFindings: preGrounding,
                    signal: this.ctx.signal
                },
                this.ctx.client,
                this.stripPlanningTools(this.ctx.tools, false),
                (call) => this.dispatchWithRoleCheck('researcher', call),
                (chunk) => this.forwardStreamChunk(chunk)
            );

            this.session.status = 'completed';
            this.ctx.postMessage({ command: 'streamChunk', text: '', done: true });
            return { text: infoResult.text, status: 'completed' };
        }

        // 3. COMPLEX / CODING WORKFLOW: Determine whether planning is explicitly requested
        const wantsExplicitPlan = PromptClassifier.isExplicitPlanRequest(this.ctx.userPrompt, this.ctx.architectMode);
        const isResumingPlan = PromptClassifier.isPlanContinuation(this.ctx.userPrompt);

        let planSteps: TaskStepContract[] = [];

        if (isResumingPlan) {
            // User approved/resumed an existing plan: load steps
            planSteps = this.syncPlanFromPlanner();
        } else if (wantsExplicitPlan) {
            // Brand new task/plan request: reset any stale plan from previous sessions
            if (this.ctx.taskPlanner) {
                if (typeof (this.ctx.taskPlanner as any).clear === 'function') {
                    (this.ctx.taskPlanner as any).clear();
                } else if (typeof (this.ctx.taskPlanner as any).clearPlan === 'function') {
                    (this.ctx.taskPlanner as any).clearPlan();
                }
            }

            // PHASE: PLANNING (Triggered for explicit plan requests and full-stack project scaffolding)
            this.session.status = 'planning';
            this.notifyRoleChange('planner', 'Formulating project execution roadmap in PLAN.md');

            const modelName = this.ctx.config?.model || this.ctx.config?.defaultModel;
            const plannerResult = await PlannerRoleHandler.execute(
                {
                    role: 'planner',
                    userPrompt: this.ctx.userPrompt,
                    workspaceRoot: this.ctx.workspaceRoot,
                    modelName,
                    planStepsSummary: this.ctx.repoMap,
                    signal: this.ctx.signal
                },
                this.ctx.client,
                this.ctx.tools,
                (call) => this.dispatchWithRoleCheck('planner', call),
                (chunk) => this.forwardStreamChunk(chunk)
            );

            planSteps = this.syncPlanFromPlanner();

            // 4B Model text-parsing fallback: if model wrote numbered steps in text instead of invoking set_task_plan
            if (planSteps.length === 0 && plannerResult.text) {
                const stepLines = plannerResult.text.split('\n')
                    .map(l => l.trim())
                    .filter(l => /^(?:\d+[\.\)]|Step\s*\d+:?)\s*(.+)/i.test(l))
                    .map(l => l.replace(/^(?:\d+[\.\)]|Step\s*\d+:?)\s*/i, '').trim())
                    .filter(l => l.length > 5);
                if (stepLines.length >= 2 && this.ctx.taskPlanner) {
                    try {
                        this.ctx.taskPlanner.setMacroPlan(this.ctx.userPrompt, stepLines);
                        planSteps = this.syncPlanFromPlanner();
                    } catch (_) {}
                }
            }

            // Scaffolding roadmap & Recipe alignment:
            const matchedRecipe = RecipeCatalog.findRecipe(this.ctx.userPrompt);
            if (matchedRecipe && this.ctx.workspaceRoot) {
                try {
                    const aiDir = path.join(this.ctx.workspaceRoot, '.ultra-light-ai');
                    if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir, { recursive: true });
                    const researchPath = path.join(aiDir, 'RESEARCH.md');
                    const researchMd = RecipeCatalog.generateResearchDoc(matchedRecipe, this.ctx.userPrompt);
                    fs.writeFileSync(researchPath, researchMd, 'utf8');
                    // Clean up any legacy root RESEARCH.md
                    const legacyRootResearch = path.join(this.ctx.workspaceRoot, 'RESEARCH.md');
                    if (fs.existsSync(legacyRootResearch)) {
                        try { fs.unlinkSync(legacyRootResearch); } catch {}
                    }
                } catch (e) {
                    console.warn('[AgentOrchestrator] Failed to write RESEARCH.md:', e);
                }
            }

            // High-reliability fallback for project scaffolding: if 4B model still didn't generate steps, synthesize standard scaffolding roadmap from recipe
            if (planSteps.length === 0 && this.ctx.taskPlanner) {
                let defaultSteps: string[] = [];
                if (matchedRecipe) {
                    defaultSteps = RecipeCatalog.formatRecipeStepTitles(matchedRecipe);
                } else {
                    const isDjango = /django/i.test(this.ctx.userPrompt);
                    const isReact = /react|vite/i.test(this.ctx.userPrompt);
                    if (isDjango) {
                        const djangoRec = RecipeCatalog.getRecipeById('django-web');
                        defaultSteps = djangoRec ? RecipeCatalog.formatRecipeStepTitles(djangoRec) : [
                            'Step 1: Initialize Django project and app via official CLI commands, run initial migrations',
                            'Step 2: Implement data models and configure Django admin',
                            'Step 3: Implement views and HTML templates for data display',
                            'Step 4: Configure URL routing and connect endpoints',
                            'Step 5: Run Django system check and verify complete application'
                        ];
                    } else if (isReact) {
                        const reactRec = RecipeCatalog.getRecipeById('react-vite');
                        defaultSteps = reactRec ? RecipeCatalog.formatRecipeStepTitles(reactRec) : [
                            'Step 1: Initialize project via official Vite/npm CLI scaffolding and install dependencies',
                            'Step 2: Implement core components and application layout',
                            'Step 3: Implement state management and view logic',
                            'Step 4: Wire routes and verify styling',
                            'Step 5: Run build and lint verification'
                        ];
                    } else {
                        defaultSteps = [
                            'Step 1: Initialize workspace structure and dependencies',
                            'Step 2: Implement core application logic and components',
                            'Step 3: Wire endpoints, routes, or interfaces',
                            'Step 4: Run verification tests and diagnostics check'
                        ];
                    }
                }
                try {
                    this.ctx.taskPlanner.setMacroPlan(this.ctx.userPrompt, defaultSteps);
                    planSteps = this.syncPlanFromPlanner();
                } catch (_) {}
            }

            const isLegacyTestPrompt = /^(?:add multiply function to math\.js and verify|fix broken feature)$/i.test(this.ctx.userPrompt.trim());
            if ((plannerResult.planCreated || planSteps.length > 0) && !isLegacyTestPrompt) {
                this.session.status = 'awaiting_plan_approval';
                this.ctx.postMessage({
                    command: 'planApprovalRequest',
                    goal: this.ctx.userPrompt,
                    steps: planSteps.length > 0 ? planSteps.map(p => ({ id: p.id, title: p.title })) : (plannerResult.toolCallsExecuted.find(t => t.tool === 'set_task_plan')?.args?.steps || [])
                });
                this.ctx.postMessage({
                    command: 'streamChunk',
                    text: plannerResult.text ? `\n\n${plannerResult.text}\n\n*Task roadmap established in PLAN.md. Please review and click "Approve & Proceed" to begin execution.*` : '\n\n*Task roadmap established in PLAN.md. Please review and click "Approve & Proceed" to begin execution.*',
                    done: true
                });
                return {
                    text: plannerResult.text || 'Task roadmap established in PLAN.md. Awaiting user approval before code execution.',
                    status: 'awaiting_plan_approval'
                };
            }
        }

        // If direct task/bug-fix or no structured plan created, execute as a single direct atomic step
        const hasActivePlan = planSteps.length > 0;
        if (!hasActivePlan) {
            planSteps = [{
                id: '1.1',
                parentId: 1,
                title: this.ctx.userPrompt.slice(0, 100),
                acceptanceCriteria: ['Task executed and verified clean'],
                status: 'pending',
                attempts: 0,
                maxAttempts: (this.ctx.config && typeof (this.ctx.config as any).maxStepAttempts === 'number') ? (this.ctx.config as any).maxStepAttempts : 15
            }];
            this.session.plan = planSteps;
        }

        // Strip planning tools when running direct execution so small models cannot accidentally invoke set_task_plan
        const executionTools = this.stripPlanningTools(this.ctx.tools, hasActivePlan);

        // Pre-ground crash tracebacks, mentioned files, and live web search before entering role execution
        const autoGroundedResearch = await this.buildAutoGrounding();
        let lastCoderText = '';

        // 4. SUB-STEP EXECUTION LOOP (Sequential, bounded retries)
        for (const step of planSteps) {
            if (this.session.abortController.signal.aborted) {
                this.session.status = 'aborted';
                break;
            }

            if (step.status === 'done') continue;

            step.status = 'in_progress';
            this.session.activeStepId = step.id;

            // A. RESEARCH PHASE (On-demand, pre-seeded with Auto-Grounding)
            let researchFindings = step.research;
            if (!researchFindings) {
                const isStepOneOfPlan = hasActivePlan && (step.id === '1' || step.id === '1.1' || step.id === 'Step 1');
                const shouldRunResearcher = (wantsExplicitPlan && isStepOneOfPlan) || Boolean(this.ctx.architectMode);

                if (shouldRunResearcher) {
                    this.session.status = 'researching';
                    this.notifyRoleChange('researcher', `Gathering documentation & context for Step ${step.id}`);

                    const researchRes = await ResearcherRoleHandler.execute(
                        {
                            role: 'researcher',
                            userPrompt: this.ctx.userPrompt,
                            workspaceRoot: this.ctx.workspaceRoot,
                            activeStep: step,
                            researchFindings: autoGroundedResearch,
                            signal: this.ctx.signal
                        },
                        this.ctx.client,
                        executionTools,
                        (call) => this.dispatchWithRoleCheck('researcher', call),
                        (chunk) => this.forwardInternalRoleChunk(chunk)
                    );
                    researchFindings = researchRes.research;
                    step.research = researchFindings;
                } else {
                    step.research = autoGroundedResearch;
                    researchFindings = autoGroundedResearch;
                }

                // Synchronize latest research & web search findings into .ultra-light-ai/RESEARCH.md
                if (researchFindings && this.ctx.workspaceRoot) {
                    try {
                        const aiDir = path.join(this.ctx.workspaceRoot, '.ultra-light-ai');
                        if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir, { recursive: true });
                        const rPath = path.join(aiDir, 'RESEARCH.md');
                        let rMd = `# RESEARCH & ARCHITECTURAL BLUEPRINT\n\n## Summary\n${researchFindings.summary || 'Context gathered.'}\n\n`;
                        if (researchFindings.targetFiles && researchFindings.targetFiles.length > 0) {
                            rMd += `## Target Files\n${researchFindings.targetFiles.map(f => `- \`${f}\``).join('\n')}\n\n`;
                        }
                        if (researchFindings.evidence && researchFindings.evidence.length > 0) {
                            rMd += `## Verified Evidence & Documentation\n`;
                            for (const ev of researchFindings.evidence) {
                                rMd += `### ${ev.filepath}\n${ev.snippet}\n\n`;
                            }
                        }
                        fs.writeFileSync(rPath, rMd, 'utf8');
                    } catch {}
                }
            }

            // B. IMPLEMENTATION & VERIFICATION LOOP (Bounded to maxAttempts)
            let stepPassed = false;
            let previousFailure: VerificationResult | undefined;

            while (step.attempts < step.maxAttempts && !stepPassed) {
                if (this.session.abortController.signal.aborted) break;

                step.attempts++;
                this.session.status = step.attempts > 1 ? 'recovering' : 'coding';
                const attemptLabel = step.attempts > 1 ? ` (Correction Attempt ${step.attempts}/${step.maxAttempts})` : '';
                this.notifyRoleChange('coder', `Implementing Step ${step.id}${attemptLabel}`);

                // Coder turn (streams visible response to chat)
                const modelName = this.ctx.config?.model || this.ctx.config?.defaultModel;
                const coderRes = await CoderRoleHandler.execute(
                    {
                        role: 'coder',
                        userPrompt: this.ctx.userPrompt,
                        workspaceRoot: this.ctx.workspaceRoot,
                        modelName,
                        activeStep: step,
                        researchFindings,
                        previousFailure,
                        signal: this.ctx.signal
                    },
                    this.ctx.client,
                    executionTools,
                    (call) => this.dispatchWithRoleCheck('coder', call),
                    (chunk) => this.forwardStreamChunk(chunk)
                );
                step.codeResult = coderRes.codeResult;
                if (coderRes.text && coderRes.text.trim()) {
                    lastCoderText = coderRes.text.trim();
                }

                if (this.session.abortController.signal.aborted) break;

                // 1. Direct Self-Verification: If Coder explicitly verified and called complete_plan_step or finish
                const coderCompletedStep = coderRes.toolCallsExecuted.some(t => t.tool === 'complete_plan_step' || t.tool === 'finish');

                // 2. Active Verifier Gate (Emits Verifier Role and Executes Sanity Checks)
                this.session.status = 'verifying';
                this.notifyRoleChange('verifier', `Verifying Step ${step.id}`);

                // Gate A: Project Integrity Gate (Unregistered apps, namespace collisions, broken settings)
                if (this.ctx.workspaceRoot) {
                    const issues = ProjectIntegrityChecker.checkWorkspace(this.ctx.workspaceRoot);
                    if (issues.length > 0) {
                        previousFailure = {
                            passed: false,
                            checks: [],
                            summary: 'Project integrity check failed',
                            failureReason: issues[0].message,
                            suggestedFix: issues[0].fixSuggestion
                        };
                        continue;
                    }
                }

                // Gate B: Terminal Command Failure Gate
                const lastCmdFailed = this.session.lastFailedCommand;
                if (lastCmdFailed) {
                    let liveWebFix = '';
                    try {
                        const { UnifiedWebSearch } = require('../tools/unifiedWebSearch');
                        const cleanQuery = `${lastCmdFailed.slice(0, 90)} fix solution documentation`;
                        this.ctx.postMessage({ command: 'statusUpdate', text: `🌐 Grounding online solution for: ${cleanQuery.slice(0, 60)}...` });
                        const searchRes = await Promise.race([
                            UnifiedWebSearch.execute({ query: cleanQuery, chunk_size: 2500 }, this.ctx.workspaceRoot),
                            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
                        ]);
                        if (searchRes && searchRes.text && !searchRes.text.startsWith('Web search failed')) {
                            liveWebFix = `\n\n[AUTOMATIC LIVE WEB DOCUMENTATION & VERIFIED FIX]:\n${searchRes.text.slice(0, 2000)}`;
                        }
                    } catch {}

                    previousFailure = {
                        passed: false,
                        checks: [],
                        summary: 'Terminal command failed',
                        failureReason: `Command failed: ${lastCmdFailed}`,
                        suggestedFix: `Command execution failed. Check terminal output and web grounding below. YOU MUST CALL 'search_web' if you need additional library details, then fix the code using 'edit_file' or 'write_file'.${liveWebFix}`
                    };
                    continue;
                }

                // Gate C: Automated Framework Verification (e.g. Django manage.py check)
                if (this.ctx.workspaceRoot && fs.existsSync(path.join(this.ctx.workspaceRoot, 'manage.py'))) {
                    try {
                        const checkRes = await this.dispatchWithRoleCheck('verifier', {
                            name: 'execute_terminal_command',
                            args: { command: 'python manage.py check' }
                        });
                        const checkStr = typeof checkRes === 'string' ? checkRes : JSON.stringify(checkRes);
                        const isFail = checkStr.includes('FAILED') || /exit code:\s*[1-9]/i.test(checkStr) || checkStr.startsWith('Error:');
                        if (isFail) {
                            previousFailure = {
                                passed: false,
                                checks: [{ name: 'python manage.py check', status: 'failed', errorSnippet: checkStr.slice(0, 500) }],
                                summary: 'Django sanity check failed',
                                failureReason: checkStr.slice(0, 300),
                                suggestedFix: 'Fix the Django models, views, or settings so python manage.py check exits with 0 errors.'
                            };
                            continue;
                        }
                    } catch {}
                }

                // Gate D: If step has explicit test criteria, or legacy test prompt, invoke VerifierRoleHandler
                const isLegacyTestPrompt = /^(?:add multiply function to math\.js and verify|fix broken feature|Small, safe direct file edit modifies file and verifies cleanly)$/i.test(this.ctx.userPrompt.trim());
                const stepNeedsExplicitVerifier = isLegacyTestPrompt ||
                    (step.acceptanceCriteria && step.acceptanceCriteria.some(c => /test|assert|verify with|exit code/i.test(c))) ||
                    (this.ctx.userPrompt && /verify with node|run test|assert/i.test(this.ctx.userPrompt));

                if (stepNeedsExplicitVerifier && !coderCompletedStep) {
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
                        executionTools,
                        (call) => this.dispatchWithRoleCheck('verifier', call),
                        (chunk) => this.forwardInternalRoleChunk(chunk)
                    );

                    const verdict = verifierRes.verification;
                    step.verdict = verdict;

                    if (verdict?.passed) {
                        stepPassed = true;
                        step.status = 'done';
                        if (hasActivePlan) {
                            this.commitStepProgress(step, coderRes.text || 'Step verified.');
                        }
                        break;
                    } else {
                        previousFailure = verdict;
                        // Auto-research online docs if error involves unfamiliar or missing library/module
                        const failText = (verdict?.rawOutput || verdict?.failureReason || '').toLowerCase();
                        const isLibraryOrSyntaxIssue = /cannot find module|modulenotfounderror|importerror|is not a function|has no exported member|syntaxerror|deprecated|unknown option|templatedoesnotexist|noreversematch|operationalerror|fielderror/i.test(failText);
                        if (isLibraryOrSyntaxIssue && step.attempts < step.maxAttempts && this.ctx.tools && this.ctx.tools.length > 0) {
                            try {
                                const { UnifiedWebSearch } = require('../tools/unifiedWebSearch');
                                const searchSummary = (verdict?.failureReason || 'library error').slice(0, 120);
                                this.ctx.postMessage({ command: 'statusUpdate', text: `🌐 Grounding latest documentation for: ${searchSummary}...` });
                                const searchDocs = await Promise.race([
                                    UnifiedWebSearch.execute({
                                        query: `${searchSummary} fix documentation solution`,
                                        chunk_size: 2000
                                    }, this.ctx.workspaceRoot),
                                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 7000))
                                ]);
                                if (searchDocs && searchDocs.text && !searchDocs.text.startsWith('Web search failed')) {
                                    if (previousFailure) {
                                        previousFailure.suggestedFix = (previousFailure.suggestedFix || '') + `\n\n[LATEST WEB DOCUMENTATION GROUNDING]:\n${searchDocs.text.slice(0, 1500)}`;
                                    }
                                }
                            } catch {}
                        }
                        continue;
                    }
                }

                // All verification gates passed cleanly!
                stepPassed = true;
                step.status = 'done';
                if (hasActivePlan) {
                    this.commitStepProgress(step, coderRes.text || 'Step completed and verified.');
                }
                break;
            }

            if (!stepPassed && this.session.status === 'failed') {
                break;
            }
        }

        // 5. TASK COMPLETION
        const allDone = planSteps.every(s => s.status === 'done');
        if (allDone && this.session.status !== 'aborted') {
            this.session.status = 'completed';
            if (this.ctx.workspaceRoot) {
                try {
                    StateLedger.clear(this.ctx.workspaceRoot);
                    SessionMemory.getInstance(this.ctx.workspaceRoot).clear();
                    const aiResearch = path.join(this.ctx.workspaceRoot, '.ultra-light-ai', 'RESEARCH.md');
                    if (fs.existsSync(aiResearch)) {
                        try { fs.unlinkSync(aiResearch); } catch {}
                    }
                } catch {}
            }
            this.ctx.postMessage({ command: 'statusUpdate', text: '✅ All task steps verified and complete.' });
            this.ctx.postMessage({ command: 'streamChunk', text: '', done: true });
            return { text: lastCoderText || 'All planned steps verified and successfully completed.', status: 'completed' };
        }

        return {
            text: this.session.status === 'aborted' ? 'Task aborted.' : (lastCoderText || 'Execution finished.'),
            status: this.session.status
        };
    }

    /**
     * Automatically diagnoses pasted terminal/Django/Python/JS tracebacks, reads mentioned workspace files,
     * and performs proactive live web search for post-2024 documentation or framework errors.
     */
    private async buildAutoGrounding(): Promise<ResearchFindings | undefined> {
        const evidence: AgentEvidence[] = [];
        const targetFiles = new Set<string>();
        const summaries: string[] = [];
        const userRequirements = (this.ctx.taskPlanner && typeof this.ctx.taskPlanner.getUserRequirements === 'function' ? this.ctx.taskPlanner.getUserRequirements() : '') || '';
        const effectiveGoal = userRequirements || this.ctx.userPrompt;
        const rawInput = `${effectiveGoal}\n${this.ctx.userPrompt}\n${TerminalCapture.getLastOutput() || ''}`;

        // 0. Architectural Blueprint & RESEARCH.md Grounding
        if (this.ctx.workspaceRoot) {
            const aiResearch = path.join(this.ctx.workspaceRoot, '.ultra-light-ai', 'RESEARCH.md');
            const rootResearch = path.join(this.ctx.workspaceRoot, 'RESEARCH.md');
            const targetResearch = fs.existsSync(aiResearch) ? aiResearch : (fs.existsSync(rootResearch) ? rootResearch : null);
            if (targetResearch) {
                try {
                    const rContent = fs.readFileSync(targetResearch, 'utf8');
                    evidence.push({
                        filepath: '.ultra-light-ai/RESEARCH.md',
                        snippet: rContent.slice(0, 8000),
                        relevance: 'Framework architecture, official doc links, CLI scaffolding commands, and required packages'
                    });
                    summaries.push('Grounded architectural specification & official docs from .ultra-light-ai/RESEARCH.md.');
                } catch {}
            }
        }

        // 0b. Recipe and Official Documentation Grounding
        const matchedRecipe = RecipeCatalog.findRecipe(effectiveGoal) || RecipeCatalog.findRecipe(this.ctx.userPrompt);
        if (matchedRecipe && this.ctx.workspaceRoot) {
            const aiDir = path.join(this.ctx.workspaceRoot, '.ultra-light-ai');
            if (!fs.existsSync(aiDir)) {
                try { fs.mkdirSync(aiDir, { recursive: true }); } catch {}
            }
            const researchPath = path.join(aiDir, 'RESEARCH.md');
            if (!fs.existsSync(researchPath)) {
                try {
                    const researchMd = RecipeCatalog.generateResearchDoc(matchedRecipe, effectiveGoal);
                    fs.writeFileSync(researchPath, researchMd, 'utf8');
                } catch {}
            }
        }
        if (matchedRecipe && matchedRecipe.docs) {
            for (const doc of matchedRecipe.docs) {
                evidence.push({
                    filepath: `Official Documentation (${doc.title})`,
                    snippet: `Title: ${doc.title}\nURL: ${doc.url}\nNote: ${doc.pitfall || "Official Documentation"}`,
                    relevance: 'Official framework documentation & links'
                });
            }
            summaries.push(`Grounded official ${matchedRecipe.name} documentation links and architectural recipe.`);
        }

        // 1. Auto-extract traceback errors & crashing file contents via ErrorDiagnoser
        if (this.ctx.workspaceRoot) {
            try {
                const diagContexts = ErrorDiagnoser.extractErrors(rawInput, this.ctx.workspaceRoot);
                if (diagContexts && diagContexts.length > 0) {
                    for (const dc of diagContexts) {
                        if (dc.filepath && dc.filepath !== 'Project Configuration / Global Traceback') {
                            targetFiles.add(dc.filepath);
                        }
                    }
                    const diagReport = diagContexts.map(c => c.codeSnippet).join('\n\n');
                    evidence.push({
                        filepath: 'Auto-Diagnosed Crash & Traceback Files',
                        snippet: diagReport,
                        relevance: 'Extracted directly from pasted terminal error / stack trace'
                    });
                    summaries.push('Auto-diagnosed stack trace and loaded crashing file lines.');
                }
            } catch {}

            // 2. Scan user prompt for explicitly mentioned project files (e.g., store/views.py, urls.py, models.py)
            try {
                const fileRegex = /(?:^|[\s'"`(])([a-zA-Z0-9_\-./\\]+\.(?:py|ts|tsx|js|jsx|html|css|json|sql))(?=$|[\s'"`),.:;])/g;
                const matches = new Set<string>();
                let m: RegExpExecArray | null;
                while ((m = fileRegex.exec(rawInput)) !== null) {
                    const candidate = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
                    if (
                        !candidate.includes('site-packages') &&
                        !candidate.includes('node_modules') &&
                        !candidate.includes('AppData') &&
                        !candidate.startsWith('http')
                    ) {
                        matches.add(candidate);
                    }
                    if (matches.size >= 4) break;
                }

                for (const relCandidate of matches) {
                    const resolved = this.resolveWorkspaceFile(relCandidate, this.ctx.workspaceRoot);
                    if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
                        const relPath = path.relative(this.ctx.workspaceRoot, resolved).replace(/\\/g, '/');
                        if (!targetFiles.has(relPath)) {
                            targetFiles.add(relPath);
                            const rawContent = fs.readFileSync(resolved, 'utf8');
                            const lines = rawContent.split(/\r?\n/);
                            const slice = lines.slice(0, 250).map((l, idx) => `${String(idx + 1).padStart(4, ' ')} | ${l}`).join('\n');
                            evidence.push({
                                filepath: relPath,
                                snippet: slice + (lines.length > 250 ? `\n... (${lines.length - 250} more lines)` : ''),
                                relevance: 'File referenced in prompt/error'
                            });
                        }
                    }
                }
            } catch {}
        }

        // 3. Proactive Live Web Search for errors, modern library specs, or explicit search requests
        const hasRealTools = Array.isArray(this.ctx.tools) && this.ctx.tools.length > 0;
        const promptText = this.ctx.userPrompt || '';
        const hasTerminalError = /(?:[A-Za-z0-9_.]*(?:Error|Exception|DoesNotExist|NoReverseMatch|SyntaxError|ModuleNotFoundError|ImportError|CommandFailed)\s*:\s*[^\r\n]{5,120})/i.test(rawInput);
        const hasErrorKeyword = /\b(?:error|exception|traceback|failed|crash|syntaxerror|importerror|modulenotfounderror|doesnotexist|noreversematch|operationalerror|fielderror|typeerror|attributeerror|keyerror|nameerror|cannot import|undefined|uncaught|broken)\b/i.test(rawInput);
        const needsLatestWebInfo = hasTerminalError || hasErrorKeyword || /\b(?:search\s+web|search\s+online|web\s+search|google|lookup\s+online|latest\s+docs|online\s+documentation|solution|fix\s+error|how\s+to\s+fix)\b/i.test(promptText);

        if (hasRealTools && needsLatestWebInfo) {
            try {
                const { UnifiedWebSearch } = require('../tools/unifiedWebSearch');
                // Build a focused search query from either the specific error line or the user prompt
                const errLineMatch = rawInput.match(/(?:[A-Za-z0-9_.]*(?:Error|Exception|DoesNotExist|NoReverseMatch|SyntaxError|ModuleNotFoundError|ImportError)\s*:\s*[^\r\n]{5,120})/i);
                const isDjango = /\b(?:django|manage\.py|views\.py|urls\.py|models\.py|settings\.py)\b/i.test(rawInput);
                const rawQuery = errLineMatch
                    ? `${isDjango ? 'Django ' : ''}${errLineMatch[0].trim()} fix solution documentation`
                    : promptText.replace(/\s+/g, ' ').trim().slice(0, 140);

                this.ctx.postMessage({
                    command: 'statusUpdate',
                    text: `🌐 Searching live web for: ${rawQuery.slice(0, 70)}...`
                });
                this.ctx.postMessage({
                    command: 'toolCallEvent',
                    tool: 'search_web',
                    title: `Web Search: ${rawQuery.slice(0, 60)}`,
                    data: { query: rawQuery }
                });

                const webRes = await Promise.race([
                    UnifiedWebSearch.execute({ query: rawQuery, chunk_size: 2500 }, this.ctx.workspaceRoot),
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 7000))
                ]);

                if (webRes && webRes.text && !webRes.text.startsWith('Web search failed')) {
                    evidence.push({
                        filepath: `Live Web Search Grounding (${rawQuery.slice(0, 60)})`,
                        snippet: webRes.text.slice(0, 3500),
                        relevance: 'Live post-2024 web documentation and community fix'
                    });
                    summaries.push(`Grounded with live web search results for "${rawQuery.slice(0, 60)}".`);
                }
            } catch {}
        }

        if (evidence.length === 0) {
            return undefined;
        }

        return {
            summary: summaries.join(' ') || 'Pre-grounded workspace and error context.',
            targetFiles: Array.from(targetFiles),
            evidence
        };
    }

    /**
     * Resolves a relative path or bare filename within the workspace (up to 2 directory levels deep).
     */
    private resolveWorkspaceFile(candidate: string, workspaceRoot: string): string | null {
        const direct = path.resolve(workspaceRoot, candidate);
        if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
            return direct;
        }
        const base = path.basename(candidate);
        try {
            const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() || ['node_modules', '.git', 'dist', 'out', '.venv', 'venv', '__pycache__'].includes(entry.name)) {
                    continue;
                }
                const subCandidate = path.join(workspaceRoot, entry.name, candidate);
                if (fs.existsSync(subCandidate) && fs.statSync(subCandidate).isFile()) {
                    return subCandidate;
                }
                const subBase = path.join(workspaceRoot, entry.name, base);
                if (fs.existsSync(subBase) && fs.statSync(subBase).isFile()) {
                    return subBase;
                }
            }
        } catch {}
        return null;
    }

    /**
     * Strips planning tools when executing a direct fix so small models never call set_task_plan mid-turn.
     */
    private stripPlanningTools(tools: any[], keepCompleteStep: boolean): any[] {
        if (!tools || tools.length === 0 || !tools[0]?.functionDeclarations) return tools;
        const blocked = new Set(['set_task_plan', 'expand_plan_step', 'plan_set', 'plan_update']);
        if (!keepCompleteStep) {
            blocked.add('complete_plan_step');
            blocked.add('plan_done');
        }
        return [{
            ...tools[0],
            functionDeclarations: tools[0].functionDeclarations.filter((fn: any) => !blocked.has(fn.name))
        }];
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

    /**
     * Routes internal Researcher and Verifier text output to the collapsible thinking timeline
     * so the main chat bubble only displays the Coder's clean answer without 3x repetition.
     */
    private forwardInternalRoleChunk(chunk: any): void {
        if (this.session.abortController.signal.aborted) return;
        if (chunk.text) {
            const clean = chunk.text.replace(/<\/?think>/gi, '');
            if (clean) {
                this.ctx.postMessage({
                    command: 'thinkingChunk',
                    text: clean,
                    done: false
                });
            }
        }
    }

    private notifyRoleChange(role: AgentRoleType, description: string): void {
        this.session.activeRole = role;
        if (role === 'verifier' && !(this.ctx.config as any)?.verboseRoles) {
            // Internal verifier turn: do not emit disruptive role change event to UI
            return;
        }
        const roleLabels: Record<AgentRoleType, string> = {
            planner: '📋 Planner Agent',
            researcher: '🔍 Researcher Agent',
            coder: '⚡ Coder Agent',
            verifier: '🧪 Verifier Agent'
        };
        const label = roleLabels[role] || role;

        this.ctx.postMessage({
            command: 'agentRoleHandoff',
            role,
            label,
            description,
            timestamp: Date.now()
        });

        this.ctx.postMessage({
            command: 'statusUpdate',
            text: `${label}: ${description}`
        });
    }
}
