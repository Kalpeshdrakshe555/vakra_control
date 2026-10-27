// src/agents/prompts/rolePrompts.ts
// Compact, role-specific prompt templates and context builders.

import { AgentRoleType, TaskStepContract, ResearchFindings, CoderResult, VerificationResult } from '../types';
import { estimateTokens, truncateToTokens } from '../../utils/tokenBudget';

export interface PromptContextOptions {
    workspaceRoot?: string;
    userPrompt: string;
    activeStep?: TaskStepContract;
    research?: ResearchFindings;
    coderResult?: CoderResult;
    previousFailure?: VerificationResult;
    planSummary?: string;
    stateLedgerSummary?: string;
    repoMap?: string;
    conventions?: string;
}

export class RolePromptBuilder {
    /**
     * Builds the static role-specific system instruction.
     */
    public static buildSystemInstruction(role: AgentRoleType, conventions?: string): string {
        switch (role) {
            case 'planner':
                return `You are the PLANNER agent in an autonomous multi-agent coding system.
Your job is to analyze user requirements and establish a concrete, verifiable roadmap.

RULES:
1. Always formulate sequential high-level steps using 'set_task_plan(user_requirements, steps[])'.
2. Each step must be clear, actionable, and accompanied by concrete verification criteria.
3. You are strictly FORBIDDEN from writing, editing, or executing code.
4. You act ONLY by invoking planning tools ('set_task_plan', 'expand_plan_step', 'read_state_ledger', 'list_directory_tree', 'read_multiple_files').
5. Stop and present the plan for user approval before any code modifications occur.`;

            case 'researcher':
                return `You are the RESEARCHER agent in an autonomous multi-agent coding system.
Your job is to gather precise, evidence-backed code references, symbols, and documentation for the active task.

RULES:
1. You are strictly READ-ONLY. You cannot write files, edit code, or run shell execution commands.
2. Inspect target files, symbol outlines, and documentation using your allowed tools ('read_multiple_files', 'search_codebase', 'list_directory_tree', 'get_symbol_outline', 'get_code_diagnostics', 'search_web').
3. Keep file inspections bounded: inspect only relevant files with specific line ranges where possible.
4. Output concise, evidence-backed findings citing exact file paths, line numbers, and symbols found.`;

            case 'coder':
                return `You are the CODER agent in an autonomous multi-agent coding system.
Your job is to surgically implement approved changes for the active task step.

RULES:
1. Implement the requested logic using 'write_file' (for new files) or 'edit_file' (for surgical modifications).
2. Never guess code, paths, or function signatures. Base your edits on the provided research evidence and target file lines.
3. You are strictly FORBIDDEN from running terminal verification commands, marking steps complete, or calling finish.
4. Always produce clean, robust, production-quality code with no placeholders or lazy ellipsis.
${conventions ? `\n[PROJECT CONVENTIONS]:\n${conventions}` : ''}`;

            case 'verifier':
                return `You are the VERIFIER agent in an autonomous multi-agent coding system.
Your job is to independently evaluate code changes, run verification tests, inspect diagnostics, and confirm completion.

RULES:
1. You are strictly an evaluator. You cannot write or edit project files.
2. Run appropriate, non-daemon verification commands using 'execute_terminal_command' (e.g. build, test, check scripts).
3. Inspect active compiler/LSP diagnostics using 'get_code_diagnostics'.
4. EMPIRICAL PROOF ONLY: Never invent or assume test results. Base your verdict strictly on real process exit codes and error output.
5. If tests or diagnostics fail: state the exact error, failing file, and line, so the Coder can perform a targeted correction.
6. If and only if all checks pass: mark the step complete using 'complete_plan_step' or finalize with 'finish'.`;
        }
    }

    /**
     * Builds the turn prompt for the active role with bounded, relevant context.
     */
    public static buildTurnPrompt(role: AgentRoleType, opts: PromptContextOptions): string {
        const sections: string[] = [];

        // 1. User Prompt / Goal
        sections.push(`### TASK OBJECTIVE\n${opts.userPrompt.trim()}`);

        // 2. Active Step (if in execution phase)
        if (opts.activeStep) {
            const criteria = opts.activeStep.acceptanceCriteria && opts.activeStep.acceptanceCriteria.length > 0
                ? `\nAcceptance Criteria:\n${opts.activeStep.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`
                : '';
            sections.push(`### ACTIVE STEP: ${opts.activeStep.id} - ${opts.activeStep.title}${criteria}`);
        }

        // 3. Current Plan Summary (compact)
        if (opts.planSummary) {
            const planTok = estimateTokens(opts.planSummary);
            const clampedPlan = planTok > 800 ? truncateToTokens(opts.planSummary, 800) : opts.planSummary;
            sections.push(`### PROJECT PLAN (PLAN.md)\n${clampedPlan}`);
        }

        // 4. Role-specific context payloads
        if (role === 'planner') {
            if (opts.repoMap) {
                const mapTok = estimateTokens(opts.repoMap);
                const clampedMap = mapTok > 1000 ? truncateToTokens(opts.repoMap, 1000) : opts.repoMap;
                sections.push(`### REPOSITORY STRUCTURE MAP\n${clampedMap}`);
            }
            sections.push(`### DIRECTIVE
Create a sequential macro roadmap using 'set_task_plan'. Ensure each step has verifiable acceptance criteria.`);
        } else if (role === 'researcher') {
            sections.push(`### DIRECTIVE
Investigate the codebase for Step ${opts.activeStep?.id || ''}. Identify target files, imports, classes, and required changes. Call 'read_multiple_files' or 'search_codebase'.`);
        } else if (role === 'coder') {
            if (opts.research) {
                let evidenceStr = `Summary: ${opts.research.summary}\nTarget Files: ${opts.research.targetFiles.join(', ')}`;
                if (opts.research.evidence && opts.research.evidence.length > 0) {
                    evidenceStr += '\nEvidence:\n' + opts.research.evidence.map(e => `- ${e.filepath}: ${e.snippet || e.relevance}`).join('\n');
                }
                const evTok = estimateTokens(evidenceStr);
                const clampedEv = evTok > 1500 ? truncateToTokens(evidenceStr, 1500) : evidenceStr;
                sections.push(`### RESEARCH EVIDENCE\n${clampedEv}`);
            }

            if (opts.previousFailure) {
                sections.push(`### PREVIOUS VERIFICATION FAILURE (CORRECTION REQUIRED)
Failure Reason: ${opts.previousFailure.failureReason || 'Verification check failed'}
Exit Code: ${opts.previousFailure.exitCode !== undefined ? opts.previousFailure.exitCode : 'N/A'}
Error Output:
\`\`\`
${(opts.previousFailure.rawOutput || opts.previousFailure.failureReason || '').slice(-1500)}
\`\`\`
Suggested Fix: ${opts.previousFailure.suggestedFix || 'Analyze the failing file and correct the syntax/logic.'}

CRITICAL: Fix the exact error above using 'edit_file' or 'write_file'.`);
            }

            sections.push(`### DIRECTIVE
Implement the changes for Step ${opts.activeStep?.id || ''} surgically using 'write_file' or 'edit_file'.`);
        } else if (role === 'verifier') {
            if (opts.coderResult) {
                sections.push(`### CODER IMPLEMENTATION RECORD
Summary: ${opts.coderResult.summary}
Files Touched: ${opts.coderResult.changes.map(c => `${c.filepath} (${c.action})`).join(', ') || 'None reported'}`);
            }

            sections.push(`### DIRECTIVE
Independently verify the changes.
1. Run tests or build verification commands via 'execute_terminal_command'.
2. Or check compiler diagnostics via 'get_code_diagnostics'.
3. If checks pass, authorize completion with 'complete_plan_step' or 'finish'.
4. If checks fail, clearly explain the error so Coder can fix it.`);
        }

        // 5. State Ledger compact slice (for background continuity)
        if (opts.stateLedgerSummary) {
            const ledgTok = estimateTokens(opts.stateLedgerSummary);
            const clampedLedg = ledgTok > 800 ? truncateToTokens(opts.stateLedgerSummary, 800) : opts.stateLedgerSummary;
            sections.push(`### STATE LEDGER\n${clampedLedg}`);
        }

        return sections.join('\n\n');
    }
}
