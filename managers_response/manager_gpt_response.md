Bro, attached `promptBuilder.ts` ko dekhne ke baad architecture ka core issue kaafi clear hai. Tumhara **Head → stable Prefix → volatile Tail** design fundamentally sahi direction mein hai: llama.cpp prompt caching common prefix ko reuse karta hai, isliye stable material ko early positions mein rakhna useful hai.  ([GitHub][1])

Lekin current prompt mein **project lifecycle ko linear assume kiya gaya hai**, jabki tumhare actual agent ko **state-driven adaptive execution** chahiye. Current rules specifically “new project” ke liye scaffold-first pipeline enforce karte hain, aur “one file per turn” bhi globally impose karte hain.  Tumhare brownfield/partial-project case mein yahi rigidity problem create karegi. Requirement itself bhi explicitly empty, partial aur user-pivot scenarios ko cover karti hai. 

## 1. Recommended architecture: Head ko policy rakho, State ko Tail ka brain banao

Main architecture ko 4 layers mein rakhunga:

```text
┌────────────────────────────────────────────┐
│ HEAD — immutable operational contract     │
│ ~800–1200 tokens                           │
│                                            │
│ identity + authority + invariants          │
│ tool discipline + edit safety              │
│ state-machine semantics                    │
└────────────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────┐
│ SESSION PREFIX — stable task context       │
│                                            │
│ user instructions                          │
│ project identity/profile                   │
│ conventions / rules                        │
│ stable repo map                            │
│ task identity                              │
└────────────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────┐
│ CONVERSATION / HISTORY                     │
└────────────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────┐
│ DYNAMIC TAIL — actual controller state     │
│                                            │
│ workspace_state                            │
│ execution_mode                             │
│ goal                                       │
│ plan_id / plan_version                     │
│ current_step                               │
│ known facts                                │
│ latest tool result                         │
│ dirty files                                │
│ user pivot signal                          │
│ allowed next action                        │
└────────────────────────────────────────────┘
```

Tumhare existing builder mein volatile terminal output aur SessionMemory already Tail side par ja rahe hain, jo correct separation hai. 

**Important change:** `PLAN.md` ka actual full text Prefix mein mat daalna. Plan ka **small state representation** Tail mein do. `PLAN.md` disk par source-of-truth artifact rahega, lekin prompt mein sirf current plan metadata + current step + relevant steps inject hon.

Isse plan change hone par stable prefix unnecessarily invalidate nahi hoga. llama.cpp common-prefix caching specifically differing suffix ko hi re-process kar sakta hai. ([GitHub][1])

---

# 2. Sabse important concept: Phase machine nahi, State machine

Tumhe ye:

```text
Phase 1 → Phase 2 → Phase 3 → Phase 4
```

nahi rakhna.

Instead:

```text
             ┌───────────────┐
             │    OBSERVE    │
             └──────┬────────┘
                    │
          ┌─────────▼─────────┐
          │ CLASSIFY WORKSPACE │
          └───────┬─────┬─────┘
                  │     │
             EMPTY│     │EXISTING
                  │     │
                  ▼     ▼
              GREEN     AUDIT
                  │       │
                  └───┬───┘
                      ▼
                    PLAN
                      │
                      ▼
                   EXECUTE
                      │
                      ▼
                    VERIFY
                      │
          ┌───────────┼───────────┐
          │           │           │
         PASS        FAIL       PIVOT
          │           │           │
          ▼           ▼           ▼
         DONE      DIAGNOSE      REPLAN
                      │           │
                      └─────┬─────┘
                            ▼
                         EXECUTE
```

So **“greenfield” aur “brownfield” workflow mode hain, permanent phases nahi.**

---

# 3. Exact state model

Tail mein main compact machine-readable-ish state rakhta:

```text
[STATE]

goal_id: <stable id>
goal: <current user goal>

workspace_state:
  EMPTY | GREENFIELD_STARTED | BROWNFIELD_PARTIAL | BROWNFIELD_HEALTHY | UNKNOWN

execution_mode:
  DISCOVER | AUDIT | PLAN | EXECUTE | VERIFY | REPLAN | BLOCKED | DONE

plan:
  id: <plan-id>
  version: <integer>
  status: ACTIVE | INVALIDATED | COMPLETE
  current_step: <step-id>
  current_step_goal: <one sentence>

facts:
  workspace_inspected: true|false
  relevant_files_read: true|false
  last_verification: PASS|FAIL|NOT_RUN

changes:
  dirty_files: [...]
  last_changed_file: <path>

last_result:
  status: SUCCESS | FAILURE | BLOCKED
  summary: <short factual result>

user_pivot:
  detected: true|false
  reason: <short>

next_action:
  <EXACTLY ONE ALLOWED TOOL ACTION>
```

Ye **Tail ka anchor** hoga.

Current prompt already says `[STATE]` last message hota hai aur state conflicts mein wins.  Ye concept preserve karo; bas `[STATE]` ko much more authoritative aur structured banana hai.

---

# 4. Workspace detection — model ko guess nahi karna

Current rule:

> unknown location → list/search

achha hai. 

Lekin ab workspace classifier explicitly define karo.

### Rule

```text
WORKSPACE DETECTION

1. Never infer EMPTY from absence of a known framework file.
2. Inspect workspace with list_directory_tree.
3. If meaningful project/source/config files exist:
      classify as EXISTING.
4. If workspace contains no meaningful project artifacts:
      classify as EMPTY.
5. If evidence is insufficient:
      classify as UNKNOWN and inspect further.
6. Never scaffold while state is UNKNOWN.
7. Never delete, replace, or reinitialize existing project structure
   merely because it is incomplete.
```

### Meaningful project artifacts

Examples:

```text
src/
app/
server/
backend/
frontend/
package.json
pyproject.toml
requirements.txt
Cargo.toml
pom.xml
build.gradle
tsconfig.json
vite.config.*
next.config.*
manage.py
Dockerfile
```

But **presence of README alone does not prove a working project**.

So:

```text
README only
→ EXISTING_ARTIFACTS / insufficient evidence
→ inspect further
```

Do not let the LLM do:

> “Folder mein kuch files hain, therefore React project.”

It must have tool evidence.

---

# 5. Brownfield project ka mandatory first sequence

User:

> “mera adhura project complete kar”

Agent ko directly code nahi likhna chahiye.

Correct sequence:

```text
1. list_directory_tree
2. identify project markers
3. inspect entry/config files
4. search obvious TODO/FIXME/errors/import references
5. inspect build/test/run configuration
6. form evidence-backed diagnosis
7. create/update plan
8. execute one atomic step
9. verify
10. repeat
```

### Critical distinction

**Audit ≠ Plan**

Audit asks:

```text
What exists?
What works?
What is broken?
What is missing?
What is uncertain?
```

Plan asks:

```text
Given those facts, what should we change?
```

4B model ke liye ye separation bahut important hai.

---

# 6. Existing project mein “working” ka matlab kya?

Agent ko `file exists` ko `feature works` nahi samajhna chahiye.

Use 3 evidence levels:

```text
KNOWN_PRESENT
  file/function/import exists

KNOWN_WORKING
  tool execution / build / test / runtime check succeeded

UNKNOWN
  no verification evidence
```

Example:

```text
auth.ts exists
      ↓
KNOWN_PRESENT

npm test → PASS
      ↓
auth flow potentially KNOWN_WORKING

No test/runtime evidence
      ↓
UNKNOWN
```

Ye small models ko false confidence se bachayega.

---

# 7. PLAN.md ko “instruction” nahi, “execution ledger” banao

Ye bahut important architectural distinction hai.

`PLAN.md`:

```text
Goal
Current diagnosis
Steps
Completed evidence
Current step
Known blockers
Replan history
```

Lekin model ko ye rule do:

```text
PLAN IS INTENT, NOT FACT.

Never treat PLAN.md as proof that:
- a file exists
- a feature works
- a previous step succeeded
- an API is correct
- a dependency is installed

Reality comes from tools.
PLAN.md records intended work and verified progress.
```

Isse stale plan problem solve hoti hai.

---

# 8. `plan_set` ka correct role

`plan_set` ko simply “make a plan” tool mat samjho.

Uska semantic contract:

```text
plan_set
    ↓
create OR replace active plan version
    ↓
persist plan
    ↓
set current_step
    ↓
bind goal_id
    ↓
invalidate incompatible execution state
```

Plan structure roughly:

```text
PLAN v7

GOAL:
Complete existing ecommerce app.

WORKSPACE:
BROWNFIELD_PARTIAL

DIAGNOSIS:
- frontend exists
- API exists
- cart endpoint broken
- checkout flow incomplete

STEPS:
S1 Verify API failure
S2 Repair cart endpoint
S3 Verify cart
S4 Complete checkout integration
S5 End-to-end verification

CURRENT:
S1

STATUS:
ACTIVE
```

---

# 9. User pivot ka exact behavior

Suppose agent ka current goal:

> “Fix login page”

Aur user says:

> “Login chhod, pehle dashboard complete kar.”

Agent ko current step continue **nahi** karna chahiye.

Prompt rule:

```text
USER PIVOT RULE

At the beginning of every turn compare the latest user request
against the active goal.

If the requested outcome materially changes:
    1. mark active plan INVALIDATED
    2. do not continue current implementation step
    3. do not undo existing completed work
    4. preserve verified facts
    5. derive new goal
    6. create/update plan with new version
    7. resume execution from the first necessary step

A pivot changes the PLAN, not the repository history.
```

Example:

```text
Plan v3
S1 auth
S2 dashboard
S3 reports

currently S1

user:
"dashboard pehle kar"

→ Plan v4
S1 inspect dashboard
S2 implement dashboard
...
```

**Completed useful work is preserved.**

---

# 10. Replanning kab allowed hai?

Bahut important for small models.

Don't let it replan every turn.

Use explicit triggers:

```text
REPLAN ONLY IF:

A. User goal changed
B. Current plan step became invalid
C. Tool result contradicts plan assumptions
D. Build/test exposes an unanticipated dependency
E. Required file/module does not exist
F. Same failure happened with a genuinely different diagnostic attempt
G. User explicitly requests a different approach
```

Otherwise:

```text
continue current step
```

Tumhari existing “same identical call repeat mat karo” rule useful hai, but replan trigger uske saath explicit hona chahiye. 

---

# 11. File creation vs modification — 4B-safe rules

Current architecture already has:

> existing code → `replace_symbol`

and:

> new file → `write_file`



Main isko aur strict banaunga.

## Rule A — New file

```text
NEW FILE

Use write_file only when:
- tool inspection proves the path does not exist

write_file must contain:
- complete file content
- no placeholders
- no omitted sections
- no "rest of code unchanged"
```

## Rule B — Existing file

```text
EXISTING FILE

Never use write_file for the whole file.

First:
    read file

Then:
    modify only required symbol(s)

Use:
    replace_symbol
```

## Rule C — Unknown existence

```text
UNKNOWN PATH

Do not write.
Inspect first.
```

This three-state model:

```text
ABSENT → write_file
PRESENT → replace_symbol
UNKNOWN → inspect
```

is much easier for a 4B model than a long prose explanation.

---

# 12. Add “mutation boundary”

Tumhara current:

> one file per turn

safe hai, but architecturally thoda too rigid hai. 

Instead:

> **one atomic mutation unit per turn**

Because sometimes one logical change belongs to:

```text
Class.method
```

or

```text
one complete new file
```

or potentially a purpose-built atomic patch.

Use:

```text
ONE TURN = ONE PRIMARY ACTION

Allowed:
- inspect
- search
- read
- plan
- write ONE new file
- modify ONE existing symbol
- run ONE verification command
- finish

Never mix:
  inspect + edit + test
in one model action.
```

This keeps your small-model discipline while avoiding artificial “one file” constraints.

---

# 13. Tool selection ko model ke liye decision tree bana do

Long tool descriptions ke bajay Head mein tiny decision table:

```text
TOOL SELECTION

Need to know WHERE?
→ list_directory_tree / search_codebase

Need to know WHAT IS INSIDE?
→ read_multiple_files

Need to change EXISTING code?
→ replace_symbol

Need to create ABSENT file?
→ write_file

Need to verify behavior?
→ execute_terminal_command

Need to understand unfamiliar API?
→ LIVE DOCS / research_web_docs

Need to change PLAN?
→ plan_set

Never choose a mutation tool before required facts are known.
```

Ye 4B model ke liye substantially easier operational language hai.

---

# 14. “Current step” ko executable banao

Bad:

```text
Current step:
Implement backend
```

Good:

```text
Current step:
Read src/api/cart.ts and identify why POST /cart fails.
```

Even better:

```text
current_step:
S1

objective:
Determine failure cause of POST /cart.

allowed_action:
read_multiple_files

done_when:
Failure cause is supported by source evidence.

forbidden:
write code
run unrelated commands
advance to S2
```

Ye **state machine + affordance restriction** hai.

Small LLM ko “what can I do next?” ka answer directly milta hai.

---

# 15. Every state should expose one `allowed_action`

Ye mere hisaab se tumhare system ka most important improvement hoga.

Instead of model seeing 20 tools and deciding vaguely:

```text
next_action: inspect
allowed_tools:
    list_directory_tree
    search_codebase
    read_multiple_files
```

Then once evidence exists:

```text
next_action: modify
allowed_tools:
    replace_symbol
```

Then:

```text
next_action: verify
allowed_tools:
    execute_terminal_command
```

So model ko **tool zoo** nahi dikhega as an unconstrained choice.

---

# 16. Recommended Head prompt

Tumhare current Head ko completely rewrite karne ke bajay, architectural core roughly aisa hona chahiye:

```text
You are Vakra, an autonomous coding agent operating inside the user's VS Code workspace.

# Authority

Tools provide repository truth.
[STATE] provides the current execution state.
The latest user request defines the current goal.

Priority:
1. Latest user request
2. [STATE]
3. Tool results
4. Active PLAN
5. Conversation history
6. Model assumptions

Never invent repository facts.

# Execution Model

Vakra is state-driven, not phase-driven.

Possible execution states:
DISCOVER
AUDIT
PLAN
EXECUTE
VERIFY
REPLAN
BLOCKED
DONE

The active state determines the next legal action.

# Workspace Classification

Before modifying a project, establish whether the workspace is:

EMPTY
GREENFIELD_STARTED
BROWNFIELD_PARTIAL
BROWNFIELD_HEALTHY
UNKNOWN

Never assume EMPTY from lack of a familiar framework file.

If UNKNOWN, inspect further.

Never scaffold or reinitialize a non-empty workspace merely because
it appears incomplete.

# Greenfield

For an EMPTY workspace:

1. inspect workspace
2. identify or obtain framework choice
3. scaffold with the framework CLI when appropriate
4. inspect generated layout
5. create/update plan
6. implement iteratively
7. verify after each atomic mutation

# Brownfield

For an EXISTING workspace:

1. inspect layout
2. inspect project configuration and entry points
3. inspect relevant source
4. identify broken, missing, and uncertain areas
5. create/update a targeted plan
6. modify only required parts
7. verify
8. replan only when evidence requires it

Never replace an existing project with a fresh scaffold.

# Truth Model

File existence is not proof of functionality.

Classify evidence as:
KNOWN_PRESENT
KNOWN_WORKING
UNKNOWN

Plans contain intent.
Tools provide reality.

# Plan Rules

PLAN.md is an execution ledger, not a source of truth.

plan_set creates or updates the active plan.

Every plan has:
goal_id
plan_id
plan_version
current_step
status

When the user's goal materially changes:
1. invalidate the current plan
2. preserve verified work
3. create a new plan version
4. resume from the new plan's first necessary step

Do not replan on every turn.

Replan only when:
- user goal changes
- current assumptions are disproven
- a step becomes invalid
- verification reveals unexpected dependency
- repeated failure requires a changed strategy

# File Safety

ABSENT file
→ write_file with complete content

PRESENT file
→ read first, then replace_symbol

UNKNOWN path
→ inspect first

Never rewrite an existing file wholesale.

Never use placeholders such as:
"rest of code unchanged"
"existing code here"
or omitted sections.

# Mutation Discipline

One turn performs one primary action.

A primary action is one of:
inspect
search
read
plan
write one new file
modify one existing symbol
verify
finish

Do not combine unrelated inspect/edit/test actions.

# Verification

After a mutation, verify with the smallest relevant check.

If verification fails:
1. inspect the actual failure
2. identify evidence
3. change strategy if necessary
4. never blindly repeat the same call

# State

The final message of every turn is [STATE].

Read [STATE] first.

[STATE] is authoritative for:
goal
workspace state
execution state
plan version
current step
latest result
allowed next action

Perform only the allowed next action.

If the current state does not provide enough information,
inspect using tools rather than guessing.
```

Ye Head intentionally generic hai. **Actual file paths, terminal output, PLAN text, repo snapshots etc. isme nahi hone chahiye.**

---

# 17. Prefix mein kya rahega?

Tumhare current implementation ka broad ordering preserve karo:

```text
HEAD
  ↓
USER INSTRUCTIONS
  ↓
PROJECT IDENTITY
  ↓
FRAMEWORK CONVENTIONS
  ↓
PROJECT RULES
  ↓
STABLE REPO MAP
```

Current builder already roughly isi least-volatile → most-volatile order ko target karta hai. 

But I would add:

```text
TASK IDENTITY
```

not:

```text
FULL TASK PLAN
```

For example:

```text
[TASK]
goal_id: 91ab
task_category: backend
```

while dynamic:

```text
[STATE]
goal: Fix checkout flow
plan_version: 4
current_step: S3
...
```

---

# 18. Tail mein kya rahega?

Tail should essentially be:

```text
[TURN STATE]
...
 
[RECENT TOOL RESULT]
...
 
[RELEVANT VOLATILE CONTEXT]
terminal...
session...
 
[LIVE TOOL CARD]
...
```

Current architecture already says live tool signatures should live in Tail so tool sets can change without changing Head. 

That is a good design choice; keep it.

---

# 19. Memory ko plan se mix mat karna

Ye bhi important hai for the larger system.

You have three different concepts:

```text
MEMORY
"What happened earlier?"

PLAN
"What are we intending to do?"

STATE
"What must happen NOW?"
```

They should never become one blob.

Example:

```text
SESSION MEMORY
User prefers FastAPI.
Earlier auth bug was fixed.
```

```text
PLAN
S1 inspect checkout
S2 modify payment service
S3 verify
```

```text
STATE
mode=EXECUTE
current_step=S2
allowed_action=replace_symbol
```

**STATE controls the turn.**

This separation will make your future token-management layer much easier too.

---

# 20. Token budget architecture for 40k–60k context

For your target small models, I would not treat the entire 40k–60k as “available prompt”.

Think of it as:

```text
TOTAL CONTEXT
│
├── immutable Head
├── stable prefix
├── compact history
├── active state
├── relevant code
├── recent tool outputs
└── generation budget
```

And impose a **context allocator**, not just a hard max.

Example conceptual budget:

```text
HEAD                  1k
PREFIX                3–5k
STATE + plan          1–2k
RECENT HISTORY        3–6k
RELEVANT CODE         10–20k
TOOL RESULTS          3–6k
SAFETY RESERVE        4–8k
GENERATION            remaining
```

Exact percentages should be measured against your actual tokenizer/model rather than hard-coded from generic token estimates.

Your current `headTokenEstimate()` uses a rough ~4 chars/token approximation; that is fine for diagnostics but should not become the actual context allocator. 

---

# 21. One more architectural change I strongly recommend

Current prompt says:

> “Each turn, do exactly one thing: make one tool call, or finish…”

Keep this invariant. 

But change the semantic meaning from:

```text
one turn = one file
```

to:

```text
one turn = one state transition
```

For example:

```text
DISCOVER
  → AUDIT

AUDIT
  → PLAN

PLAN
  → EXECUTE

EXECUTE
  → VERIFY

VERIFY(PASS)
  → EXECUTE next step

VERIFY(FAIL)
  → DIAGNOSE / REPLAN

USER PIVOT
  → REPLAN
```

That is much more powerful than a linear “phase” architecture while still being deterministic for small LLMs.

---

# 22. Final architecture in one picture

```text
                    USER REQUEST
                         │
                         ▼
                ┌─────────────────┐
                │ GOAL/PIVOT CHECK│
                └────────┬────────┘
                         │
                  pivot? ├── yes ──► invalidate plan
                         │
                         no
                         ▼
                ┌─────────────────┐
                │ [STATE] MACHINE │
                └────────┬────────┘
                         │
             ┌───────────▼───────────┐
             │ Workspace classification│
             └───────┬─────────┬─────┘
                     │         │
                  EMPTY      EXISTING
                     │         │
                     ▼         ▼
                 GREENFIELD   AUDIT
                     │         │
                     └────┬────┘
                          ▼
                         PLAN
                          │
                          ▼
                       EXECUTE
                          │
                          ▼
                        VERIFY
                          │
               ┌──────────┼──────────┐
               │          │          │
             PASS        FAIL       PIVOT
               │          │          │
               ▼          ▼          ▼
           next step   diagnose    replan
               │          │          │
               └──────┬───┴──────────┘
                      ▼
                   EXECUTE
```

## Bottom line

Tumhare current `PromptBuilder` ko **throw away** karne ki zarurat nahi hai. Foundation correct hai: immutable Head, cached Prefix, volatile Tail, live tools outside Head. 

The redesign should be:

**`Static Rules + Stable Task Context + Explicit State Machine + Evidence-Based Audit + Versioned Plan + One Atomic Action`**

rather than:

**`Static Rules + Fixed Project Phases + Current Context`**.

Aur sabse important: **`PLAN.md` agent ka brain nahi hai; `[STATE]` current-turn brain hai, aur tools reality hain.** Ye distinction rakha toh greenfield, half-built projects aur mid-project user pivots ek hi architecture ke andar naturally handle ho sakte hain.

llama.cpp ki current server documentation bhi prompt-cache reuse ko common-prefix based batati hai, so tumhara cache-aware prompt layering architectural sense banata hai. ([GitHub][1])

[llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/tree/master/tools/server?utm_source=chatgpt.com)

[1]: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md?plain=1&utm_source=chatgpt.com "llama.cpp/tools/server/README.md at master · ggml-org/llama.cpp · GitHub"
