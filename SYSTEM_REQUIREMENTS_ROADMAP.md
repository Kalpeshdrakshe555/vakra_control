# 🚀 Ultra Light AI — System Upgrade & Master Requirements Specification

Yeh document humare project ke saare active core issues, architecture improvements, aur next-gen Copilot features ka single source of truth hai. Purane solved problems archive kar diye gaye hain taaki document active priorities par focused rahe.

---

## 🏆 Resolved & Verified Milestones (Archive Summary)

| # | Milestone | Status | Key Deliverable |
|---|---|---|---|
| 1 | **Gaming Mode Complete Removal** | ✅ Verified | `gameRunnerPanel.ts`, casual HTML runners, commands, and assets completely purged. |
| 2 | **Professional Prompts Overhaul** | ✅ Verified | Model-agnostic system prompt with strict output protocols, search/replace anchors, zero-hallucination rules, and structured Architect flow. |
| 3 | **Multi-Tier Robust Diff Patcher** | ✅ Verified | 5-tier matching (Exact, Normalized, Anchor, Fuzzy Levenshtein, AST fallback, Scout healer) with zero silent appending. |
| 4 | **True File Rewind & Rollback** | ✅ Verified | Dual-layer disk and buffer state reversion (`fs.unlinkSync` for new files, snapshot restoration for edits). |
| 5 | **Collapsible Thinking Stream** | ✅ Verified | `<details class="thinking-accordion">` dropdown with live `<think>` stream handling. |
| 6 | **Context Mentions & Diagnostics** | ✅ Verified | `@file`, `@terminal`, `@git` input injections and `ultra-light-ai.autoFixDiagnostics` active. |
| 7 | **Dynamic Workspace Switching & Security** | ✅ Verified | `onDidChangeWorkspaceFolders` dynamic reload, OS Keychain `context.secrets` storage. |

---

## 📌 Phase 1: Top Priority Active Sprint (UI, Terminal & Polish)

### 1. Summary-First Streaming & Clean File Edit UX (Hide Raw Code Clutter) — [VERIFIED ✅]
- **Current Problem**:
  - Model chat stream me bada raw code dump kar deta hai jisse chat messy aur unprofessional lagti hai.
  - User chahta hai ki model kya kar raha hai iski concise **summary information / status** front-end par dikhe (e.g. *"Analyzing bug in auth logic..."*, *"Editing `src/auth.ts` to add token refresh..."*), jabki code generation background/backend me process ho.
  - Edit complete hone ke baad UI me clean, high-fidelity **Verify Diff & Apply** card trigger hona chahiye bina layout breakdown ya double-rendering ke.
- **Action Items**:
  - **Live Action Status Chips**: AI generation ke dauran live status banner dikhaye (e.g. `⚡ Editing src/controllers/userController.ts...`).
  - **Code Payload Stream Virtualization / Drawer**: Code blocks chat bubble ko flood karne ke bajay sleek collapsible artifact card me direct stream hon.
  - **Verification Card**: Edit complete hone par `[ 👁️ Verify Diff ]`, `[ ⚡ Apply Changes ]`, aur `[ ✕ Reject ]` buttons prominently render hon with clear visual feedback.

### 2. Reliable Terminal Execution & Self-Healing Loop — [VERIFIED ✅]
- **Current Problem**:
  - Model terminal commands ka sahi se istemaal nahi kar raha hai (bash commands execute nahi hoti ya markdown me dab ke reh jaati hain).
  - Model ko pata nahi chalta ki command ka output ya error kya aaya, jisse autonomous debugging fail hoti hai.
- **Action Items**:
  - **Universal Terminal Command Interceptor**: AI chahe `execute_terminal_command` tool call kare ya markdown me ````bash` block de, UI automatically ek interactive **Terminal Execution Card** render kare.
  - **Interactive Review & 1-Click Run**:
    - Editable command box.
    - `[ ▶ Run in Terminal ]`: VS Code integrated terminal me bhejta hai.
    - `[ ▶ Run & Read Output ]`: Command execute karke stdout/stderr capture karta hai.
  - **Self-Healing Loop**: Output capture hote hi agar exit code non-zero ho, toh auto-diagnostic context model ko feed ho taaki wo error ko bina user intervention ke fix kar sake.

### 3. Premium UI Aesthetics & Hidden UI Bug Fixes — [VERIFIED ✅]
- **Current Problem**:
  - Current UI basic lag raha hai, modern Copilot / Cursor jaisa sleek, premium feel missing hai.
  - Hidden bugs: Streaming ke time text jump/flicker, status badges overflow, copy button glitches, aur button state synchronization issues.
- **Action Items**:
  - **Premium Dark Aesthetics**:
    - Modern glassmorphism (`backdrop-filter: blur(12px)`), refined dark palette (`#0d1117`, `#161b22`, subtle `#30363d` borders).
    - Polished glowing status accents, sleek micro-animations for hover and focus states.
  - **Layout & Stream Stability**:
    - Stream message rendering me DOM thrashing prevent karna.
    - Message action icons (Copy, Edit, Delete, Rollback) ko clean floating bar me convert karna.
  - **Component Quality**:
    - File cards, terminal cards, aur thinking accordions ka unified design system.

---

## 🚨 Evening Sprint: Immediate Fixes for Reported Bugs [ACTIVE 🔴]

### Issue 1: Raw HTML Tag Leak in Chat Body — [VERIFIED ✅]
- **Status**: Fixed via DOM Placeholder Pipeline (`renderMarkdownWithCustomWidgets`). Markdown parsing is completely isolated from custom widgets, preventing raw tags from escaping.

### Issue 2: Blind Hallucinated File Reads Without Prior Planning — [VERIFIED ✅]
- **Status**: Fixed. Prompt enforces directory verification before any file reads, forbidding made-up paths.

### Issue 3: Missing Human Communication / Intent Transparency — [VERIFIED ✅]
- **Status**: Fixed. Intent transparency rule requires model to state its reason in 1-2 conversational sentences before calling tools.

### Issue 4: Word-by-Word Streaming Stalled / Not Progressively Visible — [VERIFIED ✅]
- **Status**: Fixed. Continuous streaming (`stream: stream`) enabled across all tool iterations in `LocalOllamaClient` and `GeminiCloudClient`.

### Issue 5: Architect Mode Premature Code Dumping & Scaffold Desynchronization — [VERIFIED ✅]
- **Status**: Fixed. Implemented Turn 1 Hard Stop (Scaffolding only in Turn 1, no application code files until scaffolding is confirmed).

### Issue 6: UI Markdown Tag Collisions & Stray "COPY" Injections — [VERIFIED ✅]
- **Status**: Fixed. Injected custom widgets after markdown parsing; prevented copy button injection into thinking accordion and drawer payloads.

### Issue 7: Tri-Choice Terminal Permission UX (Frictionless Automation) — [VERIFIED ✅]
- **Status**: Fixed. Interactive Tri-Choice card (`Allow for Now`, `Skip`, `Allow All for Session`) with `⚡ Apply Selection` button.

### Issue 8: Closed-Loop Execution (Verify & Execute — Anti-Blind Loop) — [VERIFIED ✅]
- **Status**: Fixed & Fully Closed-Loop.
  - Interactive Tri-Choice card emits with unique `callId`; pauses tool execution using an asynchronous `Promise`.
  - When user selects `Allow for Now`, `Skip`, or `Allow All for Session`, `resolveTerminalApproval` executes via `TerminalCapture.runAndCapture`, formats exit code + last 15 lines of stdout/stderr, and resolves the tool promise directly into the LLM context.
  - In `LocalOllamaClient` and `GeminiCloudClient`, added `extractTextToolCalls` parser to intercept and execute text-formatted tool calls like `search_web(...)` and `execute_terminal_command(...)`, eliminating plaintext tool command leakage.
  - Enabled **Single Brain Auto-Healer**: When `supportBrain` is absent, `mainBrain` automatically kicks in to repair slightly mismatched SEARCH blocks.
  - Updated `extractFiles` in `ui.html` and 1-shot SEARCH/REPLACE prompt in `promptBuilder.ts` with explicit `<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE` syntax.

### Issue 9: Interactive Architectural Discovery (Clarification Questions First)
- **Problem**: Complex project request aate hi model direct blind assumptions le kar blueprint banane lagta hai, jisse wrong libraries ya unwanted templates generate ho jaate hain.
- **Solution Architecture**:
  - Architect Mode me model blueprint se pehle 2-3 focused clarification questions puchega (e.g. Database preference, authentication type, styling framework).
  - User ke answers confirm hone ke baad hi step-by-step verified development plan shuru karega.

### Issue 10: Dynamic Temperature & Behavior Controls in Settings
- **Problem**: Model ka temperature `realClients.ts` me `0.7` hardcoded hai. Coding aur search/replace diffs ke liye ye bohot high hai, jisse hallucination aur anchor mismatch hota hai.
- **Solution Architecture**:
  - Extension settings panel me interactive **Temperature Slider (`0.0` se `1.0`)** aur **Behavior Presets Dropdown**:
    - `🎯 Strict Coder (0.1)`: Bug fixes, Search/Replace diffs, deterministic syntax (Zero hallucinations).
    - `⚖️ Balanced Assistant (0.4)`: General explanations, refactoring, Q&A.
    - `🎨 Creative Architect (0.7)`: UI design, naming ideas, architectural brainstorming.
  - Value `config.json` me save hogi aur direct LLM API request payload me pass hogi.

### Issue 11: Experiential Memory & Self-Learning Agent Loop (Hermes-Style Reflection)
- **Problem**: Har naye session me model blank rehta hai aur wahi puraane mistakes ya wrong library versions dohrata hai jo user pehle bhi theek kar chuka hota hai.
- **Solution Architecture**:
  - **Self-Correction & Lesson Extractor**: Jab bhi user model ko correct kare ya error solve ho, model background me ek concise lesson extract karega:
    `Mistake -> Solution / Project Convention`.
  - **Persistent Local Vault**: Lessons `.ultra-light-ai/memory/learned_lessons.md` me structured format me save honge.
  - **Dynamic Context Injection**: Agle sessions me user prompt ke matching keywords detect karke relevant lessons `promptBuilder.ts` ke through inject honge taaki model kabhi wahi galti dobara na kare.

---

## 📌 Phase 2: Autonomous Researcher Sub-Agent & Essential Tools Suite

### 4. Deep Doc Researcher Sub-Agent (`research_web_docs`) — [VERIFIED ✅]
- **Goal**: Internet se real-time official documentation, API references, aur code examples autonomously fetch karke clean `.md` files me store karna taaki main model outdated training cutoff ki wajah se kabhi hallucinate na kare.
- **Dual-Brain Allocation**:
  - **Scout Model Priority**: Agar `scoutBrain` (Cloud 31B / Fast API model) configured hai, toh research task Scout model ko delegate hoga (super fast, high intelligence, saving local token budget).
  - **Fallback**: Agar Scout configured nahi hai, toh regular primary model as researcher act karega.
- **Workflow**:
  1. Main agent prompt me tool trigger karta hai: `research_web_docs(query="Next.js 15 Server Actions params", urls=[...])`.
  2. Sub-agent background me multiple targeted URLs scrape karta hai.
  3. HTML boilerplate (scripts, ads, navbars, tracking code) filter karke pure Markdown me format karta hai.
  4. Output file `.ultra-light-ai/research/<sanitized-topic>.md` me save hoti hai.
  5. Main agent ko sirf ek concise **150-Token Executive Summary + Table of Contents + File Link** di jaati hai.
  6. Main agent bina token explode kiye wahi exact documentation read karke accurate code likhta hai.

### 5. Essential Agent Tools Suite — [VERIFIED ✅]
Top-tier coding agents ki tarah main agent ke context aur execution power ko complete karne ke liye 4 essential tools add honge:
- **`list_directory_tree` (Directory Explorer)**:
  - Workspace ya specific subfolder ka clean visual tree structure (`depth` limit ke sath) return karta hai taaki AI blind guess na kare.
- **`get_code_diagnostics` (LSP Compiler & Linter Check)**:
  - VS Code language server se target file ke active red squiggles, compiler errors, aur warnings fetch karta hai (`vscode.languages.getDiagnostics`). Code edit ke turant baad AI bina terminal run kiye syntax errors detect kar sakta hai.
- **`get_symbol_outline` (AST Outline Inspector)**:
  - Poori 1000 lines ki file read kiye bina us file ke saare Classes, Methods, Functions, aur Interfaces ki hierarchy return karta hai (Zero token waste navigation).
- **`check_localhost_health` (Dev Server Health Ping)**:
  - AI dev command run karne ke baad `http://localhost:<port>` ko ping karke check karta hai ki server sach me live hua ya port clash/crash ho gaya.

---

## 📌 Phase 3: Core Architecture & Accuracy Engine

### 6. Speculative Refiner Pipeline (4B Local Draft + 31B Cloud Scout Validator) — [ACTIVE 🔴]
- **Goal**: Unlimited daily development usage with high accuracy and zero API quota exhaustion.
- **Workflow**:
  - **Draft Execution (4B Local Model)**: Local model free me initial code files aur diffs generate karta hai.
  - **Refiner Pass (31B Cloud Scout)**: Chhota payload (Draft Code + Target File Snippet + 150 token rule) Scout ko jata hai:
    - Code syntax errors verify karta hai.
    - Exact `SEARCH/REPLACE` anchors align karta hai taaki diff patch 100% succeed ho.
  - **Budget Safe**: Har edit par sirf 400-800 tokens consume honge (14k RPD / 16k TPS limit me safe).

### 7. Next-Gen Codebase Relationship Map (AST Call Hierarchy Graph) — [ACTIVE 🔴]
- **Goal**: Heavy full-file reading ke bajay lightweight AST Symbol Graph banana taaki cross-file relations model ko instantly milein.
- **Action Items**:
  - Background indexing me Class, Interface, Function signatures aur Import/Export call graph store karna.
  - Full 1000-line files context me dump karne ke bajay sirf relevant signatures aur dependencies bhejna. Token consumption 80% drop hoga.

---

## 📌 Phase 4: Extensibility, Custom Skills & MCP Ecosystem

### 8. Custom Agent Skills System (Claude Skills-Style Workflows) — [FOUNDATION VERIFIED ✅]
- **Goal**: User apne custom coding workflows aur domain-specific rules create kar sake.
- **Architecture**:
  - Directory: `.ultra-light-ai/skills/<skill-name>/SKILL.md` (with YAML frontmatter: `name`, `description`, `trigger_rules`).
  - Tech stack ya keywords match hone par on-demand load hoga (Zero token waste).
  - Default `code-reviewer` skill shipped under `.ultra-light-ai/skills/code-reviewer/SKILL.md`.

### 9. Model Context Protocol (MCP) Standard Client Integration — [PLANNED 🟡]
- **Goal**: Anthropic open-source MCP protocol ke through local/remote MCP servers (SQLite, GitHub, PostgreSQL, Filesystem, Puppeteer) se connect hona.
- **Config**: `.ultra-light-ai/mcp_config.json`.
- **Status**: Config loader ready, MCP StdioClient transport integration pending.

### 10. Extensible Plugin & Tooling Architecture — [PLANNED 🟡]
- **Goal**: Third-party plugins (Gmail, Slack, Jira, Custom APIs) `.ultra-light-ai/plugins/` directory se auto-load hona.

---

## 🎯 Implementation Priority Order
1. **Milestone 1 (UI Top Priority)**: Summary-First Streaming & Clean File Edit Cards — [COMPLETED & VERIFIED ✅]
2. **Milestone 2 (Terminal)**: Reliable Terminal Execution Bridge & Self-Healing Loop — [COMPLETED & VERIFIED ✅]
3. **Milestone 3 (UI Polish)**: Premium Glassmorphic Aesthetics & Hidden UI Bug Fixes — [COMPLETED & VERIFIED ✅]
4. **Milestone 4 (Intelligence)**: Autonomous Doc Researcher Sub-Agent (`research_web_docs`) — [COMPLETED & VERIFIED ✅]
5. **Milestone 5 (Tools)**: Essential Agent Tools Suite (`list_directory_tree`, `get_code_diagnostics`, `get_symbol_outline`, `check_localhost_health`) — [COMPLETED & VERIFIED ✅]
6. **Milestone 6 (Skills)**: Custom Skills Engine (`.ultra-light-ai/skills/`) — [COMPLETED & VERIFIED ✅]
7. **Milestone 7 (Refiner)**: Speculative Refiner Pipeline (4B Local + 31B Scout Validator) — [NEXT 🔴]
8. **Milestone 8 (Code Graph)**: Next-Gen Codebase Relationship Map (AST Call Hierarchy) — [NEXT 🔴]
9. **Milestone 9 (Extensibility)**: Full MCP Stdio Protocol Client Integration — [NEXT 🔴]
