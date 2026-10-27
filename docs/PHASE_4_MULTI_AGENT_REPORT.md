# VAKRA_CONTROL — Phase 4: Multi-Agent Orchestration Implementation & Runtime Validation Report

**Status:** Complete, Verified & Audited  
**Date:** October 2026  
**System:** `vakra_control` VS Code Extension  
**Architecture:** Deterministic Harness Multi-Agent System (Phase 4)

---

## 1. Executive Summary

Phase 4 transitions `vakra_control` from a single-agent autonomous tool loop to a **Deterministic Multi-Agent Harness Architecture**. The orchestration layer implements four logical specialist roles—**Planner**, **Researcher**, **Coder**, and **Verifier**—operating behind a deterministic TypeScript orchestrator (`AgentOrchestrator`).

Key milestones achieved:
- **Zero Framework Bloat:** Implemented in pure TypeScript without adding LangChain, AutoGen, CrewAI, or external multi-agent frameworks.
- **Single Execution Authority:** All tool execution, path containment, secret filtering, user approvals, and disk mutations flow strictly through the authoritative `ToolDispatcher.dispatch`.
- **Dual-Layer Role Permissions:** Strict tool filtering is enforced both at the model schema boundary (stripping disallowed tools from JSON schemas) and at the dispatch boundary (dual-layer check blocking any prohibited tool calls).
- **Empirical Verification:** The Verifier role evaluates real process exit codes and diagnostics. Missing evidence is treated as unverified, never passed. Models cannot self-authorize task completion.
- **Bounded Self-Correction Loop:** Step recovery is strictly bounded to a maximum of 2 attempts per sub-step, with automated error diagnostic injection and loop detection preventing repeated identical executions.
- **Fast-Path Optimization:** Conversational greetings and informational questions bypass multi-agent decomposition, routing directly to the provider for single-turn responses.
- **100% Test Suite Health:** All 91 tests pass (76 baseline + 15 Phase 4 multi-agent contract and workflow tests), with 0 failing and 0 skipped.

---

## 2. Implemented Architecture & Runtime Call Path

### 2.1 The Four Specialist Roles

| Role | Responsibility | Allowed Tools | Prohibited Actions |
|---|---|---|---|
| **Planner** | Formulates and refines high-level roadmaps & micro sub-steps with concrete verification criteria. | `set_task_plan`, `expand_plan_step`, `read_state_ledger`, `list_directory_tree`, `read_multiple_files` | Writing/editing code, running terminal commands, completing steps, calling finish. |
| **Researcher** | Gathers targeted source-code context, symbol outlines, and documentation. Read-only. | `read_multiple_files`, `search_codebase`, `list_directory_tree`, `get_symbol_outline`, `get_code_diagnostics`, `search_web` | Modifying files, creating files, executing terminal commands, approving plans. |
| **Coder** | Performs surgical file creation and AST/context-anchored edits based on research findings. | `write_file`, `edit_file` | Terminal command execution, planning tools, completing steps, calling finish. |
| **Verifier** | Independently executes non-blocking verification commands and inspects compiler/LSP diagnostics. | `execute_terminal_command`, `get_code_diagnostics`, `complete_plan_step`, `finish` | Writing files, modifying code, expanding plans, guessing fixes without testing. |

### 2.2 Actual Runtime Call Path

```
[User Request from Webview]
         │
         ▼
[SidebarProvider.handleChatMessageStream]  (src/webview/sidebarProvider.ts:507)
         │ (Initializes AgentOrchestrator with workspaceRoot, TaskPlanner, ToolDispatcher callback, AbortSignal)
         ▼
[AgentOrchestrator.execute()]  (src/agents/agentOrchestrator.ts:85)
         │
    ┌────┴─────────────────────────────┐
    │                                  │
[Fast-Path Check]                 [Task Workflow]
PromptClassifier.classifyPrompt()      │
    │ (Greeting: 'chat' / Info: 'info')├─► 1. PLANNER TURN (src/agents/roles/plannerRole.ts)
    ▼                                  │   ├─ Model completeWithHistory(filtered tools)
Single-turn completeWithHistory        │   ├─ Planner calls 'set_task_plan'
    │                                  │   └─ Synchronize with InMemoryTaskPlanner & StateLedger
    ▼                                  │
Stream response to Webview & Exit      ├─► 2. STEP LOOP (Iterates through each SubStep)
                                       │   │
                                       │   ├─► A. RESEARCHER TURN (src/agents/roles/researcherRole.ts)
                                       │   │   ├─ Gathers file snippets & symbols
                                       │   │   └─ Passes bounded ResearchFindings to Coder
                                       │   │
                                       │   └─► B. CODER & VERIFIER CORRECTION LOOP (Attempts 1..2)
                                       │       │
                                       │       ├─► CODER TURN (src/agents/roles/coderRole.ts)
                                       │       │   ├─ Injects target file lines & previous failure
                                       │       │   ├─ Dispatches surgical edit_file or write_file
                                       │       │   └─ Captures CoderResult
                                       │       │
                                       │       ├─► VERIFIER TURN (src/agents/roles/verifierRole.ts)
                                       │       │   ├─ Runs execute_terminal_command or get_code_diagnostics
                                       │       │   ├─ Extracts process exitCode and output snippets
                                       │       │   └─ Computes VerificationResult (passed / failed)
                                       │       │
                                       │       └─► ORCHESTRATOR VERDICT EVALUATION (src/agents/agentOrchestrator.ts:278)
                                       │           ├─ If Passed: Mark sub-step done, commit progress, advance
                                       │           ├─ If Failed & attempts < 2: Re-enter Coder with failure evidence
                                       │           └─ If Failed & attempts >= 2: Halt execution with 'failed' status
                                       │
                                       ▼
                       3. ALL STEPS VERIFIED & COMPLETE
                           └─ Commit StateLedger & Stream completion to Webview
```

---

## 3. Role Permission Matrix & Dual-Layer Enforcement

Permissions are enforced at two independent boundaries:

1. **Schema Layer (`filterToolsForRole` in `src/agents/permissions.ts`):**  
   Before calling `client.completeWithHistory`, the provider tool schema is filtered. The model never sees tool declarations for capabilities outside its assigned role.
2. **Dispatch Layer (`internalDispatch` in `src/webview/tools/toolDispatcher.ts:90-96`):**  
   When any tool invocation reaches `ToolDispatcher.dispatch`, `ctx.activeRole` is inspected against `validateRoleToolCall(activeRole, name, args)`. Even if a model hallucinates a prohibited tool call, the dispatcher intercepts and blocks it with a structured error (`Permission denied: Tool '...' is not permitted for role '...'`).

### Tool Permission Table

| Tool Name | Planner | Researcher | Coder | Verifier |
|---|:---:|:---:|:---:|:---:|
| `set_task_plan` | ✅ | ❌ | ❌ | ❌ |
| `expand_plan_step` | ✅ | ❌ | ❌ | ❌ |
| `read_state_ledger` | ✅ | ❌ | ❌ | ❌ |
| `read_multiple_files` | ✅ | ✅ | ❌ | ❌ |
| `list_directory_tree` | ✅ | ✅ | ❌ | ❌ |
| `search_codebase` | ❌ | ✅ | ❌ | ❌ |
| `get_symbol_outline` | ❌ | ✅ | ❌ | ❌ |
| `get_code_diagnostics` | ❌ | ✅ | ❌ | ✅ |
| `search_web` | ❌ | ✅ | ❌ | ❌ |
| `write_file` | ❌ | ❌ | ✅ | ❌ |
| `edit_file` | ❌ | ❌ | ✅ | ❌ |
| `execute_terminal_command`| ❌ | ❌ | ❌ | ✅ |
| `complete_plan_step` | ❌ | ❌ | ❌ | ✅ |
| `finish` | ❌ | ❌ | ❌ | ✅ |

---

## 4. State Transitions, Budget & Recovery Behavior

### 4.1 Finite State Machine

The orchestrator enforces the following valid lifecycle states (`TaskStatePhase`):
- `idle` ➔ `planning` ➔ `awaiting_plan_approval` ➔ `researching` ➔ `coding` ➔ `verifying` ➔ `completed`
- In failure scenarios: `verifying` ➔ `recovering` (attempts = 2) ➔ `coding` ➔ `verifying`
- On retry exhaustion: `verifying` ➔ `failed`
- On cancellation: Any state ➔ `aborted`

### 4.2 Loop Prevention & Repeated Call Interception

The `LoopDetector` (`src/guards/loopDetector.ts`) tracks SHA-1 argument hashes and execution outcomes (`resultOk`).
- If an agent attempts to execute the same tool with identical arguments consecutively, the call is blocked with `[LOOP PREVENTED]`.
- When a terminal verification command fails (e.g. exit code 1), `resultOk` is correctly recorded as `false`. This ensures the Verifier role can legally re-run the same test command in subsequent correction attempts once code changes have been applied.

### 4.3 Abort & Cancellation Propagation

The `AbortSignal` is propagated from `SidebarProvider` through `AgentOrchestrator` into:
- Provider streaming calls (`client.completeWithHistory`).
- Interactive user approval resolvers (`pendingEditResolvers` and `pendingTerminalResolvers`).
- Child process executions (`TerminalCapture.runAndCapture`).

When aborted, execution halts immediately without leaving dangling processes or pending promises.

---

## 5. Phase 4 Runtime Validation & Regression Audit

An independent runtime audit was executed across the codebase to trace actual execution paths and verify that the multi-agent system functions reliably under real runtime conditions.

### 5.1 Baseline Verification Results

- **Compiler check (`npm run compile`):** Clean exit code 0; tailwind CSS minified (408ms) and esbuild bundled `dist/extension.js` cleanly.
- **Type-check (`tsc -p .`):** Clean exit code 0; 0 TypeScript errors across all `src/` and test files.
- **Pretest suite (`npm run pretest`):** Clean exit code 0.
- **Mocha standalone test runner:** **91 passing (6s)**, 0 failing, 0 skipped.

### 5.2 Controlled Smoke Test Scenarios (All 7 Verified)

| # | Scenario | Mechanism Tested | Test File & Function | Verification Result |
|---|---|---|---|---|
| **1a** | **Simple Question (Greeting)** | Routes directly without declaring tools or invoking planning/coding roles. | `multiAgentWorkflow.test.ts` (`Fast-path greeting routes directly...`) | **PASS** — 0 tools declared or invoked; returns greeting text. |
| **1b** | **Simple Question (Info/Explain)** | Routes directly to Researcher; Planner, Coder, and Verifier are never invoked. | `multiAgentWorkflow.test.ts` (`Simple info question routes to Researcher only...`) | **PASS** — Researcher invoked; Planner & Coder strictly uninvoked; status: `'completed'`. |
| **2** | **Small Safe File Edit** | Direct single-step change applied via Coder and empirically verified via node test. | `multiAgentWorkflow.test.ts` (`Small, safe direct file edit modifies file...`) | **PASS** — Config port updated to 8080 on disk; node assertion exits 0; verified clean. |
| **3** | **Multi-Step Coding Task** | Multi-turn Plan ➔ Research ➔ Edit ➔ Test ➔ Pass pipeline with StateLedger persistence. | `multiAgentWorkflow.test.ts` (`Complete Workflow: Plan -> Research...`) | **PASS** — Initial bug detected by verifier, corrected in attempt 2, verified, and completed. |
| **4** | **Deliberate Verification Failure** | Unresolvable test assertion continuously failing with exitCode 1. | `multiAgentWorkflow.test.ts` (`Retry exhaustion halts safely at max attempts...`) | **PASS** — Retries capped at exactly 2; orchestrator halts with status: `'failed'`; model cannot claim success. |
| **5a** | **Cancellation During Execution** | AbortSignal triggered during active model generation. | `multiAgentWorkflow.test.ts` (`AbortSignal terminates orchestrator promptly`) | **PASS** — Orchestrator halts immediately with status: `'aborted'`. |
| **5b** | **Cancellation During Pending Approval** | AbortSignal triggered while an edit approval card is pending in the UI. | `multiAgentWorkflow.test.ts` (`Cancellation during pending approval aborts...`) | **PASS** — Pending resolver aborted cleanly; disk file remains completely untouched. |
| **6** | **Forbidden Tool Call** | Active role 'coder' attempts to call `execute_terminal_command`. | `multiAgentWorkflow.test.ts` (`Forbidden tool call is intercepted and denied...`) | **PASS** — Blocked at dispatch layer with structured `Permission denied` error. |
| **7** | **Approval-Required Action** | `isEditSessionAutoApproved: false`; Coder requests `edit_file`. | `multiAgentWorkflow.test.ts` (`Approval-required action generates approval card...`) | **PASS** — `toolCallEvent` emitted with `isAutoApproved: false`; user rejection leaves file unmodified. |

### 5.3 Automated vs. Mocked Environment Clarification

In adherence to verification integrity standards:
- **Real Executed Components:**
  - Real filesystem modifications, file versioning, and disk reading (`fs.writeFileSync`, `fs.readFileSync`, `fs.mkdtempSync`).
  - Real Node.js child processes and exit codes (`execute_terminal_command` running `node -e "..."` with real exit codes `0` and `1`).
  - Real `ToolDispatcher`, `validateRoleToolCall`, `LoopDetector`, `InMemoryTaskPlanner`, and `StateLedger`.
  - Real `AbortController` and `AbortSignal` listener attachments and teardowns.
- **Mocked Components:**
  - LLM Provider Completions (`client.completeWithHistory`): Mocked via deterministic function callbacks to simulate model streaming and tool invocation without requiring external API keys or incurring commercial LLM costs.

### 5.4 Defects Discovered & Resolved During Audit

1. **Defect 1: Loop Detector Blocking Valid Verification Retries**
   - *Symptom:* In retry exhaustion workflows, the Verifier running the same test command on attempt 2 was intercepted by `LoopDetector` with `[LOOP PREVENTED]`.
   - *Root Cause:* In `agentOrchestrator.ts:330`, `resultOk` was evaluated as `!result.startsWith('Error:')`, which erroneously marked failed terminal executions (`[TERMINAL EXECUTION FAILED]\nExit Code: 1`) as `resultOk = true`. `LoopDetector` then treated the second run as a duplicate successful execution.
   - *Fix:* Enhanced `resultOk` evaluation to check for `!resStr.includes('FAILED') && !/Exit Code:\s*[1-9]/i.test(resStr)` so failed commands are recognized as failures.
   - *Verification:* Verified via `Retry exhaustion halts safely at max attempts when test cannot be resolved`.

2. **Defect 2: Missing Verification Evidence Treated as Passed**
   - *Symptom:* If a model invoked `complete_plan_step` without running verification checks, the verifier allowed completion.
   - *Root Cause:* `verifierRole.ts` allowed `stepCompleted || taskFinished` to set `passed = true` when `checks.length === 0`.
   - *Fix:* Strictly enforced empirical proof: if `passedChecks.length === 0`, `passed = false` with explicit reason: `"No verification command or diagnostics check was executed. Step remains unverified."`
   - *Verification:* Verified via `multiAgentWorkflow.test.ts`.

3. **Defect 3: Info Query Prompt Classification Strict Inequality**
   - *Symptom:* Info queries mentioning code terms (e.g. "explain how this class works") fell through to `'general'` and invoked coding roles.
   - *Root Cause:* `promptClassifier.ts` required `uiScore === 0 && backendScore === 0` for `'info'`, whereas UI and backend only required majority scores.
   - *Fix:* Added `if (infoScore > uiScore && infoScore > backendScore) return 'info';` to allow informational queries with code nouns to route to the fast path.
   - *Verification:* Verified via `Simple info question routes to Researcher only without invoking Planner or Coder`.

---

## 6. Test Suite Metrics Comparison

| Metric | Phase 2 Baseline | Phase 3 Baseline | Phase 4 Initial | Phase 4 Post-Audit |
|---|:---:|:---:|:---:|:---:|
| Total Test Files | 4 | 5 | 7 | **7** |
| Total Executable Tests | 66 | 76 | 86 | **91** |
| Passing Tests | 66 | 76 | 86 | **91 (100%)** |
| Failing Tests | 0 | 0 | 0 | **0** |
| Skipped Tests | 0 | 0 | 0 | **0** |
| Compilation Errors | 0 | 0 | 0 | **0** |

---

## 7. Remaining Risks & Next Action

### 7.1 Remaining Risks

1. **Local Model Token Budgets:** When using 4B quantized models locally via Ollama, verbose research findings could approach context limits. Strict line-bounding (`estimateTokens`, `truncateToTokens`) is active, but monitoring real local inference latency is recommended.
2. **VS Code Extension Host Isolation:** While all 91 unit and integration tests pass under the standalone Mocha CLI with `mockVscode.js`, live interactive validation in an actual VS Code window (e.g. via F5 Extension Development Host) requires visual confirmation of the webview sidebar UI.

### 7.2 Exact Next Action

- **Status:** Phase 4 implementation, testing, runtime tracing, and audit are 100% complete.
- **Action:** Awaiting user sign-off and approval before considering any subsequent architectural phases.
