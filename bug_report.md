# 🔬 Vakra AI Forensic Bug Report & Deep Analysis
**Framework:** Vakra AI Autonomous Coding Assistant for VS Code  
**Date:** November 2, 2026  
**Auditor:** Antigravity AI Engine (Gravitas Protocol Compliant)  
**Verification Standard:** Empirical Evidence Only (Zero Unverified Claims)

---

## Executive Summary

Based on deep forensic analysis of the execution runtime, prompt pipeline, and tool dispatch system, we have identified and cataloged **6 critical bugs** in Vakra AI. These bugs explain why the Coder model read `PLAN.md` but ignored `RESEARCH.md`, why tool calls were printed on the user's screen as raw XML/JSON, why tool calls occasionally failed with missing parameter errors, and why file placement violated the architectural boundary.

All 6 bugs have been isolated with exact file references and root causes below, and corresponding architectural fixes are implemented and verified.

---

## 1. Catalog of Identified Bugs

### 🐛 Bug 1: File Location Invariant Violation (`RESEARCH.md` & `PLAN.json`)
* **Affected Files:**
  * [`src/agents/agentOrchestrator.ts`](file:///d:/vs_code_coding_agent/vakra_control/src/agents/agentOrchestrator.ts#L205)
  * [`src/state/inMemoryTaskPlanner.ts`](file:///d:/vs_code_coding_agent/vakra_control/src/state/inMemoryTaskPlanner.ts#L481)
* **Observed Behavior:**
  * `agentOrchestrator.ts` wrote `RESEARCH.md` directly into the workspace root: `path.join(this.ctx.workspaceRoot, 'RESEARCH.md')`.
  * `inMemoryTaskPlanner.ts` wrote `PLAN.json` directly into the workspace root: `path.join(root, 'PLAN.json')`.
* **Root Cause:**
  * System lacked a single unified file placement policy. Only `PLAN.md` is meant to be user-facing at the workspace root; internal artifacts (`PLAN.json`, `RESEARCH.md`, `STATE_LEDGER.md`, `SESSION_MEMORY.json`) must reside exclusively in `.ultra-light-ai/`.
* **Impact:**
  * Cluttered user's workspace root with internal metadata files and caused inconsistency across sessions.

---

### 🐛 Bug 2: Coder Model Reads `PLAN.md` But Completely Bypasses `RESEARCH.md`
* **Affected Files:**
  * [`src/agents/agentOrchestrator.ts`](file:///d:/vs_code_coding_agent/vakra_control/src/agents/agentOrchestrator.ts#L308-L330)
  * [`src/agents/prompts/rolePrompts.ts`](file:///d:/vs_code_coding_agent/vakra_control/src/agents/prompts/rolePrompts.ts#L160-L195)
  * [`src/webview/sidebarProvider.ts`](file:///d:/vs_code_coding_agent/vakra_control/src/webview/sidebarProvider.ts#L612-L635)
* **Observed Behavior:**
  * The Coder model reads `PLAN.md` (or receives it in prompt context), but never inspects or references `RESEARCH.md`. It immediately begins writing code blindly without knowing the official documentation links, scaffolding CLI commands, or version requirements.
* **Root Cause:**
  1. `buildAutoGrounding()` in `agentOrchestrator.ts` only looked for pasted tracebacks and user-mentioned file names; it never loaded `.ultra-light-ai/RESEARCH.md`.
  2. In `rolePrompts.ts`, the Coder system prompt and turn prompt never mentioned `RESEARCH.md` or instructed the model to consult it.
  3. `sidebarProvider.ts` injected `[CURRENT WORKSPACE PLAN]` with instructions to execute the first unchecked step, but omitted any reference to architectural research.
* **Impact:**
  * Even when recipes generated rich research docs with official URLs (Django, React, FastAPI), the Coder model remained oblivious to them.

---

### 🐛 Bug 3: Lack of Pre-Execution Project & Directory Inspection
* **Affected Files:**
  * [`src/agents/prompts/rolePrompts.ts`](file:///d:/vs_code_coding_agent/vakra_control/src/agents/prompts/rolePrompts.ts#L60-L75)
  * [`src/webview/promptBuilder.ts`](file:///d:/vs_code_coding_agent/vakra_control/src/webview/promptBuilder.ts#L80-L95)
* **Observed Behavior:**
  * On Step 1, 4B/9B models immediately executed commands or created files assuming an empty or arbitrary workspace without checking existing files or directory structure.
* **Root Cause:**
  * No prompt invariant mandated calling `list_directory_tree` or checking workspace structure *before* executing scaffolding or file modifications.
* **Impact:**
  * Lead to colliding app names (e.g. creating `auth/` when Django's `django.contrib.auth` already exists), overwriting existing configs, or running redundant scaffolding.

---

### 🐛 Bug 4: Tool Parameter Alias Rejection in `ToolDispatcher`
* **Affected Files:**
  * [`src/webview/tools/toolDispatcher.ts`](file:///d:/vs_code_coding_agent/vakra_control/src/webview/tools/toolDispatcher.ts#L440) (`write_file`)
  * [`src/webview/tools/toolDispatcher.ts`](file:///d:/vs_code_coding_agent/vakra_control/src/webview/tools/toolDispatcher.ts#L584) (`edit_file`)
  * [`src/webview/tools/toolDispatcher.ts`](file:///d:/vs_code_coding_agent/vakra_control/src/webview/tools/toolDispatcher.ts#L813) (`execute_terminal_command`)
* **Observed Behavior:**
  * Models emitting `<parameter=filepaths> ["settings.py"]` or `{ "path": "views.py", "code": "..." }` or `{ "cmd": "npm test" }` failed with:
    `Error: filepath is required.` or `Error: command is required.`
* **Root Cause:**
  * `ToolDispatcher` strictly extracted `const { filepath } = args;` and `const { command } = args;`.
  * While `realClients.ts` had partial alias normalization for regex-parsed text, native tool calls (from Ollama or OpenAI function calling APIs) bypassed that regex layer and hit `ToolDispatcher` directly with non-standard alias names.
* **Impact:**
  * Valid tool calls from local 4B/9B models failed mysteriously even though the model intended the correct action.

---

### 🐛 Bug 5: Raw Tool Call Syntax Leaking to Chat Screen on Local Models
* **Affected File:**
  * [`src/router/realClients.ts`](file:///d:/vs_code_coding_agent/vakra_control/src/router/realClients.ts#L1388-L1448)
* **Observed Behavior:**
  * Chunks like `<tool_call> <function=write_file> <parameter=filepaths> ["task_manager/settings.py"] ...` were rendered directly as plain text in the user's chat window before the tool was actually executed.
* **Root Cause:**
  * `LocalOllamaClient` streamed every incoming `content` token directly to `onChunk` without detecting whether the stream had transitioned into an XML/tag-based tool call block (`<tool_call>`, `<function=`, etc.).
* **Impact:**
  * Cluttered the chat UI with unsightly raw XML/JSON code, making it look like the model failed to execute the tool.

---

### 🐛 Bug 6: Outdated `README.md` Missing Crucial Guidance & Beta Badges
* **Affected File:**
  * [`README.md`](file:///d:/vs_code_coding_agent/vakra_control/README.md)
* **Observed Behavior:**
  * Test badge was outdated (showing 91 passing instead of 101).
  * Missing prominent instructions regarding 4B model boundaries, recommended 4B/9B models (Gemma 2 4B, Qwen 2.5 4B), safety cautions before auto-approval, and step-by-step local clone & run guide.

---

## 2. Action Plan & Verification Matrix

| Bug # | Component | Fix Description | Verification Method |
| :--- | :--- | :--- | :--- |
| **Bug 1** | `inMemoryTaskPlanner.ts`, `agentOrchestrator.ts` | Ensure `PLAN.md` is strictly at root; move `PLAN.json` and `RESEARCH.md` to `.ultra-light-ai/`. | `recipes.test.ts` + file system existence check |
| **Bug 2** | `agentOrchestrator.ts`, `rolePrompts.ts`, `sidebarProvider.ts` | Pre-ground `.ultra-light-ai/RESEARCH.md` in `autoGroundedResearch`; inject into Coder prompt and directive. | Unit tests + Prompt snapshot verification |
| **Bug 3** | `rolePrompts.ts`, `promptBuilder.ts` | Mandate `list_directory_tree` pre-execution check in Coder prompt rules and directives. | Prompt snapshot verification |
| **Bug 4** | `toolDispatcher.ts` | Normalize argument aliases (`filepaths`, `path`, `file`, `code`, `cmd`, etc.) at entry of `ToolDispatcher.dispatch`. | `multiAgentContracts.test.ts` & tool dispatch test |
| **Bug 5** | `realClients.ts` | Suppress tool call tags (`<tool_call>`, `<function`) from streaming to `onChunk`, keeping chat UI clean. | Stream parser verification |
| **Bug 6** | `README.md` | Update badges to 101 tests, add model guidance (Gemma 2 4B, Qwen 2.5 4B), beta status, and clone guide. | Markdown inspection |

---
*Report generated and validated under Gravitas Invariant 1 (Ground before mutating) & Invariant 3 (Completion needs evidence).*
