# ⚡ Vakra AI — System Architecture & Core Logics (`project_logic.md`)

> **Document Status:** Comprehensive Technical Specification  
> **Target Target:** Small Parameter Models (3B–7B, e.g. Gemma 4B, Qwen 2.5 Coder) on Restricted Context Windows (32k–40k tokens), as well as Frontier LLMs.

---

## 1. Executive Summary & Core Design Philosophy

Most modern AI coding agents (Devin, Cursor, Claude Code) are architected for **70B–200B+ models** running on **128k–200k+ token windows**. When deployed on small local models (such as 4B parameters with a 40k window), conventional agents fail due to five fundamental failure modes:

1. **Context Thrashing & Token Exhaustion:** Reading 3–4 large source files fills the 40k window, causing catastrophic forgetting of earlier instructions.
2. **Infinite Re-reading Loops:** Small models lack memory of what they read 2 steps prior, repeatedly invoking `readFile` on the same file until tool call limits terminate the turn.
3. **Turn-to-Turn Amnesia:** Once a turn completes or stops due to a step limit, the model starts the next turn with zero memory of intermediate files created or modified.
4. **Execution Directory Misplacement:** Small models consistently execute commands (like `python manage.py runserver` or `npm test`) in the workspace root rather than the nested directory containing project files.
5. **Instruction Competition & Hallucination:** Ambiguous or overlapping prompt instructions cause small models to deviate from architectural standards.

**Our Core Thesis:**  
*Offload memory management, directory resolution, and context compression to deterministic TypeScript middleware.*  
The LLM is freed from administrative overhead and acts purely as an advanced reasoning engine within a tightly bounded, high-signal context.

---

## 2. High-Level System Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 USER PROMPT / TASK                                      │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. INTAKE & CLASSIFICATION (PromptClassifier)                                           │
│    - Classifies prompt intent (Scaffold / Refactor / Debug / Question / Architect)      │
│    - Ingests active editor diagnostics, selection, and terminal states                  │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ 2. DETERMINISTIC CONTEXT ASSEMBLY (PromptBuilder)                                       │
│    ├─ Priority 0: Active Workspace Skill Protocols (Checklist & Prohibitions)           │
│    ├─ Core System Rules (Anti-reread, Atomic Patches, CWD guidelines)                   │
│    ├─ Micro Structural Repo-Map (Living Index / AST Signatures)                         │
│    ├─ Session Memory Footprint (Visited files, extracted symbols, imports)              │
│    └─ Conversation History with [PREVIOUS TURN EXECUTION RECORD]                        │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ 3. AUTONOMOUS TOOL EXECUTION LOOP (SidebarProvider + RealClients + ToolDispatcher)       │
│    Loop (1 to MaxSteps):                                                                │
│    ├─ Stream thought & tool invocation from LLM                                         │
│    ├─ Dispatch tool via ToolDispatcher (readFile, writeFile, patch, runCommand...)     │
│    ├─ Intercept CWD via TerminalCapture (Auto-routes manage.py / package.json)          │
│    ├─ Register file interactions in SessionMemory                                       │
│    ├─ Capture stdout / stderr / exceptions                                              │
│    └─ Re-anchor tool payload back to LLM context                                        │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ 4. TURN FINALIZATION & STATE CAPTURE                                                    │
│    - Summarize executed tools, created files, and unresolved errors                     │
│    - Store execution record in ConversationHistory for seamless next-turn continuity    │
│    - Update Webview UI (Tool cards, stream buffers, token telemetry)                   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Deep-Dive: Core Logics & Subsystems

### 3.1. Session Memory & Anti-Reread Heuristics (`src/state/sessionMemory.ts`)

#### Problem:
In small-context models, an agent investigating a bug often reads `models.py`, then `views.py`, then forgets `models.py` and reads it again. Within 4 tool calls, the 40k window is consumed by duplicate tokens.

#### Implementation Logic:
`SessionMemory` acts as an in-memory cache for the entire active session:
1. **File Registration:** Whenever `readFile`, `writeFile`, or `applyPatch` executes, `SessionMemory.recordFileRead(filePath, content)` or `recordFileWrite(filePath)` is called.
2. **Lightweight Symbol Extraction:** Instead of keeping the entire file content in memory, the system parses the file using regex/AST heuristics to extract:
   - Exported classes, functions, and interfaces.
   - Import dependencies.
   - Total line count and modification timestamps.
3. **Prompt Injection:**
   Before each turn, `SessionMemory.getFormattedMemory()` is appended to the system prompt:
   ```
   [SESSION VISITED FILES & SYMBOLS]
   - backend/models.py (140 lines) | Symbols: [UserProfile, ProductItem, Order]
   - backend/views.py (85 lines) | Symbols: [ProductListView, CheckoutAPI]
   NOTE: You have already inspected these files. Do NOT re-read them in full. Use targeted searches or edits directly.
   ```
4. **Anti-Reread Interception:** If the model requests `readFile` for a file already registered in session memory with identical hash, the system returns a compressed summary rather than re-flooding the context window.

---

### 3.2. Turn-to-Turn State Continuity (`src/state/conversationHistory.ts`)

#### Problem:
When an autonomous tool loop reaches the user's `Max Steps / Turn` limit (e.g. 25 steps) or pauses for user input, typical agents clear their tool scratchpad. In the next turn, the model has no record of which commands succeeded or which files were written.

#### Implementation Logic:
1. **Execution Delta Tracking:** During a turn, `sidebarProvider.ts` tracks:
   - `filesModified: Set<string>`
   - `commandsExecuted: Array<{ cmd: string, exitCode: number }>`
   - `lastError: string | null`
2. **Synthesized Execution Record:** At turn completion, an immutable record is generated:
   ```
   [PREVIOUS TURN EXECUTION RECORD]
   - Modified Files: backend/settings.py, backend/urls.py, shop/views.py
   - Commands Run: 'python manage.py makemigrations' (Exit: 0), 'python manage.py migrate' (Exit: 0)
   - Status: Migration completed. Pending verification check.
   ```
3. **Sliding Window Token Truncation:**
   `conversationHistory.getHistoryForLLM(limit, tokenLimit)` calculates:
   $$\text{MaxHistoryTokens} = \min(12000, \text{MaxContextTokens} \times 0.4)$$
   Older conversational turns are summarized, but the `[PREVIOUS TURN EXECUTION RECORD]` is always preserved in the final turn payload.

---

### 3.3. Workspace Skills & Conflict Resolution Engine (`src/features/skillsManager.ts`)

#### Problem:
Generic system instructions are either too vague or too bloated. Furthermore, when both built-in system safety rules and custom workspace skills exist for the same tech stack (e.g. Django), small models suffer from rule collision and confusion.

#### Implementation Logic:
1. **Directory Discovery:** Skills are discovered recursively across:
   - `.ultra-light-ai/skills/<skill-name>/SKILL.md`
   - `.agents/skills/`, `.agent/skills/`, `skills/`
   - Global home directory skills.
2. **YAML Frontmatter & Rule Triggers:**
   ```markdown
   ---
   name: "django"
   description: "Production-grade Django project architecture"
   trigger_rules: ["django", "manage.py", "drf", "models.py"]
   ---
   ## Rules & Checklist:
   1. Never create duplicate nested folder names.
   2. Always run `python manage.py check` before finishing.
   ```
3. **Multilingual & Hinglish Intent Matching:**
   `SkillsManager.getMatchingSkills(prompt, workspaceRoot)` inspects:
   - Explicit tags: `@django`, `@skill:django`
   - Trigger words: `django`, `manage.py`, `drf`
   - Hinglish phrases: `"skills folder me jo skill hai use use karo"`, `"skill follow kr"`
4. **Deterministic Conflict Resolution (Built-in Suppression):**
   ```typescript
   // If ANY custom workspace skill matches the prompt, completely
   // suppress Built-in System Skills to prevent conflicting rules!
   const hasCustomMatch = matchedSkills.some(s => !!s.filePath);
   if (hasCustomMatch) {
       return matchedSkills.filter(s => !!s.filePath);
   }
   ```
5. **Priority 0 System Prompt Enforcement:**
   Matched skills are injected at the very top of the system prompt under a mandatory contract header:
   `🚨 MANDATORY ACTIVE WORKSPACE SKILL PROTOCOL (PRIORITY 0 - ABSOLUTE ENFORCEMENT) 🚨`

---

### 3.4. Intelligent CWD & Terminal Auto-Routing (`src/tools/terminalCapture.ts`, `src/utils/terminalHeuristics.ts`)

#### Problem:
Small models frequently generate commands like:
`python manage.py runserver`
when the workspace root is `D:\my-project` but the actual Django project was created inside `D:\my-project\backend\manage.py`. The command fails with `FileNotFoundError: manage.py not found`.

#### Implementation Logic:
Before executing any shell command in `runCommand`:
1. **Anchor Analysis:** The system inspects the command string for framework execution anchors:
   - Django: `manage.py`
   - Node / React / Vue: `package.json`, `npm`, `pnpm`, `yarn`
   - Python Poetry / Pipenv: `Pipfile`, `pyproject.toml`
   - Java / Maven / Gradle: `pom.xml`, `build.gradle`
   - Rust: `Cargo.toml`
2. **Recursive Workspace Search:** If the anchor file is not present in the current working directory (`cwd`), the system performs a rapid search across child directories up to 3 levels deep.
3. **Automatic CWD Switching:** If `backend/manage.py` is found, the execution context is automatically routed to `D:\my-project\backend` with zero user intervention required.
4. **ANSI Stripping & Truncation:** Shell output is cleaned of ANSI escape sequences and truncated to the most recent 120 lines to prevent terminal buffer dumps from flooding the context window.

---

### 3.5. Micro AST Repo-Map & Skeletonizer (`src/indexer/livingIndex.ts`, `src/utils/astSkeletonizer.ts`)

#### Problem:
Providing full codebase listings consumes tens of thousands of tokens before the user's prompt is even read.

#### Implementation Logic:
1. **Living Index:** Maintains an incremental map of all project source files, tracking file sizes and exports.
2. **AST Skeletonization:** When generating structural context for large files, `AstSkeletonizer` strips function and method bodies, keeping only:
   - Class declarations & extends/implements clauses.
   - Method signatures with argument types and return types.
   - Exported constants, types, and interfaces.
3. **Token Reduction:** Reduces code representation tokens by **70% to 85%**, allowing the 4B model to grasp entire multi-file architectures in under 1,500 tokens.

---

### 3.6. Tool Re-anchoring & Autonomous Dispatcher (`src/webview/tools/toolDispatcher.ts`, `src/router/toolReanchor.ts`)

#### Problem:
Small models frequently format tool calls inconsistently (e.g. putting JSON in markdown code fences, malforming argument keys like `args.path` instead of `args.filepath`).

#### Implementation Logic:
1. **Payload Normalization:** `toolDispatcher.ts` normalizes parameter keys across variations:
   - `filepath` $\leftrightarrow$ `filePath` $\leftrightarrow$ `path` $\leftrightarrow$ `paths`
   - `command` $\leftrightarrow$ `cmd` $\leftrightarrow$ `commandLine`
2. **Atomic Surgical Patching:** Prefers line-based or search-and-replace patches (`applyPatch`) over rewriting entire 500-line files.
3. **Re-anchoring Feedback:** When a tool call completes, the output is framed with strict context delimiters:
   ```
   [TOOL_RESULT: runCommand]
   Command: python manage.py check
   Exit Code: 0
   Output: System check identified no issues (0 silenced).
   ```
   This teaches the model in real time that its action succeeded and directs it to the next step.

---

### 3.7. Multimodal Vision Pipeline (UI-to-Code Generation)

#### Problem:
Developers want to pass UI screenshots or designs and have the model reproduce them in HTML/Tailwind/CSS, but local models need dedicated vision alignment.

#### Implementation Logic:
1. **Dual-Model Projection in `llama-server`:**
   By passing `--mmproj mmproj-F16.gguf` alongside the language model (`gemma-4-E4B-it.gguf`), the server initializes a vision encoder (CLIP/SigLIP).
2. **Base64 Inline Packaging:**
   The webview allows image drag-and-drop or clipboard paste. Images are resized to an optimal bounding box ($800\times800$), encoded into base64, and attached to the standard OpenAI-compatible `image_url` message structure.
3. **Design Brain Prompt Directives (`src/utils/designBrain.ts`):**
   When an image is present, the prompt builder activates visual replication rules:
   - Identify primary color palettes, typography, spacing hierarchies, and card borders.
   - Enforce semantic layout tags (`<header>`, `<main>`, `<section>`).
   - Use modern Tailwind CSS / responsive flexbox grids.

### 3.8. Atomic Checkpoint Rollback & Pre-Flight Confirmation System (`src/webview/handlers/messageDispatcher.ts`, `src/state/conversationHistory.ts`)

#### Problem:
If a user issues an accidental command or the AI edits files improperly, typical assistants only clear chat text upon rewinding. The underlying modified files and newly generated code remain on disk, leaving the user with a broken or corrupt workspace.

#### Implementation Logic:
1. **Deterministic File State Capture:**
   During autonomous tool execution in `ToolDispatcher` (`write_file`, `edit_file`):
   - For existing files, the exact pre-edit `utf8` file content is recorded in memory.
   - For newly created files, a tombstone (`content: null`) is recorded.
   - The backup is registered onto the turn's user message timestamp via `conversationHistory.addFileBackup(turnTimestamp, fullPath, oldContent)`.
2. **Pre-Flight Rollback Inspection:**
   When the user clicks the rewind button on a prompt:
   - The extension intercepts the action with `requestRollbackPreview` instead of blindly overwriting disk.
   - It computes the exact file delta:
     - New files: flagged as `DELETE (New File)` with exact line counts (`-N lines`).
     - Modified files: flagged as `REVERT` with before/after line metrics ($N \rightarrow M$ lines).
3. **Interactive Visual Confirmation Modal:**
   A cyber-styled confirmation modal presents the user with:
   - Prompt snippet being rewound.
   - Scrollable list of affected files with red/cyan line delta indicators.
   - Explicit `[Cancel]` vs `[⏪ Yes, Rollback]` actions.
4. **Atomic Disk & Chat Synchronization:**
   Upon user confirmation (`confirmRollbackChat`):
   - Modified files are restored to their exact pre-turn bytes.
   - Newly generated files are unlinked from disk.
   - Any dirty open tabs in VS Code are reverted.
   - Chat history is rewound to the selected timestamp, and the user's prompt text is re-injected into the input box for immediate editing.

---

### 3.9. Production-Grade Full-Duplex Voice Assistant (`src/voice/voiceEngine.ts`, `src/webview/ui.html`, `FULL_DUPLEX_VOICE_ASSISTANT_BLUEPRINT.md`)

#### Architectural Goals:
Real-time, voice-driven coding assistant with conversational interruption (barge-in) and acoustic echo immunity, running seamlessly inside the VS Code environment.

#### Key Mechanics:
1. **Hardware DSP WebRTC Constraints:** Microphone capture enforces native hardware acoustic echo cancellation (`echoCancellation`, `googEchoCancellation`, `noiseSuppression`, `autoGainControl`) via `navigator.mediaDevices.getUserMedia` at 16kHz 16-bit mono PCM.
2. **Dynamic Gating & Echo Shield:**
   - **Idle Threshold:** 0.015 RMS for sensitive user speech capture.
   - **Bot-Speaking Threshold:** Elevates to 0.075 RMS during audio playback to shield against laptop speaker bleed.
3. **Instant Client-Side Barge-In (Interruption):**
   When the AI is speaking over speakers and the user speaks for >= 2 consecutive frames (~500ms), the engine instantly:
   - Aborts bot speech playback (`speechSynthesis.cancel()`, pauses audio elements).
   - Aborts active model generation (`triggerStopGeneration()`, `voiceInterrupt`).
   - Switches the UI into listening mode immediately.
4. **Trailing Silence Detection:** 850ms of silence after detected speech triggers sentence completion and automated query submission (`submitChat()`).
5. **Open-Source Stack Compatibility:** Integrates Web Speech API (zero-latency offline fallback), local Whisper / Groq Whisper STT (`voiceAudioTranscribe`), and Kokoro-82M / Edge-TTS speech synthesis.

---

### 3.10. Web Search Token Optimization & Dual-Layer Citations Engine
1. **Deep Context Extraction (7,000+ Characters per Source):**
   - Extracts comprehensive page content capped at ~7,500 characters per authoritative website.
   - 3 verified sources provide over 22,000 characters of rich technical context, documentation, API signatures, and release details, ensuring maximum accuracy and precision without loss of nuances.
2. **Mandatory Citations Directive:**
   - [src/webview/tools/toolDispatcher.ts](src/webview/tools/toolDispatcher.ts) strictly binds the model to provide industry-standard source citations (`[[1] Title/Domain](URL)`) both inline and in a final `### 🌐 Sources & References` markdown section.
   - Prevents link hallucination by feeding verified, indexed source URLs directly into the tool anchor.
3. **Dual-Layer Interactive UI Citations:**
   - [src/webview/ui.html](src/webview/ui.html) captures all verified sources from `toolCallEvent` and displays sleek, interactive source cards in the search tool block.
   - If the model omits markdown citations in text, the webview automatically appends a dedicated `Verified Sources & Citations` tray below the assistant message with one-click links.
   - All external `http://` and `https://` URLs are routed through VS Code's `vscode.env.openExternal` via `messageDispatcher.ts`, guaranteeing safe and immediate opening in the user's default browser.
4. **Deep Technical Research & Offset Pagination Architecture (`research_web_docs`):**
   - **Max 2 Authoritative Sources:** Discards redundant noise from shallow blogs; focuses exclusively on official GitHub repositories and primary documentation portals.
   - **Unbounded Disk Storage:** Complete, unabridged technical manuals (up to 35,000+ characters) are stored permanently in `.ultra-light-ai/findings/<topic>_research.md` with zero artificial truncation.
   - **Approach 1 Offset Pagination:** Delivers 7,000 to 10,000 characters of high-signal API signatures and working code to the active context. The model can seamlessly read subsequent sections by invoking `research_web_docs(query, offset=...)`, streaming directly from the disk cache with 0ms network latency.

---

### 3.11. Web Brain Bridge: Live Browser AI Pair-Programming (`src/bridge/webBrainBridge.ts`)

#### Architectural Goal:
Empower local 3B–7B models with frontier-level reasoning by connecting directly to live Gemini or ChatGPT Web sessions running in Google Chrome via Chrome DevTools Protocol (CDP).

#### Key Mechanics:
1. **Zero-API-Key Browser Automation:** Attaches to user's existing Chrome instance via CDP (`http://127.0.0.1:9222`). Re-uses active login sessions and subscription tiers without external API token costs.
2. **TrustedHTML & Quill Safe Input:** Interacts with rich-text web editors (Gemini Quill / ProseMirror) via `document.execCommand('insertText')` and safe DOM node synthesis, completely bypassing strict TrustedHTML CSP restrictions.
3. **Targeted DOM Extraction (Zero `Ctrl+A` Contamination):**
   - Avoids full-page selection or clipboard sniffing.
   - Directly indexes and queries the newly spawned assistant response container (`document.querySelectorAll('message-content')[targetIndex]`).
4. **Dynamic 2-Second Generation Settling Engine:**
   - Eliminates premature exit bugs by enforcing text growth tracking.
   - Continuously monitors visible Stop button state (`isStopVisible`) and Send button readiness (`isSendReady`).
   - Automatically completes extraction as soon as the text settles for **2,000ms** with no active Stop button (with a 4-second safety failsafe), delivering instantaneous response turnaround without 4-minute hangs.
5. **Duplicate Call Guard:** `ToolDispatcher` tracks `lastWebBrainPrompt` and consecutive calls. If a local model attempts to re-query Web Brain without executing provided code or commands, the bridge intercepts the duplicate loop and forces file creation.

---

### 3.12. Master-Worker Orchestration & Micro-Step Execution Discipline

#### Philosophy:
- **Gemini Web = The Mastermind (Architect):** High-level decomposition, end-to-end planning, full-stack architectural contracts, and complex error diagnostics.
- **Local 4B Model = The Hands (Executor):** Focuses strictly on mechanical actions (writing one file, running one command, verifying one route).

#### Micro-Step Protocol:
1. **The Anti-Hallucination Barrier:** Small 4B models consistently collapse when given 5–10 file blocks at once.
2. **One-Action-Per-Step Rule:**
   - [src/webview/tools/toolDispatcher.ts](src/webview/tools/toolDispatcher.ts) automatically wraps outbound queries with a strict micro-step directive:
     ```
     [ENVIRONMENT & EXECUTION PROTOCOL FOR GEMINI]:
     - Operating System: Windows (PowerShell)
     - Working Directory: Workspace Root
     - Protocol: Provide strictly ONE micro-step at a time (max 1 file or 1 command).
     ```
   - Gemini outputs only the code for the active step.
   - The local model writes that single file, tests it, and then requests the next step.
3. **Mandatory Action Checklist Synthesizer:**
   When Web Brain returns code, `ToolDispatcher.formatWebBrainGuidance` scans for code blocks and prepends an un-ignorable banner:
   ```markdown
   [WEB BRAIN ACTION CHECKLIST - MANDATORY EXECUTION PROTOCOL]
   REQUIRED FILES TO CREATE / UPDATE:
     1. `write_file` -> "src/components/WatchCard.tsx"
   REQUIRED COMMANDS:
     1. `execute_terminal_command` -> "npm install ..."
   ```

---

### 3.13. Active Plan Grounding (`PLAN.md`) & Priority 15 Injection (`src/webview/sidebarProvider.ts`)

#### Problem:
Local models frequently lose track of multi-step execution plans across turns, declaring tasks "done" after writing only the first step.

#### Implementation Logic:
1. **Automatic Plan Discovery:** `sidebarProvider.buildPrompt` checks for `PLAN.md` or `.ultra-light-ai/PLAN.md` on every single turn.
2. **Priority 15 Injection:**
   The plan is injected at **Priority 15 (Highest Priority)**, ensuring it is never pruned by token budget allocators:
   ```
   [CURRENT WORKSPACE PLAN (PLAN.md)]
   - [x] Step 1: Scaffolding (Done)
   - [ ] Step 2: Database Models & Migrations
   - [ ] Step 3: API Routes

   [MANDATORY EXECUTION DIRECTIVE]:
   1. Find the FIRST unchecked step (- [ ]) in this plan.
   2. Execute ONLY that step right now.
   3. After completing it, mark it (- [x]) in PLAN.md using edit_file.
   ```
3. The local model always knows its exact step and progress without needing to re-read files.

---

### 3.14. Windows PowerShell Sanitization & Terminal Auto-Routing (`src/tools/terminalCapture.ts`)

1. **PowerShell Statement Sanitization:**
   - In Windows PowerShell (5.1 & 7), chaining commands with `&&` causes fatal parse errors (`The token '&&' is not a valid statement separator`).
   - `terminalCapture.ts` intercepts all commands on `win32` and seamlessly transforms `&&` into `; `, ensuring reliable sequential execution.
2. **Extended Timeout for Scaffolding:**
   - Command timeout elevated from 30s to 60s to accommodate heavy package bootstrapping (`npm create vite`, `pip install`, `django-admin`).
3. **Smart Nested CWD Routing:**
   - Detects nested `manage.py` and `package.json` configurations in subfolders and automatically re-routes terminal execution without failing on workspace root.

---

### 3.15. Ollama 32K Native Allocation (`num_ctx: 32768`) & Scaled Step Limits

1. **Ollama Silent Context Truncation Fix (`src/router/realClients.ts`):**
   - By default, Ollama initializes requests with a restrictive **2048-token context** unless explicitly overridden.
   - `realClients.ts` now explicitly injects `options: { num_ctx: 32768 }` into all `/api/chat` requests, unlocking the full 32k window for local 4B/7B models.
2. **Max Autonomous Steps Scaled to 500:**
   - Lifted hardcoded step caps from 100 to **500 autonomous tool steps** across `settingsHandler.ts`, `config.ts`, and `ui.html`, accommodating massive end-to-end full-stack workflows.

---

### 3.16. Web Brain Phase 1 & Phase 2: Deterministic Protocol Parser & Extension Direct Execution

#### Problem:
When delegating complex multi-file full-stack tasks to frontier web models (Gemini / ChatGPT) via the CDP bridge, small local models (4B) suffered from:
1. **Multi-File Collapse:** Small models dropped secondary files when output in bulky Markdown code blocks.
2. **Terminal Chaining & CWD Drift:** PowerShell syntax errors and lost working directories across `cd` sub-processes.
3. **Lazy Placeholders:** Small models writing `// ... existing code ...` or accidentally wiping files.
4. **Daemon Freezes:** Commands like `npm run dev` or `manage.py runserver` freezing the autonomous agent loop.

#### Implementation Architecture:
1. **Strict Line-Anchored Protocol (`src/brain/protocolParser.ts`):**
   - Outbound prompts enforce deterministic markers: `TYPE: FIX`, `MANIFEST`, `===FILE: path===`, `===EDIT: path===`, `===COMMANDS===`, `===VERIFY===`.
   - The parser strips markdown wrapping, validates completion, and extracts atomic files and search/replace blocks.
2. **Deterministic Task Executor (`src/brain/taskExecutor.ts`):**
   - In `extension` write mode, the extension directly applies files, patches edits with multi-strategy search/replace, and executes terminal commands.
   - Eliminates small-model code retyping hallucinations while ensuring 100% of files reach disk.
3. **Safety & Guard Middleware (`src/guards/toolGuards.ts`):**
   - Blocks persistent dev servers (`SERVER_BLOCKED`) and instructs non-blocking validation.
   - Blocks shell redirection writes (`FILE_WRITE_VIA_SHELL`), placeholders (`OVERWRITE_SHRINK`), and path escapes (`PATH_ESCAPE`).
   - Automatically redacts API keys and secrets (`src/security/secretsFilter.ts`) before transmitting outbound prompts to Chrome.
4. **Post-Write In-Memory Syntax Validation (`src/validators/postWriteValidators.ts`):**
   - Validates written files via zero-dependency Python `ast.parse` (stdin) and `JSON.parse`.
   - Immediate feedback prevents cascading syntax errors.
5. **Zero Impact on Normal Flow:**
   - All Phase 1 & 2 guard and execution middleware is gated strictly by `config?.webBrainBridge?.enabled`. When the Web Brain toggle is OFF, the standard 4B local model operates 100% untouched.

---

## 4. Token Budget Allocation Matrix (40k Context Model)

| Component | Target Tokens | Percentage | Description |
|---|---|---|---|
| **System Directives & Rules** | ~1,200 | 3.0% | Core system rules, tool definitions, constraints |
| **Active Skill Checklist** | ~600 | 1.5% | Domain protocols (e.g. Django checklist) |
| **Micro Repo-Map (AST)** | ~1,500 | 3.8% | Structural workspace layout and symbol index |
| **Session Memory** | ~800 | 2.0% | Visited files and cached symbol exports |
| **Conversation History** | ~12,000 | 30.0% | Multi-turn chat with sliding window truncation |
| **Active Task / Tool Buffer** | ~16,000 | 40.0% | Tool inputs, stdout captures, and file contents |
| **Model Generation Reserve** | ~8,000 | 19.7% | Output headroom for reasoning, code, and tool calls |
| **TOTAL** | **~40,100** | **100%** | **Perfect Fit for 40,000 Token Context Window** |

---

## 5. Summary of Key Files & Responsibilities

| File Path | Primary Responsibility |
|---|---|
| [src/bridge/webBrainBridge.ts](src/bridge/webBrainBridge.ts) | Chrome CDP browser automation, Gemini/ChatGPT Web integration, 2s settled detection |
| [src/brain/protocolParser.ts](src/brain/protocolParser.ts) | Line-anchored protocol parser for `===FILE===` and `===EDIT===` grammar |
| [src/brain/taskExecutor.ts](src/brain/taskExecutor.ts) | Extension direct execution of files, edits, and terminal commands |
| [src/brain/editApplier.ts](src/brain/editApplier.ts) | Multi-strategy search/replace fuzzy patch engine |
| [src/guards/toolGuards.ts](src/guards/toolGuards.ts) | Safety invariants blocking server freezes, file shrinks, placeholders, and path escapes |
| [src/security/secretsFilter.ts](src/security/secretsFilter.ts) | Outbound prompt redaction for API keys, tokens, JWTs, and private keys |
| [src/platform/commandSequence.ts](src/platform/commandSequence.ts) | Sequential command runner with in-process `cd` tracking and output bounds |
| [src/validators/postWriteValidators.ts](src/validators/postWriteValidators.ts) | In-memory syntax validation (Python AST via stdin, JSON parse, CSS balance) |
| [src/features/skillsManager.ts](src/features/skillsManager.ts) | Skill discovery, trigger matching, conflict resolution, built-in suppression |
| [src/state/sessionMemory.ts](src/state/sessionMemory.ts) | Anti-reread cache, symbol extraction, session footprint management |
| [src/state/conversationHistory.ts](src/state/conversationHistory.ts) | Message persistence, sliding window pruning, turn execution records |
| [src/tools/terminalCapture.ts](src/tools/terminalCapture.ts) | Command execution, PowerShell `&&` sanitization, framework CWD routing |
| [src/webview/sidebarProvider.ts](src/webview/sidebarProvider.ts) | Webview bridge, PLAN.md Priority 15 auto-injection, autonomous step loop |
| [src/webview/tools/toolDispatcher.ts](src/webview/tools/toolDispatcher.ts) | Tool dispatching, Web Brain protocol synthesis and direct execution wiring |
| [src/webview/ui.html](src/webview/ui.html) | Glassmorphic UI, Web Brain quick toggle, full-duplex voice HUD, 500-step settings |

---

*Authored for the Vakra AI development team. Maintained for continuous performance optimization on edge-grade local models.*
