# 🚀 VAKRA CONTROL — MASTER SYSTEM REQUIREMENTS & PHASED EXECUTION ROADMAP

> **Document Status**: Active Master Roadmap & Phased Execution Plan  
> **Core Target**: 4B Parameter Models (Gemma 4 E4B Vision, Nemotron-3-Nano 4B, Qwopus/Qwen 2.5 Coder 3B/4B) operating stably at **40,000–60,000+ tokens context** with sub-second generation (~35–42 TPS) and zero API costs, with plug-and-play Cloud API connectivity.  
> **Architecture Strategy**: "4B Model = Next-Action Generator | Supervisor = Source of Truth & Protocol Gateway | Extension = Deterministic Heavy-Lifting".

---

## 🏆 Resolved & Archived Milestones (Foundation Complete)

| # | Milestone | Status | Key Deliverable |
|---|---|---|---|
| 1 | **Gaming Mode Complete Removal** | ✅ Verified | `gameRunnerPanel.ts` and casual HTML runners completely purged. |
| 2 | **Multi-Tier Diff Patcher Foundation** | ✅ Verified | 5-tier fuzzy matching with anti-elision guards. |
| 3 | **True File Rewind & Rollback** | ✅ Verified | Dual-layer disk and buffer state reversion with snapshots. |
| 4 | **Collapsible Thinking Stream** | ✅ Verified | Live `<think>` accordion without UI layout breakage. |
| 5 | **Tri-Choice Terminal Permission UX** | ✅ Verified | Interactive card (`Allow for Now`, `Skip`, `Allow All for Session`). |
| 6 | **Closed-Loop Terminal Interceptor** | ✅ Verified | Captures stdout/stderr exit codes and auto-feeds to LLM context. |
| 7 | **Context Mentions & Diagnostics** | ✅ Verified | `@file`, `@terminal`, `@git` input injections and autoFixDiagnostics. |

---

## 🧭 PHASED EXECUTION ROADMAP: FROM 60% TO 95% PRODUCTION GRADE

We will **NOT** implement everything at once. We will execute step-by-step in isolated, verifiable phases.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       STEP-BY-STEP EXECUTION PHASES                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ PHASE 1: Zero-Wipe Safety & Head/Tail Prompt Architecture (Day 1)           │ [COMPLETED & VERIFIED ✅]
│ PHASE 2: Tool Amnesia & Protocol Gateway (Day 2)                            │ [NEXT 🔴]
│ PHASE 3: Surgical Editing (replace_symbol) & In-Memory Planner (Day 3)      │
│ PHASE 4: Autonomous Web Researcher & Pre-Flight Scout Fix (Day 4)           │
│ PHASE 5: Tree-sitter WASM Function-Wise AST Chunking (Day 5–6)              │
│ PHASE 6: Multimodal Vision UI Debugging (Gemma 4 E4B) (Day 7)               │
│ PHASE 7: Closed-Loop Self-Healing Diagnostics & Rollback (Day 8)            │
│ PHASE 8: Extensibility & MCP Standard Client Integration (Future)           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📍 PHASE 1: Zero-Wipe Safety & Head/Tail Prompt Architecture — [COMPLETED & VERIFIED ✅]

### Step 1.1: Zero-Wipe Guard in `diffPatcher.ts`
* **Problem**: When a 4B model omits the `<<<<<<< SEARCH` block or outputs an empty search string, `diffPatcher.ts` considers it an intended full overwrite and silently wipes non-empty files!
* **Exact Fix**:
  ```typescript
  if (searchStr.trim().length === 0) {
      if (fileText.trim().length > 0) {
          return {
              success: false,
              result: fileText,
              error: "ZERO_WIPE_GUARD: Empty SEARCH block rejected for non-empty file. Use replace_symbol or provide exact SEARCH block."
          };
      }
      return { success: true, result: replaceStr };
  }
  ```
* **Success Criteria**: 0 accidental file erasures across 50 simulated broken search blocks.

### Step 1.2: Upgrade to Claude's Cached `HEAD` & Memoized `SESSION PREFIX`
* **Problem**: Current `promptBuilder.ts` has 292 lines of desperate begging rules at token 0, which breaks llama-server's `--cache-reuse 256` and wastes thousands of prompt tokens every single turn.
* **Exact Fix**:
  - Replace `src/webview/promptBuilder.ts` with Manager Claude's refactored `promptBuilder.ts`.
  - **`buildHead()`**: Static, byte-identical constant (~900 tokens). Never changes, guaranteed 100% cache hit!
  - **`buildSessionPrefix()`**: Stable per task (project profile, conventions, repo map), memoized with SHA1 hash.
  - Volatile items (terminal output, plan text) are stripped from the system prompt and moved to the dynamic tail.

### Step 1.3: Dynamic Tail Block Re-Anchoring (`toolReanchor.ts`)
* **Problem**: 4B models suffer from attention drift at 40k+ tokens; they forget tool instructions because they are buried at token 0.
* **Exact Fix**:
  - Copy `managers_response/manager_claud_response/toolReanchor.ts` to `src/router/toolReanchor.ts`.
  - Append the `[STATE]` + `[TOOLS]` card as the very last message in the context window via `withTailReanchor`.
  - Tail block contains: current step, touched files, last error/result, and active tool signatures (~150 tokens).

---

## 📍 PHASE 2: Tool Amnesia, Repair Layer & Protocol Gateway [COMPLETED & VERIFIED ✅]

### Step 2.1: Naked JSON & Bracket Repair Layer
* **Problem**: 4B models frequently output:
  - Naked JSON: `{"filepaths": ["catalog/views.py"]}` without `name`.
  - Conversational preamble before JSON: *"I am reading the file... {"name": ...}"*.
  - Truncated parameter brackets when tokens are tight.
* **Exact Fix**:
  - Integrate `extractJsonObject(text)`: Scans for the first balanced `{...}` and auto-balances unclosed brackets.
  - Integrate `matchToolByArgs(obj, tools)`: Matches naked JSON to tool by property key overlap.
  - Integrate `repairToolCall(raw, tools)`: Normalizes malformed responses before tool dispatch.

### Step 2.2: Hard Protocol Gateway & Discipline Loop
* **Problem**: If the model outputs conversational prose instead of invoking a tool, the agent stalls and forgets its task.
* **Exact Fix**:
  - Implement `evaluateModelReply`:
    - Turn produces tool call -> reset `consecutiveNoToolTurns = 0`.
    - Turn produces prose when tool is expected -> inject 1-line nudge: *"WARNING: You must emit a tool call. No prose."*
    - If 2 consecutive prose turns occur -> force constrained decoding (`json_schema` / GBNF grammar).

### Step 2.3: Tool Turn Persistence in History
* **Problem**: `sidebarProvider.ts` only saves the final plain text in `conversationHistory`, dropping `tool_calls` and tool outputs. On the next turn, the model sees no record of its previous tool actions!
* **Exact Fix**: Preserve assistant tool invocations and tool observation results in the active session history.

---

## 📍 PHASE 3: Surgical Editing (`replaceSymbol.ts`) & In-Memory Task Planner [COMPLETED & VERIFIED ✅]

### Step 3.1: LSP-Backed Surgical Edit (`replace_symbol`)
* **Problem**: 4B models cannot reliably reproduce 30 lines of code verbatim with exact indentation to form a search block.
* **Exact Fix**:
  - Copy `managers_response/manager_claud_response/replaceSymbol.ts` to `src/operations/replaceSymbol.ts`.
  - Register `replace_symbol` tool in `ToolRegistry.ts` (`filepath`, `symbolName`, `newCode`).
  - VS Code LSP `DocumentSymbol` locates exact start and end line ranges (including `@decorators` and indentation).
  - Applies atomic edit via `vscode.WorkspaceEdit`.
  - Diagnostics verification: Checks for compiler errors after edit; auto-rollbacks if new syntax errors are introduced.

### Step 3.2: In-Memory Task Planner (Zero Workspace Garbage)
* **Problem**: Current agent writes `.ultra-light-ai/PLAN.md` into the user's project, which gets indexed into RAG, leaks into code retrieval, and traps the model in an infinite planning loop.
* **Exact Fix**:
  - Copy `managers_response/manager_claud_response/inMemoryTaskPlanner.ts` to `src/state/inMemoryTaskPlanner.ts`.
  - Store plan in `ctx.workspaceState` and runtime memory. **Zero `.md` files written to project root**.
  - **Auto-Advancement Logic**: The harness automatically marks steps as `done` when:
    - Target file was edited (`file_edited`).
    - Terminal command exited with code 0 (`command_ok`).
  - The model NEVER has to manually tick checkboxes or edit markdown plans!
  - Stream plan progress to webview UI via `postMessage({ type: 'update_plan_stepper', plan })`.

### Step 3.3: Exclude `.ultra-light-ai` from RAG Indexing
* **Problem**: `ragEngine.ts` was not ignoring `.ultra-light-ai`, causing metadata leakage into code context.
* **Exact Fix**: Add `.ultra-light-ai` to default ignore folders in `ragEngine.ts` and `codeIndexer.ts`.

---

## 📍 PHASE 4: Autonomous Web Researcher & Pre-Flight Scout Fix [COMPLETED & VERIFIED ✅]

### Step 4.1: Root Cause Analysis of Researcher Inactivity
1. **Passive Model Prompting**: 4B models do not proactively think to call `research_web_docs` because their default behavior is to guess from training weights.
2. **DuckDuckGo Anti-Bot Blocking**: `scraper.ts` uses raw `fetch('https://html.duckduckgo.com/html/?q=...')`. DuckDuckGo frequently returns HTTP 202/403 or bot captchas, causing `searchWeb()` to silently return `""` (empty string).
3. **Missing Package Registry Direct APIs**: For 90% of coding tasks (e.g. Django, Next.js, Tailwind), documentation is available directly via JSON APIs without web scraping!

### Step 4.2: Direct Registry API Providers in `scraper.ts` (Zero Scraping, Zero Captchas)
Add direct, reliable API fallbacks in `src/tools/scraper.ts`:
* **Python Packages (PyPI JSON API)**:
  `https://pypi.org/pypi/<package_name>/json` -> Returns exact latest version, summary, dependencies, and official docs URL.
* **Node Packages (npm Registry API)**:
  `https://registry.npmjs.org/<package_name>` -> Returns latest version, README markdown, and entry points.
* **GitHub Official Docs**:
  `https://raw.githubusercontent.com/<owner>/<repo>/main/README.md`.
* **Multi-Search Fallback**:
  If DuckDuckGo fails or returns empty, automatically fallback to SearXNG or clean Google/Brave API proxy instead of returning empty text.

### Step 4.3: Autonomous Pre-Flight Scout Pattern (Supervisor Gated)
Instead of waiting for the 4B model to realize it needs docs, the **Supervisor runs the Scout BEFORE invoking the coding LLM**:
```
User Prompt: "Create a modern Django app with django-tailwind 4 and flowbite"
     │
     ▼
Supervisor Pre-Flight Dependency Scanner
  - Extracts library names: ['django-tailwind', 'flowbite']
  - Checks local requirements.txt / package.json -> Not present or unknown version
     │
     ▼
Autonomous Scout Fetches Live Docs via PyPI / npm APIs
  - Fetches setup snippet & installation command
  - Distills to ≤800 tokens: [LIVE DOCS: django-tailwind@latest]
     │
     ▼
Context Compiler Injects [LIVE DOCS] into Prompt
     │
     ▼
4B Model Receives 100% Verified, Current Code Patterns on Turn 1!
```

---

## 📍 PHASE 5: AST Boundary Chunking & 1-Hop Symbol Expansion [COMPLETED & VERIFIED ✅]

### Step 5.1: Replace Line-Based Regex Chunking
* **Problem**: In `codeIndexer.ts`, when symbol providers fail or on syntax-error fallback, code gets cut into arbitrary 80-line chunks. Function signatures end up in Chunk A, while return statements end up in Chunk B, crippling 4B model context.
* **Exact Fix**:
  - Install `web-tree-sitter` and bundle prebuilt WASMs (`tree-sitter-python.wasm`, `tree-sitter-typescript.wasm`, `tree-sitter-html.wasm`).
  - Chunk code strictly at AST boundaries: `function_definition`, `class_definition`, `method_definition`.
  - For large functions (>100 lines), split only at top-level child statement boundaries while copying the parent function signature and docstrings into each chunk header.

### Step 5.2: Structured `CodeChunk` & 1-Hop Symbol Expansion
* Return structured chunks with `symbolPath` (`['Product', 'save']`), `nodeType`, and `imports`.
* Implement 1-hop symbol expansion in RAG: When a view function is retrieved, also retrieve its referenced model or serializer chunk.

---

## 📍 PHASE 6: Multimodal Vision UI Debugging (Gemma 4 E4B) [COMPLETED & VERIFIED ✅]

### Step 6.1: Windows Native Zero-Download Vision Capture
* **Problem**: Inspecting localhost web previews (catching broken CSS, overlapping flexboxes, missing buttons) requires browser screenshots, but downloading heavy browser binaries is slow and fragile.
* **Exact Fix**:
  - Copy `managers_response/manager_claud_response/visionCapture.ts` to `src/tools/visionCapture.ts`.
  - Uses `puppeteer-core` to drive the user's **existing system Microsoft Edge or Google Chrome** (always present on Windows!). Zero extra browser downloads.
  - Captures localhost screenshots (desktop 1440px and mobile 375px viewports) to PNG base64 buffers.

### Step 6.2: DOM Heuristics + Gemma 4 E4B Vision Audit
* `visionCapture.ts` extracts automated DOM heuristics:
  - Horizontal overflow (`scrollWidth > clientWidth`).
  - Zero-size or hidden interactive elements.
  - Browser console error logs.
* Passes screenshot + DOM heuristics to Gemma 4 E4B via `llama-server.exe` multimodal endpoint.
* Gemma identifies visual defects, and the supervisor applies surgical CSS/HTML fixes via `replace_symbol`.

---

## 📍 PHASE 7: Closed-Loop Self-Healing Diagnostics & Multi-File Transactions [COMPLETED & VERIFIED ✅]

### Step 7.1: Automated Terminal Error Diagnostic Pre-Checks
* **Problem**: In Django tests, when `TemplateDoesNotExist: catalog/product_list.html` occurred, the model gave up instead of checking why the file was missing.
* **Exact Fix**:
  - Update `src/utils/errorDiagnoser.ts` with error-pattern actions:
    - `TemplateDoesNotExist: X` -> Automatically resolves against `TEMPLATES['DIRS']` and app template directories; returns directory existence report directly into context.
    - `ModuleNotFoundError: No module named 'X'` -> Triggers Scout to fetch install command.
  - Model receives concrete diagnostic facts rather than vague traceback strings.

### Step 7.2: Multi-File Transaction Snapshots
* Group all file edits belonging to an agent task under a single Transaction ID (`fileVersioning.ts`).
* If a terminal verification command (e.g. `pytest` or `npm run build`) fails after 3 repair attempts, offer instant 1-click group rollback to the pre-task snapshot.

---

## 📍 PHASE 8: Extensibility & MCP Client Integration (Future Sprint)

### Step 8.1: Model Context Protocol (MCP) Standard Client
* Support `.ultra-light-ai/mcp_config.json` for external stdio MCP tools (PostgreSQL, SQLite, GitHub, Filesystem).
* Seamlessly expose MCP tools inside the dynamic tail tool card.

---

## 📅 VERIFIED ROADMAP SUMMARY & SPRINT PHASING

| Sprint | Target Days | Focus Areas | Deliverables |
|---|---|---|---|
| **Sprint 1 (Now)** | **Day 1** | Safety & Prompt Re-architecture | • Zero-Wipe Guard in `diffPatcher.ts`<br>• Refactored `promptBuilder.ts` (Static Head + Prefix Cache)<br>• `toolReanchor.ts` integration in `sidebarProvider.ts` |
| **Sprint 2** | **Day 2** | Tool Discipline & Protocol Gateway | • JSON extraction & naked JSON repair layer<br>• Discipline nudge loop (2-nudge retry)<br>• Tool call history persistence |
| **Sprint 3** | **Day 3** | Surgical Editing & Plan Isolation | • `replaceSymbol.ts` LSP tool in `diffPatcher.ts`<br>• `inMemoryTaskPlanner.ts` (0 files in workspace)<br>• UI Stepper wiring |
| **Sprint 4** | **Day 4** | Autonomous Web Researcher & Scout | • Direct Registry APIs in `scraper.ts` (PyPI, npm, GitHub)<br>• Pre-Flight Autonomous Scout injection (`[LIVE DOCS]`)<br>• DuckDuckGo anti-bot fix |
| **Sprint 5** | **Day 5–6** | Precision Retrieval (Tree-sitter) | • `web-tree-sitter` WASM chunker<br>• Complete function/class chunks in BM25 |
| **Sprint 6** | **Day 7** | Multimodal Vision (Gemma 4 E4B) | • `visionCapture.ts` via Windows Edge/Chrome<br>• Localhost preview screenshot + CSS fix loop |
| **Sprint 7** | **Day 8** | Closed-Loop Self-Healing | • Diagnostic rule table in `errorDiagnoser.ts`<br>• Multi-file transaction rollback |
