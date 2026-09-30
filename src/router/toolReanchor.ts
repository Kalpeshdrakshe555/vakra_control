// src/router/toolReanchor.ts
// Tail re-anchoring + tool-call repair for small local models at 40k+ context.

export interface ToolSpec {
    name: string;
    /** One-line usage, e.g. read_multiple_files(filepaths: string[]) */
    signature: string;
    parameters: { properties: Record<string, unknown>; required?: string[] };
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: any;
    name?: string;
}

export interface AgentLedger {
    goal: string;
    planStepText?: string;        // e.g. "2/5 Create catalog/views.py"
    filesTouched: string[];
    lastToolResult?: string;      // already truncated by caller
    lastError?: string;
    terminalTail?: string;        // from PromptBuilder.buildVolatile()
    sessionNotes?: string;
    consecutiveNoToolTurns: number;
}

export interface ParsedToolCall { name: string; args: Record<string, unknown>; }

/* ------------------------------------------------------------------ */
/* 1. Tail block                                                       */
/* ------------------------------------------------------------------ */

const clip = (s: string | undefined, n: number) =>
    !s ? '' : s.length > n ? s.slice(0, n) + '…' : s;

export function buildToolCard(tools: ToolSpec[]): string {
    return tools.map(t => `- ${t.signature}`).join('\n');
}

export function buildTailBlock(tools: ToolSpec[], ledger: AgentLedger): string {
    const strict = ledger.consecutiveNoToolTurns > 0;
    const lines: string[] = [];
    lines.push('[STATE]');
    lines.push(`Goal: ${clip(ledger.goal, 300)}`);
    if (ledger.planStepText) lines.push(`Current step: ${ledger.planStepText}`);
    if (ledger.filesTouched.length) lines.push(`Files touched: ${ledger.filesTouched.slice(-8).join(', ')}`);
    if (ledger.lastError) lines.push(`Last error: ${clip(ledger.lastError, 400)}`);
    else if (ledger.lastToolResult) lines.push(`Last result: ${clip(ledger.lastToolResult, 300)}`);
    if (ledger.terminalTail && ledger.terminalTail !== ledger.lastToolResult) {
        lines.push(`Terminal (last lines):\n${ledger.terminalTail}`);
    }
    if (ledger.sessionNotes) {
        lines.push(`Notes: ${ledger.sessionNotes}`);
    }
    lines.push('');
    lines.push('[TOOLS: respond with exactly ONE tool call as JSON: {"name": "...", "args": {...}}]');
    lines.push(buildToolCard(tools));
    lines.push('When the goal is fully done, reply {"name":"final_answer","args":{"summary":"..."}}.');
    if (strict) {
        lines.push(
            `WARNING: your last ${ledger.consecutiveNoToolTurns} reply(ies) had no tool call. ` +
            'Output ONLY the JSON tool call. No prose.'
        );
    }
    return lines.join('\n');
}

/**
 * Returns a copy of the history with the tail block appended as the LAST message.
 * The block is never stored in persistent history, so it doesn't accumulate.
 * Only re-anchors when needed to save tokens (always on for >= minTokens).
 */
export function withTailReanchor(
    history: ChatMessage[],
    tools: ToolSpec[],
    ledger: AgentLedger,
    estimatedTokens: number,
    opts: { minTokens?: number } = {}
): ChatMessage[] {
    const minTokens = opts.minTokens ?? 6000;
    if (estimatedTokens < minTokens && ledger.consecutiveNoToolTurns === 0) return history;
    return [...history, { role: 'user', content: buildTailBlock(tools, ledger) }];
}

/* ------------------------------------------------------------------ */
/* 2. Repair layer                                                     */
/* ------------------------------------------------------------------ */

/** Find the first balanced {...} in text (string-aware). If truncated, close it. */
export function extractJsonObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    const stack: string[] = [];
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); depth++; }
        else if (c === '}' || c === ']') {
            stack.pop(); depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    // Truncated: close open string and brackets
    let repaired = text.slice(start);
    if (inStr) repaired += '"';
    while (stack.length) repaired += stack.pop();
    return repaired;
}

function safeParse(s: string): any | null {
    try { return JSON.parse(s); } catch { }
    try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch { }
    return null;
}

/** Match naked args to a tool by key overlap. Requires all required keys. */
function matchToolByArgs(args: Record<string, unknown>, tools: ToolSpec[]): ToolSpec | null {
    const keys = Object.keys(args);
    let best: { t: ToolSpec; score: number } | null = null;
    for (const t of tools) {
        const props = Object.keys(t.parameters.properties ?? {});
        const req = t.parameters.required ?? [];
        if (!req.every(r => keys.includes(r))) continue;
        const overlap = keys.filter(k => props.includes(k)).length;
        if (overlap === 0 || overlap < keys.length) continue; // extra unknown keys = not a match
        const score = overlap * 10 - (props.length - overlap);
        if (!best || score > best.score) best = { t, score };
    }
    return best?.t ?? null;
}

/**
 * Accepts: native tool_calls (handled elsewhere), {"name","args"}, {"tool","arguments"},
 * {"function":{"name","arguments"}}, or NAKED args. Ignores conversational preamble.
 */
export function repairToolCall(raw: string, tools: ToolSpec[]): ParsedToolCall | null {
    const json = extractJsonObject(raw);
    if (!json) return null;
    const obj = safeParse(json);
    if (!obj || typeof obj !== 'object') return null;

    const names = new Set(tools.map(t => t.name));
    const fn = obj.function ?? obj;
    const name = fn.name ?? fn.tool ?? fn.tool_name ?? fn.action;
    let args = fn.args ?? fn.arguments ?? fn.parameters ?? fn.input;
    if (typeof args === 'string') args = safeParse(args);

    if (typeof name === 'string' && names.has(name)) {
        return { name, args: (args && typeof args === 'object') ? args : {} };
    }
    // Naked JSON
    const match = matchToolByArgs(obj, tools);
    if (match) return { name: match.name, args: obj };
    return null;
}

/* ------------------------------------------------------------------ */
/* 3. Constrained-decoding envelope (llama-server json_schema)         */
/* ------------------------------------------------------------------ */

export function buildActionSchema(tools: ToolSpec[]) {
    return {
        type: 'object',
        properties: {
            thought: { type: 'string', maxLength: 300 }, // short reasoning first helps 4B models
            name: { type: 'string', enum: [...tools.map(t => t.name), 'final_answer'] },
            args: { type: 'object' }
        },
        required: ['name', 'args'],
        additionalProperties: false
    };
}

/* ------------------------------------------------------------------ */
/* 4. Discipline loop (call from sidebarProvider agent loop)           */
/* ------------------------------------------------------------------ */

export interface DisciplineResult {
    call?: ParsedToolCall;
    retryWithConstraint: boolean;
    ledger: AgentLedger;
}

export function evaluateModelReply(
    reply: { text: string; nativeToolCalls?: ParsedToolCall[] },
    tools: ToolSpec[],
    ledger: AgentLedger,
    maxNudges = 2
): DisciplineResult {
    const native = reply.nativeToolCalls?.[0];
    const call = native ?? repairToolCall(reply.text, tools) ?? undefined;
    if (call) return { call, retryWithConstraint: false, ledger: { ...ledger, consecutiveNoToolTurns: 0 } };
    const n = ledger.consecutiveNoToolTurns + 1;
    return {
        retryWithConstraint: n >= maxNudges,       // after 2 failures, force json_schema on the next request
        ledger: { ...ledger, consecutiveNoToolTurns: n }
    };
}
