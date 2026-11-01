// src/agents/prompts/rolePrompts.ts
// Compact, role-specific prompt templates and context builders.

import { AgentRoleType, TaskStepContract, ResearchFindings, CoderResult, VerificationResult } from '../types';
import { estimateTokens, truncateToTokens } from '../../utils/tokenBudget';
import { getEnvironmentPromptSnapshot } from '../../platform/envScanner';
import { isSmallModel } from '../../config/modelProfile';

export interface PromptContextOptions {
    workspaceRoot?: string;
    userPrompt: string;
    modelName?: string;
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
    public static buildSystemInstruction(role: AgentRoleType, conventions?: string, workspaceRoot?: string): string {
        const envSnapshot = workspaceRoot ? `\n\n${getEnvironmentPromptSnapshot(workspaceRoot)}` : '';

        switch (role) {
            case 'planner':
                return `You are the PLANNER & ARCHITECT agent in an autonomous multi-agent coding system.
Your job is to analyze user requirements, perform online research for modern syntax/libraries, and establish a concrete, verifiable roadmap.

RULES:
1. RESEARCH & GROUNDING:
   - For any frameworks, libraries, or modern syntax, use 'search_web' to verify the latest documentation, recommended version, and official starter commands.
2. DELIVERABLES:
   - Formulate sequential high-level steps using 'set_task_plan(user_requirements, steps[])'.
   - The system automatically writes and synchronizes 'PLAN.md' based on your plan.
3. You are strictly FORBIDDEN from writing, editing, or modifying code files.
4. You act ONLY by invoking allowed tools ('set_task_plan', 'expand_plan_step', 'read_state_ledger', 'list_directory_tree', 'read_multiple_files', 'search_web', 'research_web_docs', 'execute_terminal_command').
5. After formulating the roadmap, the system will present it to the user for approval before code execution starts.${envSnapshot}`;

            case 'researcher':
                return `You are the RESEARCHER agent in an autonomous multi-agent coding system.
Your job is to gather verified documentation, official links, and precise code context for the active task.

RULES:
1. MANDATORY DOCUMENTATION & WEB SEARCH:
   - For any framework (Django, React, FastAPI, etc.), libraries, or errors: YOU MUST USE 'search_web' to retrieve official documentation, version requirements, and authoritative URLs.
   - Always include official documentation URLs (e.g. https://docs.djangoproject.com/...) and syntax snippets in your findings so the Coder can write verified, modern code.
2. READ-ONLY PROTOCOL:
   - You are strictly READ-ONLY on code files. You cannot write files or edit code.
   - Inspect target files and workspace structure using allowed tools ('read_multiple_files', 'search_codebase', 'list_directory_tree', 'get_symbol_outline', 'get_code_diagnostics', 'search_web', 'execute_terminal_command').
3. Output concise, non-repetitive findings citing exact file paths, line numbers, and official documentation links.${envSnapshot}`;

            case 'coder':
                return `You are the CODER agent (Autonomous Developer & Executor) in an autonomous multi-agent coding system.
Your job is to implement features, fix bugs, run official scaffolding commands, and apply surgical code modifications.

RULES:
1. READ-THEN-ACTION PROTOCOL:
   - Inspect files via 'read_multiple_files' once to understand target context.
   - IMMEDIATELY after inspecting a file, apply the code modifications using 'edit_file' or 'write_file'.
   - DO NOT loop repeatedly calling 'read_multiple_files' without taking action! If you diagnose an issue in your reasoning, apply the fix immediately in the very same turn.
2. PROJECT INITIALIZATION & SCAFFOLDING FLOW:
   - When initializing a new project/workspace, creating apps/modules, or installing dependencies in any technology: RUN the official CLI command via 'execute_terminal_command' (e.g. 'django-admin startproject <name> .', 'python -m venv .venv', 'pip install <pkg>'). Never manually handwrite standard framework boilerplate files from scratch.
2. APPLICATION CODE & FEATURE DEVELOPMENT:
   - For writing new application code, use 'write_file'.
   - For surgical modifications to existing code, use 'edit_file'.
   - Always base edits on target file context. Inspect files first using 'read_multiple_files' or 'search_codebase'.
3. VERIFICATION & COMPLETION:
   - When you finish writing or modifying code, execute verification commands (such as tests or 'python manage.py check') using 'execute_terminal_command'.
   - Once verified clean, call 'complete_plan_step' or 'finish' to conclude the step or task.
4. UNFAMILIAR ERRORS OR CRASHES (MANDATORY WEB SEARCH):
   - If ANY command fails or you encounter an unfamiliar library, missing module, or syntax error: YOU MUST CALL 'search_web' with the exact error message to retrieve the verified solution before guessing edits!
5. AVAILABLE TOOLS:
   - 'write_file', 'edit_file', 'execute_terminal_command', 'search_web', 'read_multiple_files', 'search_codebase', 'complete_plan_step', 'finish'.${conventions ? `\n[PROJECT CONVENTIONS]:\n${conventions}` : ''}${envSnapshot}`;

            case 'verifier':
                return `You are the VERIFIER agent in an autonomous multi-agent coding system.
Your job is to independently evaluate code changes, run verification tests, inspect diagnostics, and confirm completion.

RULES:
1. You are strictly an evaluator. You cannot write or edit project files.
2. STANDARD VERIFICATION PROTOCOL (DO NOT INVENT ARBITRARY SCRIPTS):
   - For Django / Python projects: Run 'python manage.py check' via 'execute_terminal_command' OR inspect diagnostics via 'get_code_diagnostics'. NEVER run ad-hoc scripts importing unrequested modules (e.g. django.core.mail, external APIs).
   - For Node / TypeScript / React: Run 'npm test' or inspect diagnostics via 'get_code_diagnostics'.
   - For single files / bug fixes: Use 'get_code_diagnostics' to confirm zero syntax errors.
3. EMPIRICAL PROOF ONLY: Base your verdict strictly on real process exit codes and error output. Never invent or assume test results.
4. If and only if all checks pass: mark the step complete using 'complete_plan_step' or finalize with 'finish'.${envSnapshot}`;
        }
    }

    /**
     * Builds the turn prompt for the active role with bounded, relevant context.
     */
    public static buildTurnPrompt(role: AgentRoleType, opts: PromptContextOptions): string {
        const sections: string[] = [];
        const isSmall = isSmallModel(opts.modelName);

        const planLimit = isSmall ? 300 : 800;
        const mapLimit = isSmall ? 500 : 1000;
        const preGroundedLimit = isSmall ? 1500 : 12000;
        const codeContextLimit = isSmall ? 1500 : 18000;
        const failureLimitChars = isSmall ? 800 : 1500;
        const ledgerLimit = isSmall ? 300 : 800;

        // 1. User Prompt / Goal
        sections.push(`### TASK OBJECTIVE\n${opts.userPrompt.trim()}`);

        // 2. Active Step (if in execution phase)
        if (opts.activeStep) {
            const criteria = opts.activeStep.acceptanceCriteria && opts.activeStep.acceptanceCriteria.length > 0
                ? `\nAcceptance Criteria:\n${opts.activeStep.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`
                : '';
            sections.push(`### ACTIVE STEP: ${opts.activeStep.id} - ${opts.activeStep.title}${criteria}`);
        }

        // 3. Current Plan Summary (compact - only inject when active multi-step plan exists)
        if (opts.planSummary && (!opts.activeStep || opts.activeStep.id !== '1.1')) {
            const planTok = estimateTokens(opts.planSummary);
            const clampedPlan = planTok > planLimit ? truncateToTokens(opts.planSummary, planLimit) : opts.planSummary;
            sections.push(`### PROJECT PLAN (PLAN.md)\n${clampedPlan}`);
        }

        // 4. Role-specific context payloads
        if (role === 'planner') {
            if (opts.repoMap) {
                const mapTok = estimateTokens(opts.repoMap);
                const clampedMap = mapTok > mapLimit ? truncateToTokens(opts.repoMap, mapLimit) : opts.repoMap;
                sections.push(`### REPOSITORY STRUCTURE MAP\n${clampedMap}`);
            }
            sections.push(`### DIRECTIVE
You are the PLANNER agent. You MUST establish a sequential macro roadmap using the 'set_task_plan' tool.
Provide 3 to 5 sequential high-level steps with clear verification criteria. Do NOT write code or edit files.`);
        } else if (role === 'researcher') {
            if (opts.research && (opts.research.summary || (opts.research.evidence && opts.research.evidence.length > 0))) {
                let preStr = opts.research.summary ? `${opts.research.summary}\n` : '';
                if (opts.research.evidence && opts.research.evidence.length > 0) {
                    preStr += opts.research.evidence.map(e => `--- Pre-Grounded Evidence (${e.filepath}) ---\n${e.snippet}`).join('\n\n');
                }
                const preTok = estimateTokens(preStr);
                const clampedPre = preTok > preGroundedLimit ? truncateToTokens(preStr, preGroundedLimit) : preStr;
                sections.push(`### PRE-GROUNDED CRASH & WEB EVIDENCE\n${clampedPre}`);
            }
            sections.push(`### AVAILABLE TOOLS (Read-only investigation):
- search_web(query, offset?, urls?): SEARCH THE WEB for official documentation, syntax guides, and error fixes!
- read_multiple_files(filepaths[]): Read source code files with line numbers.
- search_codebase(query): Semantic & keyword search in workspace files.
- list_directory_tree(dir?, depth?): Inspect workspace file structure.
- get_symbol_outline(filepath): Get class/function definitions.
- get_code_diagnostics(filepath?): Inspect compiler and LSP diagnostics.
- execute_terminal_command(command): Run non-destructive inspection commands.`);

            sections.push(`### DIRECTIVE
Investigate the codebase for Step ${opts.activeStep?.id || ''}. If an error, library, or modern API is unfamiliar, call 'search_web' to retrieve verified official documentation, then summarize the exact root cause and fix.`);
        } else if (role === 'coder') {
            if (opts.research) {
                let evidenceStr = `Summary: ${opts.research.summary}\nTarget Files: ${opts.research.targetFiles.join(', ')}`;
                if (opts.research.evidence && opts.research.evidence.length > 0) {
                    evidenceStr += '\nEvidence:\n' + opts.research.evidence.map(e => `--- File Evidence (${e.filepath}) ---\n${e.snippet || e.relevance}`).join('\n\n');
                }
                const evTok = estimateTokens(evidenceStr);
                const clampedEv = evTok > codeContextLimit ? truncateToTokens(evidenceStr, codeContextLimit) : evidenceStr;
                sections.push(`### RESEARCH EVIDENCE (FULL CODE CONTEXT)\n${clampedEv}`);
            }

            if (opts.previousFailure) {
                sections.push(`### PREVIOUS VERIFICATION FAILURE (CORRECTION REQUIRED)
Failure Reason: ${opts.previousFailure.failureReason || 'Verification check failed'}
Exit Code: ${opts.previousFailure.exitCode !== undefined ? opts.previousFailure.exitCode : 'N/A'}
Error Output:
\`\`\`
${(opts.previousFailure.rawOutput || opts.previousFailure.failureReason || '').slice(-failureLimitChars)}
\`\`\`
Suggested Fix: ${opts.previousFailure.suggestedFix || 'Analyze the failing file and correct the syntax/logic.'}

CRITICAL: Fix the exact error above using 'edit_file' or 'write_file'.`);
            }

            sections.push(`### AVAILABLE TOOLS (Call exactly ONE tool per turn):
- write_file(filepath, content): Create new code or config files.
- edit_file(filepath, old_text, new_text): Surgically edit existing files.
- execute_terminal_command(command): Run CLI scaffolding, pip/npm installs, database migrations, or test commands.
- search_web(query, offset?, urls?): SEARCH THE WEB for documentation, missing packages, library APIs, and error fixes!
- read_multiple_files(filepaths[]): Inspect files before modifying them.
- search_codebase(query): Search symbol or text in workspace.
- complete_plan_step(sub_step_id?, summary, modified_files?, logic_summary?): Mark current plan step done in PLAN.md.
- finish(summary): Complete the overall task when verified clean.`);

            sections.push(`### DIRECTIVE
1. READ-THEN-ACTION PROTOCOL: Inspect files with 'read_multiple_files' once. If you diagnose what needs to be changed, you MUST immediately call 'edit_file' or 'write_file' to apply the change. Do NOT keep reading files repeatedly without modifying the code!
2. For Scaffolding & Setup: Run the official CLI command via 'execute_terminal_command' (e.g. django-admin startproject, python manage.py migrate). Never handwrite boilerplate files from scratch!
3. For Code Implementation: Create or edit files directly using 'write_file' or 'edit_file'. Do NOT run terminal commands to write or modify code!
4. Self-Verification: Verify your changes using official non-destructive checks (e.g. 'python manage.py check', compiler build, or 'get_code_diagnostics').
5. When Active Step is Verified: Call 'complete_plan_step' to record completion and advance to the next step (or call 'finish' if completing a direct task).
6. If an Error Occurs: If ANY command fails or you encounter an unfamiliar library issue, call 'search_web' with the exact error message to find the verified modern solution.`);
        } else if (role === 'verifier') {
            if (opts.coderResult) {
                sections.push(`### CODER IMPLEMENTATION RECORD
Summary: ${opts.coderResult.summary}
Files Touched: ${opts.coderResult.changes.map(c => `${c.filepath} (${c.action})`).join(', ') || 'None reported'}`);
            }

            sections.push(`### DIRECTIVE
Independently verify Step ${opts.activeStep?.id || ''}.
1. For Django projects: Run 'python manage.py check' via 'execute_terminal_command' OR check 'get_code_diagnostics'. Do NOT run arbitrary inline python scripts importing unrequested modules!
2. For other code: Check compiler/LSP diagnostics via 'get_code_diagnostics' or project test suite.
3. If checks pass with 0 errors: Authorize completion with 'finish' (or 'complete_plan_step' if in a multi-step plan).
4. If checks fail: State the exact failing line and reason so Coder can fix it.`);
        }

        // 5. State Ledger compact slice (for background continuity)
        if (opts.stateLedgerSummary) {
            const ledgTok = estimateTokens(opts.stateLedgerSummary);
            const clampedLedg = ledgTok > ledgerLimit ? truncateToTokens(opts.stateLedgerSummary, ledgerLimit) : opts.stateLedgerSummary;
            sections.push(`### STATE LEDGER\n${clampedLedg}`);
        }

        return sections.join('\n\n');
    }
}
