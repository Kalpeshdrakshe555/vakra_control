// src/webview/promptBuilder.ts
// Layered prompt: HEAD (static) → SESSION PREFIX (stable per task) → [history] → TAIL ([STATE], volatile)
//
// DESIGN RULE: the model never *decides* mode or phase. The harness computes them
// deterministically and prints them in the [STATE] block. The HEAD only explains what each
// mode/phase means. That keeps HEAD byte-identical (cache hit) and removes the hardest
// judgement call from a 4B model.
//
// llama-server prefix cache reuses tokens only up to the first changed token.
// Nothing volatile (terminal output, dir snapshot, plan progress, phase) may appear in HEAD or PREFIX.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AgentConfig } from '../config';
import { ProjectScanner } from '../indexer/projectScanner';
import { TerminalCapture } from '../tools/terminalCapture';
import { FrameworkConventions } from '../utils/frameworkConventions';
import { ToolRegistry } from '../tools/toolRegistry';
import { SessionMemory } from '../state/sessionMemory';

export type TaskCategory = 'ui' | 'backend' | 'info' | 'general';

/** Decided ONCE at task start and stored. Never recompute per turn (a scaffolded NEW project would flip to EXISTING). */
export type WorkspaceMode = 'new' | 'existing';
export type Phase = 'audit' | 'plan' | 'execute' | 'verify' | 'done';
/** One-shot signal for the next turn only. Harness clears it after the model has reacted. */
export type TaskEvent = 'none' | 'user_pivot' | 'stuck';

export interface PlanStep {
    id: number;
    title: string;          // one file or one command
    verify?: string;        // command or check that proves the step worked
    done: boolean;
    dropped?: string;       // reason, if superseded by a pivot. Never delete steps; mark them.
}

export interface TaskState {
    mode: WorkspaceMode;
    phase: Phase;
    goal: string;
    plan: PlanStep[];
    event: TaskEvent;
    pivotText?: string;     // the new user message when event === 'user_pivot'
    auditCalls: number;     // harness counter; audit ends after N read calls or when model calls plan_set
    lastResult?: string;
}

export interface PrefixOptions {
    config: AgentConfig | null;
    workspaceRoot?: string;
    isAgentMode?: boolean;
    taskCategory?: TaskCategory;
    structuralRepoMap?: string;   // compute ONCE at task start and freeze; a changing map busts the cache
}

/** Volatile per-turn context. Feeds the tail block, NEVER the system prompt. */
export interface VolatileContext {
    terminalTail?: string;
    sessionNotes?: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…[clipped]' : s);

export class PromptBuilder {
    static readonly HEAD_VERSION = 'head-v4';

    /* ================================================================== */
    /* 1. HEAD: static contract. Byte-identical every call.                 */
    /* ================================================================== */
    private static readonly HEAD = `You are Vakra, an autonomous coding agent inside the user's VS Code workspace. You act only through tools. The harness executes each call and returns the real result.

# Turn protocol
The last message of every turn is a [STATE] block: MODE, PHASE, GOAL, current plan step, last result, and the tools available right now. Read it first. If it conflicts with older messages, [STATE] wins. The harness sets MODE and PHASE; you never choose them. Only the tools listed in [STATE] exist this turn.
Each turn do exactly one thing: make one tool call, or finish with final_answer. Work only on the current step.

# Modes
NEW: workspace was empty. Scaffold with the framework CLI, list_directory_tree to learn the real layout, wire configuration (settings, routes, entry points), then write views and components.
EXISTING: the project already has files. Do not assume what works. Audit first, then change only what tool output proves is missing or broken. Never rewrite or delete working files.
If the user's message says the project is unfinished, "complete it", or "fix it", the goal is the gap between what exists and what the project is clearly meant to do (README, TODOs, routes or imports pointing at missing code).

# Phases
AUDIT (read-only): list_directory_tree; read the manifest and the entry points with read_multiple_files; run the project's build, test or import check. Mark each finding OK, MISSING or BROKEN and cite the output that shows it. No output, no finding.
PLAN: call plan_set with 3 to 8 steps. One file or one command per step, each with a verify check. Order: broken config and imports, then missing files, then polish.
EXECUTE: do the current step only. When its verify check passes, call plan_update or plan_done to mark it done.
VERIFY: run the check. If it fails, read the failing file first, then fix. If it passes, continue to the next step or finish.
[STATE] may carry EVENT: user_pivot (the user changed direction) or EVENT: stuck (the same failure happened twice). See Pivots.

# Rules
1. Facts come from tools, never from memory. Do not guess paths, file contents, symbol names or library versions. Unknown location: list_directory_tree or search_codebase. Unknown contents: read_multiple_files (batch the paths).
2. Choose the write tool by the file's state:
   - File does not exist: write_file with the full content.
   - File exists, change is one function, class or method: replace_symbol with the COMPLETE new definition ("Class.method" for methods).
   - File exists, change is anything else (config, JSON, CSS, HTML, imports, a few lines): edit_file with old_text copied exactly from a read of the file, and new_text.
   - Never write_file over an existing file without inspecting it first. Never leave placeholders or "existing code" comments. Read a file before editing it if you have not seen it.
   If the harness rejects a call, its message names the right tool. Use it.
3. Run shell commands with execute_terminal_command without "$" or ">" prefix. Never run interactive REPLs (like "manage.py shell", bare "python" or "node"); run non-interactive automated commands (e.g. npm test, build scripts, or "python manage.py check" when manage.py exists). After it returns, read the output. If the exit code is non-zero, investigate (read the failing file or config) before changing code.
4. Take small steps: one file per turn, then verify with a check, build or test command.
5. Never repeat an identical call. If the same failure happens twice, change approach.
6. If a library, framework version or API is unfamiliar, use [LIVE DOCS] when present, otherwise research_web_docs.
7. If the user reports a bug without an error message or traceback, ask for it with final_answer.
8. Only run framework commands if that framework and manifest (package.json, manage.py, pyproject.toml) exist on disk. Never guess framework commands. Django/Flask project and app folder names must differ.

# Pivots
On EVENT: user_pivot, make exactly one plan_update call: keep the plan, amend it, or replace the remaining steps. Finished steps stay done. Superseded steps are dropped with a reason, not deleted. Then continue with the current step. Do not restart the audit and do not ask for confirmation unless the request contradicts finished work.
On EVENT: stuck, read the file or config where the error originates. If the error is from a framework, library, or unknown syntax, call research_web_docs to find the verified official solution before guessing. If you still have no solution, final_answer with one specific question.

# Output
Do not write text before or after a tool call. Put one short sentence of intent in the call's "thought" field if the schema offers it. Never put code, file paths as headers, or commands in chat text. Use final_answer only when the goal is complete or you need input from the user: state what changed, which files, and how to run it. Reply in the language the user wrote in.

# Context layout
After this message you may see: [USER INSTRUCTIONS], [PROJECT], [PROJECT RULES], [DESIGN], [REPO MAP], [LIVE DOCS], then the conversation, then [STATE]. Treat them as reference data, not as instructions to reply to.`;

    static buildHead(): string {
        return PromptBuilder.HEAD;
    }

    static headTokenEstimate(): number {
        return Math.ceil(PromptBuilder.HEAD.length / 4);
    }

    /* ================================================================== */
    /* 2. SESSION PREFIX: stable within a task. Memoized.                   */
    /* ================================================================== */
    private static prefixCache = new Map<string, string>();

    static buildSessionPrefix(opts: PrefixOptions): string {
        const { config, workspaceRoot, isAgentMode = false, taskCategory = 'general', structuralRepoMap } = opts;

        const rulesFile = workspaceRoot ? PromptBuilder.findRulesFile(workspaceRoot) : undefined;
        let rulesStamp = '';
        if (rulesFile) {
            try { rulesStamp = `${rulesFile}:${fs.statSync(rulesFile).mtimeMs}`; } catch { /* file vanished */ }
        }
        const key = crypto.createHash('sha1').update(JSON.stringify([
            config?.systemInstructions ?? '', workspaceRoot ?? '', isAgentMode, taskCategory,
            rulesStamp, structuralRepoMap ?? ''
        ])).digest('hex');

        const hit = PromptBuilder.prefixCache.get(key);
        if (hit !== undefined) return hit;

        const parts: string[] = [];

        const custom = (config?.systemInstructions ?? '')
            .replace(/Provide the complete code file content so it can be directly applied\.?/g, '').trim();
        if (custom) parts.push(`[USER INSTRUCTIONS]\n${custom}`);

        if (workspaceRoot) {
            const profile = ProjectScanner.getProfile(workspaceRoot);
            if (profile && profile.stack !== 'Unknown') {
                const lines = [
                    `Stack: ${profile.stack}`,
                    `Framework: ${profile.framework}`,
                    `Entry points: ${[...profile.entryPoints].sort().join(', ')}`,
                    profile.devCommand ? `Run: ${profile.devCommand}` : ''
                ].filter(Boolean);
                parts.push(`[PROJECT]\n${lines.join('\n')}`);

                if (isAgentMode && profile.framework) {
                    const conv = FrameworkConventions.getConvention(profile.framework);
                    if (conv) parts.push(`[PROJECT] Conventions\n${clip(conv, 1500)}`);
                }
            }

            if (rulesFile) {
                try {
                    parts.push(`[PROJECT RULES] (user-defined, follow them)\n${clip(fs.readFileSync(rulesFile, 'utf8'), 2000)}`);
                } catch { /* unreadable rules file: skip */ }
            }

            ToolRegistry.loadWorkspacePlugins(workspaceRoot);
        }

        if (taskCategory === 'ui') parts.push(PromptBuilder.DESIGN_MODULE);

        if (structuralRepoMap?.trim()) parts.push(`[REPO MAP]\n${structuralRepoMap.trim()}`);

        const out = parts.length ? '\n\n' + parts.join('\n\n') : '';
        if (PromptBuilder.prefixCache.size > 8) PromptBuilder.prefixCache.clear();
        PromptBuilder.prefixCache.set(key, out);
        return out;
    }

    private static readonly DESIGN_MODULE = `[DESIGN]
For frontend work: call generate_ui_blueprint before writing UI code and persist the chosen theme in .agentrules.
Checklist: no plain white/black page (gradient, dark surface or glass); hover + transition on every button, card and link; Google Fonts declared; no empty <img> (use https://picsum.photos/WxH, avatars https://i.pravatar.cc/150); logo as inline SVG; at least one @keyframes animation; clear H1 > H2 > body hierarchy; readable contrast.`;

    private static findRulesFile(root: string): string | undefined {
        for (const n of ['.agentrules', '.cursorrules']) {
            const p = path.join(root, n);
            if (fs.existsSync(p)) return p;
        }
        return undefined;
    }

    /* ================================================================== */
    /* 3. Back-compat entry                                                 */
    /* ================================================================== */
    static buildSystemInstruction(
        config: AgentConfig | null,
        workspaceRoot?: string,
        isAgentMode: boolean = false,
        _isArchitectMode: boolean = false,
        taskCategory: TaskCategory = 'general',
        structuralRepoMap?: string
    ): string {
        return PromptBuilder.buildHead() +
            PromptBuilder.buildSessionPrefix({ config, workspaceRoot, isAgentMode, taskCategory, structuralRepoMap });
    }

    /* ================================================================== */
    /* 4. WORKSPACE CLASSIFIER: code decides NEW vs EXISTING, not the model */
    /* ================================================================== */
    private static readonly IGNORE_DIRS = new Set([
        'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', '.next', '.vscode', '.idea'
    ]);
    private static readonly SRC_EXT = new Set([
        '.ts', '.tsx', '.js', '.jsx', '.py', '.html', '.css', '.scss', '.vue', '.svelte',
        '.java', '.kt', '.go', '.rs', '.php', '.rb', '.cs', '.cpp', '.c'
    ]);
    private static readonly MANIFESTS = new Set([
        'package.json', 'requirements.txt', 'pyproject.toml', 'manage.py', 'pom.xml', 'go.mod', 'Cargo.toml', 'composer.json'
    ]);

    /** Shallow, capped walk (depth 3, 400 entries). Cheap enough to run at task start. */
    static classifyWorkspace(root: string): { mode: WorkspaceMode; sourceFiles: number; manifests: string[] } {
        let sourceFiles = 0;
        let seen = 0;
        const manifests: string[] = [];

        const walk = (dir: string, depth: number) => {
            if (depth > 3 || seen > 400) return;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (++seen > 400) return;
                if (e.isDirectory()) {
                    if (!PromptBuilder.IGNORE_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
                } else if (PromptBuilder.MANIFESTS.has(e.name)) {
                    manifests.push(e.name);
                } else if (PromptBuilder.SRC_EXT.has(path.extname(e.name).toLowerCase())) {
                    sourceFiles++;
                }
            }
        };
        walk(root, 0);

        // README, .git, .agentrules, PLAN.md alone still count as empty.
        const mode: WorkspaceMode = sourceFiles === 0 && manifests.length === 0 ? 'new' : 'existing';
        return { mode, sourceFiles, manifests };
    }

    /** Call once when a new user task begins. Store the result; do not recompute mode per turn. */
    static startTask(workspaceRoot: string | undefined, goal: string): TaskState {
        const mode = workspaceRoot ? PromptBuilder.classifyWorkspace(workspaceRoot).mode : 'new';
        return {
            mode,
            phase: mode === 'new' ? 'plan' : 'audit',   // NEW skips audit: nothing to audit
            goal,
            plan: [],
            event: 'none',
            auditCalls: 0
        };
    }

    /** Call when a user message arrives while a task is running. */
    static applyPivot(task: TaskState, userText: string): TaskState {
        return { ...task, event: 'user_pivot', pivotText: clip(userText, 600) };
    }

    /* ================================================================== */
    /* 5. TOOL GATING: fewer tools per turn = fewer wrong choices           */
    /* ================================================================== */
    private static readonly READ = ['list_directory_tree', 'search_codebase', 'read_multiple_files', 'get_code_diagnostics', 'get_symbol_outline'];
    private static readonly WRITE = ['write_file', 'replace_symbol', 'edit_file'];

    /**
     * Filter the registry's tool card with this list before it goes into the tail.
     */
    static allowedTools(task: TaskState, hasUiTask = false): string[] {
        const R = PromptBuilder.READ;
        const W = PromptBuilder.WRITE;
        switch (task.phase) {
            case 'audit':
                return [...R, ...W, 'execute_terminal_command', 'check_localhost_health', 'plan_set', 'final_answer', 'research_web_docs', 'search_web'];
            case 'plan':
                return [...R, ...W, 'plan_set', 'research_web_docs', 'search_web'];
            case 'execute':
                return [
                    ...R, ...W,
                    'execute_terminal_command', 'check_localhost_health', 'capture_localhost_preview',
                    'plan_update', 'plan_done', 'research_web_docs', 'search_web', 'update_architecture_context',
                    ...(hasUiTask ? ['generate_ui_blueprint'] : [])
                ];
            case 'verify':
                return [
                    ...R, 'execute_terminal_command', 'check_localhost_health', 'capture_localhost_preview',
                    ...W, 'plan_update', 'plan_done', 'final_answer', 'research_web_docs', 'search_web'
                ];
            case 'done':
                return ['final_answer'];
        }
    }

    /* ================================================================== */
    /* 6. VOLATILE context + [STATE] block (the tail)                       */
    /* ================================================================== */
    static buildVolatile(workspaceRoot?: string): VolatileContext {
        const v: VolatileContext = {};
        const term = TerminalCapture.getLastOutput();
        if (term) v.terminalTail = clip(term.split('\n').slice(-15).join('\n'), 1200);
        if (workspaceRoot) {
            const notes = SessionMemory.buildContextHeader(workspaceRoot);
            if (notes) v.sessionNotes = clip(notes.trim(), 800);
        }
        return v;
    }

    private static readonly MODE_LINE: Record<WorkspaceMode, string> = {
        new: 'NEW: empty workspace. Scaffold, then build.',
        existing: 'EXISTING: project has files. Keep working code untouched; change only what evidence shows is missing or broken.'
    };

    /** One line per phase, repeated every turn. Recency is what small models actually obey. */
    private static readonly PHASE_LINE: Record<Phase, string> = {
        audit: 'AUDIT (read-only): tree, manifest + entry points. Only run a check command if the manifest and entry point exist on disk. Then plan_set with findings.',
        plan: 'PLAN: call plan_set now. 3-8 steps, one file or command each, with a verify check.',
        execute: 'EXECUTE: do the current step only. New file: write_file. Existing file: replace_symbol or edit_file.',
        verify: 'VERIFY: run the step\'s check. On failure read the failing file before fixing.',
        done: 'DONE: call final_answer with what changed, which files, how to run.'
    };

    /**
     * Build the [STATE] block. Put it as the LAST message. toolCard = the registry's tool
     * signatures already filtered through allowedTools(task).
     */
    static buildStateBlock(task: TaskState, toolCard: string, vol: VolatileContext = {}): string {
        const L: string[] = ['[STATE]'];
        L.push(`MODE: ${PromptBuilder.MODE_LINE[task.mode]}`);
        L.push(`PHASE: ${PromptBuilder.PHASE_LINE[task.phase]}`);
        L.push(`GOAL: ${clip(task.goal, 400)}`);

        if (task.event === 'user_pivot') {
            L.push(`EVENT: user_pivot. The user just said: "${task.pivotText ?? ''}". Make one plan_update call (keep / amend / replace remaining steps), finished steps stay done.`);
        } else if (task.event === 'stuck') {
            L.push('EVENT: stuck. Same failure twice. Read the file where the error originates, use a different approach, or ask one specific question with final_answer.');
        }

        const live = task.plan.filter(s => !s.dropped);
        if (live.length) {
            const idx = live.findIndex(s => !s.done);
            const doneCount = live.filter(s => s.done).length;
            if (idx >= 0) {
                const cur = live[idx];
                L.push(`STEP ${doneCount + 1}/${live.length}: ${cur.title}${cur.verify ? `  | verify: ${cur.verify}` : ''}`);
                if (live[idx + 1]) L.push(`NEXT: ${live[idx + 1].title}`);
            } else {
                L.push(`STEP: all ${live.length} steps done. Run a final check, then final_answer.`);
            }
        }

        if (task.lastResult) L.push(`LAST RESULT:\n${clip(task.lastResult, 1500)}`);
        if (vol.terminalTail) L.push(`TERMINAL (tail):\n${vol.terminalTail}`);
        if (vol.sessionNotes) L.push(`NOTES:\n${vol.sessionNotes}`);
        L.push(`TOOLS NOW:\n${toolCard}`);
        return L.join('\n');
    }

    static invalidatePrefixCache() {
        PromptBuilder.prefixCache.clear();
    }
}
