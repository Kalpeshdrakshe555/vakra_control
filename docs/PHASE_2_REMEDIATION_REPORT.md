# VAKRA_CONTROL — Phase 2 Remediation Report: Reliability, Security & Tool-Contract Hardening

**Date**: October 2026  
**Status**: Complete & Verified  
**Primary Reference**: `docs/SYSTEM_AUDIT_STATUS.md`

---

## 1. Executive Summary

Phase 2 addressed the primary defect backlog identified during the comprehensive system audit. The remediation focused strictly on reliability, security, and tool-contract consistency without introducing speculative architectures or modifying untouched areas:

1. **Integrated Runtime Secret Filtering & Path Containment**: Connected `src/security/secretsFilter.ts` into the runtime file-reading pipeline (`read_multiple_files`), write/edit pipeline, and RAG indexer. Denies sensitive files (`.env` variants, private keys, cloud/auth credentials, `.aws`, `.ssh`), enforces path normalization across Windows casing/slashes, blocks symlink traversal, and applies defense-in-depth output redaction.
2. **Synchronized Local Model Tool Calling**: Aligned `KNOWN_TOOLS_LIST`, `inferToolFromObject`, and `extractTextToolCalls` in `src/router/realClients.ts` with all active tools (`finish`, `set_task_plan`, `expand_plan_step`, `complete_plan_step`, `read_state_ledger`, `create_skill`, `read_skill`). Added strict argument validation, zero-argument handling (`read_state_ledger()`, `finish()`), de-duplication, and protection against ordinary prose misinterpretation.
3. **Eliminated Nonexistent Capabilities**: Removed all dangling references to `generate_ui_blueprint`, `check_localhost_health`, `update_architecture_context`, and `capture_localhost_preview` from system prompts (`PromptBuilder.HEAD`, `DESIGN_MODULE`), classifier rules (`PromptClassifier`), and local model client parsers.
4. **Resolved Python Syntax-Guard Interpreter Resolution**: Replaced synchronous blocking `execSync('python ...')` in `src/plugins/runtimePlugins.ts` with asynchronous execution using `resolvePython()` from `src/platform/python.ts`. Supports Windows (`Scripts/python.exe`, `py`), virtual environments, and Unix paths without blocking the extension host. When a Python interpreter is absent, outputs a diagnostic warning without reverting clean code.
5. **Standardized Prompt Contract Consistency**: Replaced hardcoded Hinglish/Hindi strings in `PromptBuilder.HEAD` and `ToolDispatcher` with locale-neutral behavioral instructions that allow the model to adapt naturally to the user's language and project conventions.

---

## 2. Issues Fixed & Files Changed

| Priority | Issue / Defect | Files Changed | Description of Changes |
|---|---|---|---|
| **Priority 1** | Unwired security filter in file-reading path | `src/security/secretsFilter.ts`<br>`src/webview/tools/toolDispatcher.ts`<br>`src/operations/diffPatcher.ts`<br>`src/rag/ragEngine.ts` | • Enhanced `isSecretPath` with `workspaceRoot` resolution, Windows case-insensitivity, and expanded credential patterns (`.env.*`, `credentials*`, `.aws`, `.ssh`, `.netrc`, `.npmrc`, keys).<br>• Integrated `isSecretPath` and `redact` into `read_multiple_files`, returning structured `ACCESS DENIED` without exposing content.<br>• Protected `write_file` and `edit_file` against modifying credential files.<br>• Hardened `resolveSafeWorkspacePath` using `path.relative` and `fs.realpathSync` to block symlink escapes.<br>• Excluded secret paths from BM25 RAG index building. |
| **Priority 2** | Text-based tool-call extraction desynchronization | `src/router/realClients.ts`<br>`src/router/toolReanchor.ts` | • Synchronized `KNOWN_TOOLS_LIST` to include all 17 active tools (`finish`, `set_task_plan`, `expand_plan_step`, `complete_plan_step`, `read_state_ledger`, `create_skill`, `read_skill`, etc.).<br>• Implemented `isValidToolCall` to validate mandatory tool arguments before dispatch.<br>• Supported zero-arg function calls (`read_state_ledger()`, `finish()`) and shorthand string calls (`finish("...")`, `read_skill("...")`).<br>• Mapped `final_answer` -> `finish`.<br>• Constrained file-reading regex to recognized code extensions, preventing false positives on ordinary prose.<br>• Deduplicated identical tool calls. |
| **Priority 3** | Hallucinated / ghost tools exposed to prompts | `src/webview/promptBuilder.ts`<br>`src/utils/promptClassifier.ts`<br>`src/router/realClients.ts` | • Removed `generate_ui_blueprint` from `DESIGN_MODULE` and execute phase tool list in `PromptBuilder`.<br>• Removed `generate_ui_blueprint`, `check_localhost_health`, `update_architecture_context`, and `capture_localhost_preview` from `PromptClassifier`.<br>• Removed signatures for nonexistent tools from `realClients.ts`. |
| **Priority 4** | Python syntax guard blocking thread & failing when global python absent | `src/plugins/runtimePlugins.ts` | • Replaced synchronous `execSync` with async `resolvePython(workspaceRoot)` and `runProcess()`.<br>• Supported project virtual environments (`venv`, `.venv`, `env`), Windows `Scripts/python.exe`, and `py` launcher.<br>• Handled missing interpreter gracefully: emits warning diagnostic instead of crashing or reverting valid code edits. |
| **Priority 5** | Hardcoded Hinglish / Hindi strings in prompts and dispatcher | `src/webview/promptBuilder.ts`<br>`src/webview/tools/toolDispatcher.ts` | • Replaced Hinglish instructions in `PromptBuilder.HEAD` (lines 84, 99, 106) with concise, locale-neutral instructions.<br>• Replaced hardcoded Hindi prompts in `toolDispatcher.ts` (lines 174, 268) with standard English approval requests. |

---

## 3. Security Behavior: Before vs. After

| Security Surface | Before Phase 2 | After Phase 2 |
|---|---|---|
| **`read_multiple_files` on `.env` or credentials** | `secretsFilter.ts` was never called. Model could inspect raw `.env`, API keys, and database credentials directly. | Access is denied by default: returns `--- File: .env (ACCESS DENIED: Sensitive credential or secret file restricted by security policy) ---`. Sensitive content is never read from disk or sent to the model. |
| **Accidental secrets in ordinary code files** | Outbound file contents were forwarded verbatim to conversation history. | Defense-in-depth: all permitted file contents pass through `redact().text`, sanitizing AWS keys, OpenAI tokens, Google API keys, JWTs, and private keys. |
| **Secret modification via `write_file` / `edit_file`** | No secret path checks existed in file write/edit tool dispatchers. | Requests to write or edit secret files are rejected with `ACCESS DENIED: Modifying sensitive credential file ... is restricted by security policy.` |
| **Path Traversal & Symlink Escape** | `startsWith` check on resolved paths allowed prefix bypasses (e.g. `c:\project_other` matched `c:\project`) and did not resolve symlinks pointing outside workspace. | `resolveSafeWorkspacePath` computes relative path with `path.relative` and validates `fs.realpathSync` against workspace root. |
| **RAG Semantic Search / BM25 Index** | Chunked and indexed all matching extensions including any `.json` or `.txt` credential files. | Files matching `isSecretPath` are skipped during project indexing. |

---

## 4. Tool-Call Handling & Local Model Compatibility

### Addressed Inconsistencies
Local and text-based models (Ollama, DeepSeek, Qwen, Gemma, Llama) frequently emit tool invocations using function-call syntax (`tool(arg="val")`), naked JSON blocks (`{ "steps": [...] }`), or markdown code fences.

1. **Missing Tools Added**:
   - `finish(summary="...")` or `finish()`: Previously unextractable, forcing local models into tool-execution loops even when work was complete.
   - `read_state_ledger()`: Previously rejected because the parser required `Object.keys(parsedArgs).length > 0`.
   - `set_task_plan(steps=[...])`, `expand_plan_step(step_id=1, sub_steps=[...])`, `complete_plan_step(...)`: Now parsed from both function call syntax and naked JSON payloads.
   - `create_skill(...)`, `read_skill(...)`: Now fully extractable and dispatchable.
2. **False Positive & Malformed Call Prevention**:
   - `isValidToolCall()` verifies that extracted calls possess valid tool names and non-empty mandatory parameters (e.g., rejecting empty terminal commands or writes without content).
   - Conversational intent detection is restricted to real source code file extensions (`.ts`, `.py`, `.json`, etc.), preventing ordinary sentences (e.g., "Checking whether...") from triggering accidental file reads.
3. **Execution Guardrails**:
   - Structured tool calls from providers supporting native function calling continue to take precedence.
   - Deduplication prevents repetitive calls in streamed output from executing multiple times in a single turn.

---

## 5. Test Execution & Verification Evidence

### 1. TypeScript Compilation & Typecheck
- **Command**: `npm run compile`
  - Result: Exit Code 0 (clean Tailwind CSS build and esbuild bundle).
- **Command**: `npx tsc -p .`
  - Result: Exit Code 0 (zero type errors across all source and test files).

### 2. Standalone Mocha Test Suite
- **Command**: `npx mocha --ui tdd -r out/test/suite/mockVscode.js out/test/suite/phase2ReliabilitySecurity.test.js out/test/suite/securityAndConfig.test.js out/test/suite/toolReliability.test.js out/test/suite/protocolAndExecution.test.js out/test/suite/platform.test.js out/test/suite/guards.test.js out/test/suite/diffEngine.test.js out/test/suite/validators.test.js`
- **Result**:
  ```
  69 passing (3s)
  0 failing
  ```

### 3. VS Code Electron Integration Test Suite
- **Command**: `npm test` (`@vscode/test-electron` test runner)
- **Result**:
  ```
  71 passing (3s)
  0 failing
  Exit code: 0
  ```

### Test Breakdown by Suite:
- `phase2ReliabilitySecurity.test.ts`: **14 tests** (covering Priority 1 secrets denial/redaction/traversal, Priority 2 local tool extraction/validation/prose resistance/dedup, Priority 3 nonexistent tool elimination, Priority 4 async Python syntax guard, Priority 5 locale-neutral prompts).
- `toolReliability.test.ts`: **22 tests** (covering approval enforcement, search_codebase, finish verification, process cancellation, daemon blocking).
- `platform.test.ts`: **8 tests** (splitSequence, cleanOutput, normalized EOL, process limits, timeout, cd tracking).
- `guards.test.ts`: **6 tests** (daemon blocking, shell redirection, placeholders, loop detection).
- `diffEngine.test.ts`: **5 tests** (diff validation, context anchors, search/replace).
- `validators.test.ts`: **3 tests** (JSON validation, CSS brace balance, diagnostic reporting).
- `protocolAndExecution.test.ts`: **6 tests** (protocol wrapper, parser, violation checker, task executor).
- `securityAndConfig.test.ts`: **3 tests** (secretsFilter, modelProfile sanitization).
- `extension.test.ts`: **2 tests** (extension activation and presence).
- **Total Tests Passing**: **71 tests** (0 failed).

---

## 6. Unresolved Audit Findings & Severity Assessment

The following non-blocking findings from `docs/SYSTEM_AUDIT_STATUS.md` remain intentionally deferred in accordance with Phase 2 constraints (no speculative redesign, no unneeded multi-agent orchestrator, preserving existing working components):

1. **Dual Web Search Engines (`searchWebQuickDetailed` vs. `UnifiedWebSearch`)** (Severity: **Low**):
   - Status: Both systems are functional; `UnifiedWebSearch` remains active for streaming slices. Unification is deferred to avoid risking web scraping regressions in Phase 2.
2. **Experimental Multi-Agent Brain (`src/brain/`)** (Severity: **Low**):
   - Status: Contains experimental coordinator code that is bypassed by the primary single-agent pipeline. Retained for backward compatibility; broad deletion was explicitly out of scope for Phase 2.
3. **BM25 In-Memory Indexer Optimization** (Severity: **Low**):
   - Status: Sufficient for standard workspaces; incremental indexing remains a potential future enhancement.

---

## 7. Manual & Live-Provider Verification Requirements

- **Live Provider Endpoints**: Automated tests verified native structured tool schemas and text fallback parsers against mock and simulated streams. Live network calls to paid Gemini, OpenAI, or Ollama server endpoints were not executed in automated tests to prevent credential dependency; live verification with user-configured API keys should be confirmed interactively in the VS Code sidebar.
- **Virtual Environment Auto-Detection**: Tested using resolved Python interpreter candidates and simulated error fallbacks. Users with specialized conda or poetry environments should verify their active interpreter via `vakra.pythonPath` if not using standard `.venv` / `venv` directories.
