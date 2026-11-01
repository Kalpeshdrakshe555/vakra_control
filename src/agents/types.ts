// src/agents/types.ts
// Typed contracts and schemas for the Deterministic Multi-Agent System.

export type AgentRoleType = 'planner' | 'researcher' | 'coder' | 'verifier';

export type TaskStatePhase =
    | 'idle'
    | 'planning'
    | 'awaiting_plan_approval'
    | 'researching'
    | 'coding'
    | 'verifying'
    | 'recovering'
    | 'completed'
    | 'failed'
    | 'aborted';

export interface AgentEvidence {
    filepath: string;
    startLine?: number;
    endLine?: number;
    symbols?: string[];
    snippet?: string;
    relevance: string;
}

export interface ResearchFindings {
    summary: string;
    targetFiles: string[];
    evidence: AgentEvidence[];
    externalDocs?: Array<{ title: string; url: string; extract: string }>;
    recommendedApproach?: string;
}

export interface CodeChangeSpec {
    filepath: string;
    action: 'create' | 'edit';
    reason: string;
    diffSnippet?: string;
}

export interface CoderResult {
    summary: string;
    changes: CodeChangeSpec[];
    blueprint?: {
        targetFiles: string[];
        logicAddedOrModified: string;
        verificationCommandSuggestion?: string;
    };
}

export interface VerificationCheck {
    name: string; // e.g. "Terminal Command Verification", "AST Diagnostics Check", "File Syntax Guard"
    status: 'passed' | 'failed' | 'skipped' | 'unavailable';
    command?: string;
    exitCode?: number;
    outputSnippet?: string;
    errorSnippet?: string;
}

export interface VerificationResult {
    passed: boolean;
    checks: VerificationCheck[];
    summary: string;
    failureReason?: string;
    suggestedFix?: string;
    rawOutput?: string;
    exitCode?: number;
}

export interface TaskStepContract {
    id: string; // e.g., "1.1" or "1"
    parentId: number; // e.g., 1
    title: string;
    acceptanceCriteria: string[];
    status: 'pending' | 'in_progress' | 'verifying' | 'done' | 'failed';
    attempts: number;
    maxAttempts: number;
    research?: ResearchFindings;
    codeResult?: CoderResult;
    verdict?: VerificationResult;
}

export interface OrchestratorBudget {
    maxTotalTokens: number;
    usedTotalTokens: number;
    maxToolIterations: number;
    usedToolIterations: number;
    maxStepRetries: number;
    timeoutSeconds: number;
}

export interface OrchestratorTaskSession {
    sessionId: string;
    userPrompt: string;
    workspaceRoot: string;
    status: TaskStatePhase;
    activeRole: AgentRoleType;
    activeStepId?: string;
    budget: OrchestratorBudget;
    plan: TaskStepContract[];
    historySummaries: string[];
    lastFailedCommand: string | null;
    abortController: AbortController;
    isFastPath?: boolean;
}

export interface RoleTurnInput {
    role: AgentRoleType;
    userPrompt: string;
    workspaceRoot: string;
    modelName?: string;
    activeStep?: TaskStepContract;
    researchFindings?: ResearchFindings;
    coderResult?: CoderResult;
    previousFailure?: VerificationResult;
    planStepsSummary?: string;
    stateLedgerSummary?: string;
    systemInstruction?: string;
    signal?: AbortSignal;
}

export interface RoleTurnResult {
    role: AgentRoleType;
    text: string;
    toolCallsExecuted: Array<{ tool: string; args: any; result: any }>;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    research?: ResearchFindings;
    codeResult?: CoderResult;
    verification?: VerificationResult;
    planCreated?: boolean;
    stepCompleted?: boolean;
    taskFinished?: boolean;
}
