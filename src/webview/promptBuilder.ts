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
import { LivingIndex } from '../indexer/livingIndex';
import { SkillsManager } from '../features/skillsManager';

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
    isArchitectMode?: boolean;
    taskCategory?: TaskCategory;
    structuralRepoMap?: string;   // compute ONCE at task start and freeze; a changing map busts the cache
    thinkingBudget?: string;
    userText?: string;
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
    private static readonly HEAD = `You are an autonomous coding agent operating inside VS Code. You act ONLY by invoking tools.

# Micro-Kernel Execution Contract
RULES:
1. Every reply MUST be exactly ONE tool call. Never output source code, file blocks, or commands as plain chat text.
2. Create files with \`write_file\`. Modify existing files surgically with \`edit_file\`. Never use terminal commands (echo, cat, python -c) to write code.
3. Inspect before editing: call \`read_multiple_files\` first. Never guess paths or symbols.
4. When a SKILL is active, strictly follow its numbered checklist in exact order.
5. If a command or check fails: read the error, make the smallest surgical fix with \`edit_file\`, and re-test.
6. When all tasks and verification steps are complete, call \`finish\` with a 2-3 sentence summary.

TOOLS:
- list_directory_tree(path, depth)
- read_multiple_files(paths[])
- write_file(filepath, content)
- edit_file(filepath, old_text, new_text)
- execute_terminal_command(command)
- research_web_docs(query, urls[])
- finish(summary)`;

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
        const { config, workspaceRoot, isAgentMode = false, isArchitectMode = false, taskCategory = 'general', structuralRepoMap, thinkingBudget, userText = '' } = opts;

        const rulesFile = workspaceRoot ? PromptBuilder.findRulesFile(workspaceRoot) : undefined;
        let rulesStamp = '';
        if (rulesFile) {
            try { rulesStamp = `${rulesFile}:${fs.statSync(rulesFile).mtimeMs}`; } catch { /* file vanished */ }
        }
        const key = crypto.createHash('sha1').update(JSON.stringify([
            config?.systemInstructions ?? '', workspaceRoot ?? '', isAgentMode, isArchitectMode, taskCategory,
            rulesStamp, structuralRepoMap ?? '', thinkingBudget ?? '', userText
        ])).digest('hex');

        const hit = PromptBuilder.prefixCache.get(key);
        if (hit !== undefined) return hit;

        const parts: string[] = [];

        const custom = (config?.systemInstructions ?? '')
            .replace(/Provide the complete code file content so it can be directly applied\.?/g, '').trim();
        if (custom) parts.push(`[USER INSTRUCTIONS]\n${custom}`);

        if (thinkingBudget) {
            const b = thinkingBudget.toLowerCase();
            const tokenLimit = b === 'low' ? 500 : b === 'high' ? 1500 : 1000;
            parts.push(`[THINKING BUDGET: ${b.toUpperCase()} (< ${tokenLimit} tokens)]
Your reasoning thought budget is set to ${b.toUpperCase()} (strictly under ${tokenLimit} tokens).
- Maintain concise, structured, and focused internal deliberation.
- Do NOT ramble or repeat thought steps. Focus directly on determining the exact tool call or answer.`);
        }

        if (workspaceRoot) {
            // 1. Living Architecture Blueprint injection (4-Tier MRU & Dependency Graph)
            try {
                const bp = LivingIndex.buildBlueprintText(workspaceRoot, 4000);
                if (bp) parts.push(`[ACTIVE LIVING ARCHITECTURE BLUEPRINT]\n${bp}`);
            } catch {}

            // 2. Materialized Working Memory & Living State
            try {
                const mem = SessionMemory.getInstance(workspaceRoot).renderWorkingMemory(3500);
                if (mem) parts.push(mem);
            } catch {}

            // 3. Matching Specialized Skill (P0 Execution Guidance)
            try {
                const activeSkill = SkillsManager.getMatchingSkillInstructions(userText, workspaceRoot);
                if (activeSkill) {
                    parts.push(`### ACTIVE SPECIALIZED SKILL:\n${activeSkill}\n`);
                }
            } catch {}

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

        if (isArchitectMode) {
            parts.push(`[ARCHITECT MODE]
You are operating as a Senior Systems Architect:
1. Practical & Structured Architecture: Break down features into modular components, clear data flow, and reliable interfaces.
2. Flexible & Adaptive: Adapt dynamically to the situation. For existing projects, protect working code and touch only the necessary delta. For new projects, scaffold modular foundations.
3. Autonomous Execution: Execute steps directly without stopping to announce next steps in chat text. Implement code files completely without placeholders, verified by checks.`);
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
        isArchitectMode: boolean = false,
        taskCategory: TaskCategory = 'general',
        structuralRepoMap?: string,
        thinkingBudget?: string,
        userText?: string
    ): string {
        return PromptBuilder.buildHead() +
            PromptBuilder.buildSessionPrefix({ config, workspaceRoot, isAgentMode, isArchitectMode, taskCategory, structuralRepoMap, thinkingBudget, userText });
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
    private static readonly WRITE = ['create_skill', 'write_file', 'edit_file'];

    /**
     * Filter the registry's tool card with this list before it goes into the tail.
     */
    static allowedTools(task: TaskState, hasUiTask = false): string[] {
        const R = PromptBuilder.READ;
        const W = PromptBuilder.WRITE;
        switch (task.phase) {
            case 'audit':
                return [...R, ...W, 'execute_terminal_command', 'finish', 'research_web_docs', 'search_web'];
            case 'plan':
                return [...R, ...W, 'execute_terminal_command', 'finish', 'research_web_docs', 'search_web'];
            case 'execute':
                return [
                    ...R, ...W,
                    'execute_terminal_command',
                    'finish', 'research_web_docs', 'search_web',
                    ...(hasUiTask ? ['generate_ui_blueprint'] : [])
                ];
            case 'verify':
                return [
                    ...R, 'execute_terminal_command',
                    ...W, 'finish', 'research_web_docs', 'search_web'
                ];
            case 'done':
                return ['finish'];
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
            try {
                const notes = SessionMemory.getInstance(workspaceRoot).renderWorkingMemory(800);
                if (notes) v.sessionNotes = clip(notes.trim(), 800);
            } catch {}
        }
        return v;
    }

    private static readonly MODE_LINE: Record<WorkspaceMode, string> = {
        new: 'NEW: empty workspace. Scaffold, then build.',
        existing: 'EXISTING: project has files. Keep working code untouched; change only what evidence shows is missing or broken.'
    };

    /** One line per phase, repeated every turn. Recency is what small models actually obey. */
    private static readonly PHASE_LINE: Record<Phase, string> = {
        audit: 'AUDIT (read-only): inspect tree, manifest + entry points before modifying files.',
        plan: 'PLAN: follow active skill checklist in exact order.',
        execute: 'EXECUTE: perform surgical changes. New file: write_file. Existing file: edit_file.',
        verify: 'VERIFY: execute tests or verification commands. On failure read the failing file before fixing.',
        done: 'DONE: call finish with summary of changes.'
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
            L.push(`EVENT: user_pivot. The user just said: "${task.pivotText ?? ''}". Adapt execution accordingly.`);
        } else if (task.event === 'stuck') {
            L.push('EVENT: stuck. Same failure twice. Read the file where the error originates and apply a surgical fix.');
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
                L.push(`STEP: all ${live.length} steps done. Run a final check, then finish.`);
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
