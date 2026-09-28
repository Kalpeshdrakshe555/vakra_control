# Ultra Light AI (Vakra Control) — Comprehensive Bird's Eye Architecture Document

> **Repository:** `vakra_control`  
> **Type:** VS Code Extension (AI Coding Assistant & Autonomous Agent)  
> **Engine Compatibility:** Dual-Brain (Cloud Gemini API & Local OpenAI/Ollama/llama.cpp Server)

---

## 1. Executive Summary & Purpose

**Ultra Light AI** is a full-featured, Copilot-style AI coding assistant and autonomous developer agent built as a native VS Code extension. 

The extension is designed around a **Dual-Brain Architecture**:
- **Main Brain (Executor)**: Handles core code generation, multi-turn conversational chat, complex planning, and workspace file modifications. Supports Google Gemini Cloud API and Local/OpenAI-compatible endpoints (Ollama, LM Studio, `llama-server.exe`).
- **Support Brain (Scout)**: Handles background lightweight micro-tasks, automatic session summarization, project onboarding analysis, and SEARCH/REPLACE block validation.

---

## 2. High-Level Architecture Diagram

```mermaid
graph TD
    subgraph VS Code Environment
        Editor[Active Text Editor]
        Terminal[VS Code Terminal]
        StatusBar[Status Bar Item]
        ExtHost[Extension Host (extension.ts)]
    end

    subgraph Webview Layer (Cyberpunk UI)
        UI[Webview Panel (ui.html)]
        Sidebar[SidebarProvider.ts]
        PromptBuild[PromptBuilder.ts]
        Settings[SettingsHandler.ts]
    end

    subgraph Router & Engine Layer
        Router[EngineRouter]
        Gemini[GeminiCloudClient]
        Local[LocalOllamaClient]
    end

    subgraph Intelligence & Context Services
        RAG[RAG Engine (BM25 + CodeChunker)]
        ProjectScan[ProjectScanner]
        TokenBudget[TokenBudget & Accountant]
        Classifier[PromptClassifier]
        SessionMem[SessionMemory & StateMachine]
    end

    subgraph Execution & Operations
        DiffPatch[DiffPatcher]
        Versioning[FileVersioning / Snapshots]
        TermCap[TerminalCapture]
        Tools[ToolRegistry]
    end

    UI <-->|postMessage| Sidebar
    Sidebar --> PromptBuild
    PromptBuild --> TokenBudget
    PromptBuild --> RAG
    Sidebar --> Router
    Router --> Gemini
    Router --> Local
    Sidebar --> DiffPatch
    DiffPatch --> Versioning
    DiffPatch --> Editor
    Sidebar --> TermCap
    TermCap --> Terminal
    ExtHost --> Sidebar
    ExtHost --> RAG
```

---

## 3. Directory & Component Breakdown

```
vakra_control/
├── package.json              # Extension manifest, commands, menus, keybindings, settings schema
├── tsconfig.json             # TypeScript compiler configuration
├── esbuild.js                # Fast bundler script for compiling extension.ts
├── src/
│   ├── extension.ts          # Main activation entry point & global event listeners
│   ├── config.ts             # Configuration loader (.ultra-light-ai / .env / defaults)
│   ├── features/             # Standalone interactive features
│   │   ├── skeletonExpander.ts   # Expands function/class outlines into full code
│   │   ├── smartSearch.ts        # Semantic code search palette (QuickPick)
│   │   └── terminalInterceptor.ts# Listens for terminal errors to suggest AI fixes
│   ├── indexer/
│   │   └── projectScanner.ts # Detects project frameworks, build/test commands, and tech stack
│   ├── operations/
│   │   ├── diffPatcher.ts    # Parses and applies SEARCH/REPLACE diff blocks and full files
│   │   ├── diffValidator.ts  # Validates syntax and AST integrity before patching
│   │   └── fileVersioning.ts # Snapshots modified files into .ultra-light-ai/snapshots/
│   ├── providers/            # Native VS Code language providers
│   │   ├── codeActionProvider.ts    # Quick Fix, Refactor, and Generate Docs
│   │   ├── hoverProvider.ts         # AI explanations on mouse hover
│   │   └── inlineCompletionProvider.ts # Copilot-style ghost text completion
│   ├── rag/                  # Local semantic code retrieval
│   │   ├── bm25.ts           # Pure TypeScript BM25 ranking algorithm
│   │   ├── codeIndexer.ts    # AST/Regex-based code chunker (classes, functions, blocks)
│   │   └── ragEngine.ts      # Workspace file scanner, BM25 indexing, and search
│   ├── router/               # LLM abstraction layer
│   │   ├── IEngine.ts        # Common interface for LLM clients
│   │   ├── engineRouter.ts   # Failover & fallback routing between models
│   │   └── realClients.ts    # GeminiCloudClient & LocalOllamaClient implementations
│   ├── state/                # Multi-turn memory & conversation persistence
│   │   ├── conversationHistory.ts # Chat history, session tracking, serialization
│   │   ├── sessionMemory.ts       # Rolling log of AI decisions and applied files
│   │   ├── stateMachine.ts        # Persistent state (.ai_state.json)
│   │   └── taskPlanner.ts         # Detects complex multi-step user prompts
│   ├── tools/                # Autonomous agent tool executions
│   │   ├── scraper.ts        # Web search & web scraper tools
│   │   ├── terminalCapture.ts# Child-process execution and stdout/stderr capture
│   │   └── toolRegistry.ts   # Extensible plugin system for custom workspace tools
│   ├── utils/                # Heuristics, classifiers, and budget helpers
│   │   ├── astSkeletonizer.ts     # Extracts outlines using VS Code document symbols
│   │   ├── contextSelector.ts     # Heuristic relevance filtering for files
│   │   ├── dependencyGraph.ts     # Dependency tree mapping
│   │   ├── designBrain.ts         # Deterministic UI/UX design blueprints & color themes
│   │   ├── errorDiagnoser.ts      # Error log parsing and categorization
│   │   ├── frameworkConventions.ts# Best practice guidelines per framework
│   │   ├── promptClassifier.ts    # Classifies prompts (UI vs Backend vs Info)
│   │   ├── queryCache.ts          # Cache for recurring AI responses
│   │   ├── terminalHeuristics.ts  # Surgical context extraction from terminal traces
│   │   └── tokenBudget.ts         # Character-to-token estimator and budget allocator
│   └── webview/              # Sidebar Chat & Visual Experience
│       ├── gameRunnerPanel.ts# Webview iframe runner for generated HTML games/apps
│       ├── input.css         # Tailwind source styles
│       ├── promptBuilder.ts  # System instruction assembler & guardrail enforcer
│       ├── settingsHandler.ts# Global & local settings persistence handler
│       ├── sidebarProvider.ts# Primary UI event orchestrator (1900+ lines)
│       └── ui.html           # Single-page UI with chat, settings modal, history
```

---

## 4. Deep-Dive: Core Subsystems

### 4.1 LLM Client & Router Subsystem (`src/router/`)
- **`IEngine`**: Common contract defining `complete()`, `completeStream()`, and multi-turn methods with tool-calling capabilities.
- **`GeminiCloudClient`**: 
  - Connects to `https://generativelanguage.googleapis.com/v1beta/models/`.
  - Supports multiple API keys with automatic failover rotation on HTTP 429/403/500 errors.
  - Implements SSE (Server-Sent Events) streaming via `streamGenerateContent?alt=sse`.
  - Supports native Gemini function calling (`tools` array).
- **`LocalOllamaClient`**:
  - Connects to local endpoints (`http://127.0.0.1:11434` or custom ports like `http://127.0.0.1:8083`).
  - Automatic protocol detection: If port contains `11434`, uses Ollama `/api/chat`. Otherwise, formats requests as standard OpenAI `/v1/chat/completions`.
  - Handles streaming via OpenAI-compatible `data: {"choices":[{"delta":{...}}]}` chunks.
  - Converts Gemini tool declarations to OpenAI-compatible `function` tool definitions.

---

### 4.2 Webview UI & Sidebar Subsystem (`src/webview/`)
- **Visual Design**: Cyberpunk dark-mode theme built with Tailwind CSS, custom glow effects, neon cyan/pink accents, and mono fonts.
- **`SidebarProvider`**:
  - Acts as the central mediator between VS Code API and the webview DOM.
  - Intercepts user messages, manages conversation sessions, streams tokens, handles undo/rollback, and coordinates tool execution loops.
- **`PromptBuilder`**:
  - Dynamically synthesizes the system prompt based on active modes:
    - **Normal Chat Mode**: Direct responses, code completions, and debugging.
    - **Architect Mode**: Mandates plan-first execution (Step 1 Plan -> Step 2 Scaffold -> Step 3 Pause for user approval -> Step 4 Modular execution).
    - **UI/Design Mode**: Automatically injects color theory, responsive layouts, 3D CSS transforms, and SVG asset rules.
- **`SettingsHandler`**:
  - Implements dual-level persistence: Saves globally in `~/.ultra-light-ai/config.json` (to prevent GitHub key leaks) and locally in `.ultra-light-ai/workspace-config.json` for per-project overrides.

---

### 4.3 Code Patching & Diff Subsystem (`src/operations/`)
- **SEARCH/REPLACE Format**:
  Uses Aider-compatible diff tags:
  ```
  <<<<<<< SEARCH
  existing code to be replaced
  =======
  new replacement code
  >>>>>>> REPLACE
  ```
- **5-Tier Leniency Engine (`applyRobustSearchReplace`)**:
  1. **Tier 1 — Exact Match**: Direct string match.
  2. **Tier 2 — Trimmed Line Match**: Ignores trailing whitespace differences.
  3. **Tier 3 — Normalized Indentation**: Normalizes tabs and spaces.
  4. **Tier 4 — Fuzzy Levenshtein / Similarity**: Matches code blocks with minor formatting deviations.
  5. **Tier 5 — Context Anchor Matching**: Uses top and bottom anchor lines to isolate the replacement window.
- **Safety Circuit Breaker**:
  - Prevents accidental full-file wipes: If the AI emits a replacement block smaller than 50% of the original file without SEARCH/REPLACE tags, user confirmation is required.
  - Auto-Rollback: Integrates with `TerminalCapture` to run test/build commands after patching. If the build fails, files are restored to the snapshot automatically.

---

### 4.4 RAG (Retrieval-Augmented Generation) & Indexing (`src/rag/`)
- **File Ingestion**: Scans workspace files (excluding `node_modules`, `.git`, `dist`, `.venv`, etc.).
- **Code Chunker (`codeIndexer.ts`)**: Slices code into semantic units (functions, classes, blocks) with metadata (filepath, startLine, endLine, importanceScore).
- **BM25 Algorithm (`bm25.ts`)**:
  - Inverted index with term-frequency / inverse-document-frequency scoring.
  - Query expansion using a programming synonym dictionary (e.g., `login` -> `auth`, `token`, `session`).
  - Cached persistently to `.ultra-light-ai/rag-index.json`.

---

### 4.5 State Management & Memory (`src/state/`)
- **`ConversationHistory`**: Maintains multi-session chat states, token estimates, and turn rollbacks.
- **`SessionMemory`**: A short-term persistent log of architectural decisions and applied file summaries, auto-injected into long chats to eliminate model amnesia.
- **`FileVersioning`**: Maintains rolling timestamped snapshots in `.ultra-light-ai/snapshots/` for one-click file undo.

---

## 5. End-to-End Request Lifecycle

```
[User Types Prompt in Webview]
               │
               ▼
[classifyPrompt] -> Identifies category (UI / Backend / Info)
               │
               ▼
[TokenAccountant & RAG Search] -> Fetches top relevant code chunks within token budget
               │
               ▼
[PromptBuilder] -> Constructs System Prompt + History + Injected Context + User Prompt
               │
               ▼
[Engine Router] -> Routes to GeminiCloudClient or LocalOllamaClient
               │
               ▼
[Streaming Response] -> SSE chunks streamed token-by-token to Webview
               │
       ┌───────┴───────┐
       ▼               ▼
[Text / Explanations]  [Action Blocks / Files / Diff Blocks]
       │               │
  Render Markdown      ├─► User clicks "Apply to File" ──► DiffPatcher ──► WorkspaceEdit
                       └─► User clicks "Run Command"   ──► VS Code Terminal
```

---

## 6. Storage & Metadata Hierarchy

All extension-generated files and configurations reside in structured paths:

| Path | Purpose | Scope |
|---|---|---|
| `~/.ultra-light-ai/config.json` | Global settings, Gemini API keys, Local endpoints | Global (All workspaces) |
| `.ultra-light-ai/workspace-config.json` | Project-specific model and provider overrides | Local Workspace |
| `.ultra-light-ai/ARCHITECTURE.md` | Auto-generated project architecture & file log | Local Workspace |
| `.ultra-light-ai/rag-index.json` | Cached BM25 token index for instant RAG startup | Local Workspace |
| `.ultra-light-ai/snapshots/` | Time-stamped backups for atomic rollback & undo | Local Workspace |
| `.ultra-light-ai/session_memory.json` | Long-term memory of recent changes & decisions | Local Workspace |
| `.ultra-light-ai/project-profile.json` | Auto-detected project frameworks & build commands | Local Workspace |

---

## 7. Technology Stack Summary

- **Runtime**: Node.js (`>=18.0.0`), VS Code Extension API (`^1.85.0`)
- **Language**: TypeScript (`^5.3.3`)
- **Build System**: `esbuild` for TypeScript bundling, `tailwindcss` for styling
- **Frontend Assets**: Custom HTML5 Webview, `marked.js` (Markdown parsing), `highlight.js` (Syntax highlighting)
- **Local AI Target**: OpenAI-compatible REST API (Ollama, LM Studio, `llama-server.exe` / llama.cpp)
- **Cloud AI Target**: Google Gemini API (`v1beta` models)
