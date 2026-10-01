I'll build this as an updated `promptBuilder.ts`, since most of the design is code that has to live next to the prompt.I've rewritten `promptBuilder.ts` (head-v4). The main change is that the harness decides the mode and phase, and the model only reads them.

## Architecture

**1. The harness picks the mode, the model doesn't.**
"Is this project empty or half-built?" is the hardest judgment for a 4B model. `classifyWorkspace()` does a shallow, capped walk (depth 3, 400 entries) and counts source files and manifests.
- Zero of both means `NEW`. Anything else means `EXISTING`.
- `startTask()` stores the result once. If you recompute it every turn, a freshly scaffolded NEW project flips to EXISTING on turn 2.

**2. A small phase machine that the tail enforces.**
- `NEW` starts at `PLAN`.
- `EXISTING` starts at `AUDIT`, then goes `PLAN → EXECUTE ⇄ VERIFY → DONE`.
- A failed verify sends it back to `EXECUTE`.
- Your harness moves the phase. It already sees each tool call, so `plan_set` ends the audit and a passing verify advances the step.

**3. Tool gating per phase (`allowedTools`).**
This does more for small models than any prompt wording.
- In `AUDIT`, write tools don't exist, so the model can't wipe your half-built project.
- In `EXECUTE` it gets read, write and terminal tools.
- In `DONE` only `final_answer` is left.
- The choice among ~12 tools becomes a choice among 3–5.

**4. HEAD stays static, so the cache still hits.**
It only explains what NEW, EXISTING, AUDIT and the other phases mean. Everything that changes lives in `[STATE]` (from `buildStateBlock`): mode, a one-line phase instruction repeated every turn, the goal, the current step and the next one, the last result, and the tools available now. Small models follow recent text far better than the system prompt.

## The three rule sets you asked for

**Detecting project state.** The harness classifies it. For EXISTING the head then gives a fixed audit protocol:
1. `list_directory_tree`.
2. `read_multiple_files` on the manifest and entry points.
3. Run the build, test or import check.
4. Mark each finding OK, MISSING or BROKEN, and cite the tool output that shows it. "No output, no finding" stops the model from inventing problems.

For "mera adhura project hai, ise complete kar", the head defines the goal as the gap between what exists and what the project clearly intends (README, TODOs, imports or routes pointing at missing code).

**Dynamic planning.**
- The plan is 3–8 steps, one file or command each, each with a `verify` check.
- Only the current step and the next one go into `[STATE]`, so the tail stays small.
- The plan is changed only through `plan_update`, and steps are never deleted, only marked done or dropped with a reason.
- **Pivot:** `applyPivot()` sets `EVENT: user_pivot` for one turn. The model makes exactly one `plan_update` call (keep, amend or replace), then continues. No restart, no loop.
- **Stuck:** after the same failure twice, the harness sets `EVENT: stuck`. The model reads the source of the error or asks one specific question.

**Create vs modify (decision table in Rule 2).**

| File state | Change | Tool |
|---|---|---|
| Doesn't exist | anything | `write_file` |
| Exists | one function, class or method | `replace_symbol` |
| Exists | anything else (config, JSON, CSS, imports, a few lines) | `edit_file` (exact `old_text` from a read) |
| Exists | whole rewrite | never |

The rule is that the file's state, not the model's mood, picks the tool. Your harness should reject `write_file` on an existing path and say "use replace_symbol or edit_file". That correction message teaches small models better than more rules in the prompt.

## What you need to wire up

- **`edit_file` and `plan_update` must exist as tools.** If you don't have `edit_file`, delete that bullet and Rule 2 falls back to symbol-only edits. `plan_update` needs ops like `done`, `add`, `drop(reason)` and `replace`. Adjust the names in `allowedTools`.
- **`toolReanchor.ts` should call `buildStateBlock(task, filteredToolCard, buildVolatile(root))`.** Filter the registry card with `allowedTools(task)` first.
- **Freeze `structuralRepoMap` at task start.** If it is regenerated as files appear, it changes the prefix and forces a full re-prefill on every step. For NEW projects, skip it and let `list_directory_tree` show the layout.
- **Head size.** It is now about 1,150 tokens (check with `headTokenEstimate()`), up from about 900. That is a one-time cost, since it stays cached.

I haven't run this against your repo or tested it with Qwen or Gemma. Run a few brownfield tasks first: a half-built Django project, a Vite app with a broken import, and a mid-task pivot. Watch whether the model reaches `plan_set` after two or three audit calls. If a 3B model dawdles in `AUDIT`, have the harness force the phase change after `auditCalls >= 4`.