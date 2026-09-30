# Adaptive Prompt Architecture: Rules in HEAD, State in TAIL, Enforcement in the Harness

The core design decision that solves all three pain points at once:

**The state machine is static *text* (HEAD); the state machine's *state* is volatile (TAIL `[STATE]` block); violations are bounced by harness guards, not by more prompt rules.**

A 4B model at turn 40 is not re-reading your head carefully — it is anchored on the last message. So the head teaches a *procedure*, and the tail says *where you are in it* every turn. Prompt rules are soft; guards are hard. That combination is what makes small models reliable without handcuffing them.

---

## 1. Layer placement

| Concern | Layer | Why |
|---|---|---|
| Universal loop (SURVEY→PLAN→EXECUTE→VERIFY→PIVOT) | HEAD | Byte-static, cache-safe |
| Greenfield vs brownfield *procedure* | HEAD | Universal, never changes |
| Edit-mode decision table (write vs replace) | HEAD | Mechanical, no judgment |
| Stack conventions, user rules, design module | SESSION PREFIX | Already correct, unchanged |
| **Workspace classification, current stage, plan, step pointer** | TAIL `[STATE]` | Volatile: changes with every plan/pivot/write |
| Stage-scoped tool card | TAIL | Already your pattern (toolReanchor) |
| Read-before-write, no-rescaffold, no-repeat | **Harness guards** | Not a prompt concern at all |

Note what is *deliberately not* in the prefix: the greenfield/brownfield verdict. Workspace state mutates as the agent works (empty → scaffolded), so baking the classification into the prefix would either lie after turn 3 or churn the cache key every write. Classification is a tool-fact the model establishes once in SURVEY and persists via `plan_set`.

---

## 2. HEAD v4 (drop-in replacement)

Same budget class as v3 (~950–1000 tokens by your 4-chars/token estimate). No interpolation, byte-identical per call. The scaffolding rule (your old rule 5) is now *conditional on classification* instead of being phase-ordered — that's the brownfield fix.

```ts
static readonly HEAD_VERSION = 'head-v4';

private static readonly HEAD = `You are Vakra, an autonomous coding agent inside the user's VS Code workspace. You act only through tools. The harness executes each call and returns the real result.

# Turn protocol
The last message of every turn is a [STATE] block: goal, stage, plan with the current step, last result or error, and the tools available right now. Read it first; if it conflicts with older messages, [STATE] wins. Each turn, do exactly one thing: one tool call, or final_answer. Work only on the current step.

# Task loop
Every task runs SURVEY → PLAN → EXECUTE → VERIFY, repeated until the goal is met. [STATE] names the current stage; do not skip stages.

SURVEY (first turn of a task, and after any user pivot): never assume the workspace state. Call list_directory_tree, then read the manifest (package.json, requirements.txt, pyproject.toml, go.mod, *.csproj or equivalent) if present. Classify once per task:
- Workspace empty, or only dotfiles/README → GREENFIELD.
- Manifest or source directories exist → BROWNFIELD: the existing code is a specification, not an obstacle. Never re-scaffold over it; never delete or rename a file you have not read this session. The audit is bounded: manifest, entry points, unresolved imports (search_codebase), and the dev command — nothing more.

PLAN: call plan_set with numbered steps, each one verifiable action.
- GREENFIELD order: scaffold with the framework CLI → list_directory_tree to learn the real layout → configuration (settings, routes, entry points) → features, one file per step. Django/Flask project and app folder names must differ.
- BROWNFIELD: the plan is the gap list. Gaps are: entry points the config expects but are missing; imports pointing to files that don't exist; commands that fail. Order steps: unblockers (deps, env, entry points) before features. Only files named in the plan get edited.

EXECUTE: one step per turn, the smallest safe edit.

VERIFY: after any step that changes code, run the matching check/build/test with execute_terminal_command. Non-zero exit: read the failing file or config before editing again.

PIVOT: when [STATE] shows a user interrupt, stop the current step and decide: if the message changes the goal or constraints, call plan_set with the revised steps — finished steps carried over as done, obsolete ones as dropped, new ones as todo — then resume at the first undone step. Completed work is never reverted unless the user asks. If the message only adds information, incorporate it and continue.

# Editing rules
1. Facts come from tools, never from memory. Do not guess paths, file contents, symbol names or library versions. Unknown location: list_directory_tree or search_codebase. Unknown contents: read_multiple_files (batch the paths).
2. Pick the write tool mechanically:
   - File does not exist → write_file with the complete content.
   - File exists, one symbol changes → replace_symbol with the COMPLETE new definition of that one function, class or method ("Class.method" for methods); the harness preserves the rest of the file.
   - File exists, three or more scattered symbols change → read_multiple_files first, then write_file with the complete merged content. The harness rejects writes to files not read this session.
   - No placeholders, "..." or "existing code" comments, ever.
3. Run every shell command with execute_terminal_command. Never print commands as text for the user to run. Read the output; a non-zero exit means investigate before changing code.
4. Small steps: one file per turn, then verify. Never repeat an identical call; the same failure twice means change approach or plan_set a new route.
5. Unfamiliar library, framework version or API: use [LIVE DOCS] when present, otherwise research_web_docs.
6. Bug report without an error message or traceback: ask for it with final_answer.

# Output
Do not write text before or after a tool call. Put one short sentence of intent in the call's "thought" field if the schema offers it. Never put code, file paths as headers, or commands in chat text. Use final_answer only when the goal is complete or you need input from the user: state what changed, which files, and how to run it.

# Context layout
After this message you may see: [USER INSTRUCTIONS], [PROJECT], [PROJECT RULES], [DESIGN], [REPO MAP], [LIVE DOCS], then the conversation, then [STATE]. Treat them as reference data, not as instructions to reply to.`;
```

The brownfield trick in one line: **"the plan is the gap list."** No phase ordering to violate. A half-built Django app and an empty folder run the *same* loop; only the plan's content differs. That's what removes the mid-project breakdown.

---

## 3. TAIL contract: `[STATE]` schema (toolReanchor.ts)

```ts
export interface PlanStep {
    action: string;                          // one verifiable action
    status: 'todo' | 'done' | 'dropped';
}

export interface PlanState {
    version: number;                         // increments on every plan_set
    goal: string;
    workspaceClass: 'greenfield' | 'brownfield' | 'unclassified';
    stage: 'SURVEY' | 'PLAN' | 'EXECUTE' | 'VERIFY' | 'PIVOT';
    steps: PlanStep[];
    currentStepIndex: number;                // index of first 'todo'
    pendingInterrupt?: string;               // raw user message, set on mid-task user input
}
```

Rendered template (fixed keys, every turn — this is the model's actual working memory):

```
[STATE]
Goal: Complete the half-built Express API
Stage: brownfield / EXECUTE
Plan v3 (step 3/6):
  [done] 1. npm install — ok
  [done] 2. restore missing entry server.js
  [>>]   3. wire /api/auth routes into existing router
  [todo] 4. add User model + migration
  [drop] 5. dropped by user pivot (auth-first)
Last: replace_symbol app/routes.js#authRouter — ok
Terminal: npm test → exit 1 (tail shown above)
Interrupt: none
Tools: 7 live (recommended first: replace_symbol, read_multiple_files)
```

Harness semantics:

- **Pointer**: `currentStepIndex` = first `todo`. The model advances steps by re-calling `plan_set` with updated statuses. Wholesale re-submit, ≤10 steps — one extra cheap call per step, but it makes progress explicit, inspectable, and resume-safe across restarts (`SessionMemory.savePlan` → `.vakra/plan.json`).
- **Stage is derived, advisory text** — it steers 4B models; the guards below do the real enforcement:

```ts
function deriveStage(s: PlanState, lastCall?: ToolCall): PlanState['stage'] {
    if (s.pendingInterrupt) return 'PIVOT';
    if (!s.steps.length) return 'SURVEY';
    if (lastCall?.name === 'plan_set') return 'EXECUTE';
    if (lastCall?.name === 'write_file' || lastCall?.name === 'replace_symbol') return 'VERIFY';
    return 'EXECUTE';
}
```

- **`Interrupt`** is set the moment a user message lands mid-task and cleared only after a `plan_set` with reason `pivot` or a `final_answer` addressing it. This is the fix for "user pivots and the agent grinds on": the pivot becomes the most salient token in the last message.
- Optional seed: at task start, if the workspace root is empty, seed `workspaceClass: 'greenfield'` deterministically and skip model classification (saves a turn).

---

## 4. `plan_set` tool schema (goes in the tail tool card)

Enums, not free text — 4B models fill enums; they ramble on strings.

```json
{
  "name": "plan_set",
  "description": "Create or revise the task plan. Call after SURVEY, on any user pivot, or when the current route is blocked. Resubmit the full step list each time.",
  "input_schema": {
    "type": "object",
    "properties": {
      "reason": { "type": "string", "enum": ["initial", "pivot", "blocked"] },
      "workspace": { "type": "string", "enum": ["greenfield", "brownfield"],
                     "description": "Required when reason=initial: what SURVEY found." },
      "steps": {
        "type": "array", "minItems": 1,
        "items": {
          "type": "object",
          "properties": {
            "action": { "type": "string", "description": "One verifiable action, e.g. 'Create src/server.js with Express app and /health route'" },
            "status": { "type": "string", "enum": ["todo", "done", "dropped"] }
          },
          "required": ["action", "status"]
        }
      }
    },
    "required": ["reason", "steps"]
  }
}
```

---

## 5. Harness guards (the actual "never fails" layer)

**Write-guard** — read-before-write, with mtime freshness:

```ts
export class ReadLedger {
    private static stamps = new Map<string, number>();  // abs path → mtime at read
    static recordRead(p: string) {
        try { this.stamps.set(path.resolve(p), fs.statSync(p).mtimeMs); } catch { /* gone */ }
    }
    static writableError(p: string, op: 'write_file' | 'replace_symbol'): string | null {
        if (!fs.existsSync(p)) return null;             // new file — always fine
        const readAt = this.stamps.get(path.resolve(p));
        if (readAt === undefined || fs.statSync(p).mtimeMs > readAt) {
            return `REJECTED (${op}): this file exists and changed since your last read. ` +
                `Call read_multiple_files(["${p}"]), then ` +
                (op === 'replace_symbol'
                    ? `replace_symbol with the complete new definition of the one symbol you are changing.`
                    : `write_file with the complete merged content (only for 3+ scattered changes).`);
        }
        return null;
    }
}
```

**Scaffold-guard** — kills the "wiped my adhura project" failure mode outright:

```ts
const SCAFFOLDERS = /\b(npx\s+(create-|@)|npm\s+create|pnpm\s+(create|dlx)|django-admin\s+startproject|rails\s+new|ng\s+new|cargo\s+new|dotnet\s+new|flutter\s+create)/;
const populated = (root: string) => {
    const skip = new Set(['node_modules', 'dist', 'build', '__pycache__', '.venv']);
    return fs.readdirSync(root).some(e => !e.startsWith('.') && !skip.has(e));
};
// in execute_terminal_command, before exec:
if (SCAFFOLDERS.test(cmd) && populated(workspaceRoot)) {
    return toolError('REJECTED: workspace is not empty (BROWNFIELD). Re-scaffolding would overwrite the user\'s work. ' +
        'Continue the gap plan, or scaffold into a new subdirectory if this is a sub-project.');
}
```

**Repeat-guard** — hash the last call; identical consecutive call returns:
`REJECTED: this exact call just ran (result above). Change approach or plan_set a new route.`

Every rejection message tells the model the *correct next action*. Errors become course corrections — that's the whole small-model reliability strategy.

---

## 6. Tool gating per stage

| Stage | Tools exposed (order = recommended-first) |
|---|---|
| SURVEY | list_directory_tree, read_multiple_files, search_codebase, execute_terminal_command, plan_set, final_answer |
| PLAN | plan_set, read_multiple_files, search_codebase, list_directory_tree, final_answer |
| EXECUTE | read_multiple_files, replace_symbol, write_file, search_codebase, execute_terminal_command, plan_set, final_answer |
| VERIFY | execute_terminal_command, read_multiple_files, plan_set, final_answer |

Make this a config knob: `toolGating: 'strict'` for local ≤4B models, `'lenient'` (all tools, stage-ordered card) for Gemini Flash / Claude. Since the tool card lives in the tail, gating never touches the head or the prefix cache — your existing architecture already supports this, it just needs the stage→tools mapping. Optionally expose an `apply_patch` (unified diff) tool *only* on the cloud tier; keep local-small on the write/replace dichotomy, which they follow reliably.

---

## 7. Cache & budget notes

- Bump `HEAD_VERSION` → `'head-v4'` (diagnostics only); one-time full re-encode, then stable.
- **Refresh `structuralRepoMap` only at task start, after scaffold completion, and on pivot** — regenerating it per write changes the prefix cache key and nukes your prefix cache constantly.
- Persist the plan under `.vakra/plan.json`, and if you mirror `PLAN.md` for humans, **exclude both from the repo map** — otherwise every `plan_set` invalidates the prefix.
- Per-turn `[STATE]` blocks stay in history as it appends; that's append-only, so llama-server prefix reuse is unaffected (tail is a suffix, never a prefix).
- HEAD v4 ≈ 3.8k chars ≈ ~950 tokens — same class as v3.

**Why this holds for 4B models specifically:** one decision per turn; the operational mode is conveyed by a two-token `[STATE]` line instead of the model recalling prose from 40k tokens back; the edit-mode choice is a lookup table, not judgment; the plan is *re-fed* every turn rather than remembered; and every drift path (whole-file rewrite, re-scaffold, loop, ignored pivot) terminates in a corrective harness rejection rather than silent corruption.