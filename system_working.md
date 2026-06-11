# Ultra Light AI - System Working Documentation

This document provides a comprehensive technical overview of the Ultra Light AI extension. It breaks down the internal architecture, logical flows, and feature implementations to aid in future enhancements and debugging.

## 1. Dual-Brain Architecture (The Core Engine)
The system utilizes a "Scout & Sniper" pattern to maximize context awareness while minimizing token usage and API costs.

### A. Main Executor Brain (Brain 1)
- **Role:** Generates highly accurate code, performs logic reasoning, and executes the final response to the user.
- **Typical Model:** Large, high-parameter models (e.g., Gemini 1.5 Pro, Claude 3.5 Sonnet).
- **Tool Access:** Has full access to all workspace editing tools (`replace_symbol`, etc.).

### B. Support Scout Brain (Brain 2)
- **Role:** Acts as an ultra-fast background researcher. It explores the workspace, reads files, and fetches context.
- **Typical Model:** Small, fast, cheap models (e.g., Llama 3.1 8B on Groq).
- **Tool Access:** Restricted to *Read-Only* tools (`read_multiple_files`, `search_codebase`, `find_references`). It cannot modify code, ensuring zero corruption.

### C. The `DualEngineRouter` (`src/router/dualEngineRouter.ts`)
When **Advanced Mode** is active, chat streams pass through the `DualEngineRouter`:
1. The router pauses the main executor.
2. It prompts the **Scout Brain** with the user's message and gives it access to read/search tools.
3. The Scout uses tools to find relevant code snippets.
4. The router collects the Scout's output into a `<scout_context>` XML block.
5. The router appends this `<scout_context>` to the user's original prompt and sends the enriched prompt to the **Main Executor**.

## 2. Background AST Indexing & Architecture File (`src/indexer/backgroundIndexer.ts`)
To prevent the model from losing context in long chats, the system maintains a persistent memory file: `ARCHITECTURE.md`.

### Initialization
When the extension activates (`extension.ts`), it instantiates `globalBackgroundIndexer`.
1. **Startup Check:** It checks if `ARCHITECTURE.md` exists in the workspace root.
2. **Auto-Generation:** If missing, it waits 10 seconds (allowing BM25 to index), reads the folder structure, and uses the **Support Scout** to generate an initial `ARCHITECTURE.md`.

### Autonomous Updating
1. **File Watcher Hook:** Every time a user (or the AI) saves a code file (`.ts`, `.py`, etc.), the path is logged.
2. **Debounce Timer:** To prevent API spam, the indexer waits for 30 seconds of inactivity.
3. **Background Update:** The **Support Scout** is silently spun up in the background. It is fed the recently changed files and the old `ARCHITECTURE.md`.
4. **Self-Healing Memory:** The Scout rewrites/updates the `ARCHITECTURE.md` to reflect the new state. This ensures the memory is always up-to-date without user intervention.

## 3. RAG & Search Engine (`src/rag/ragEngine.ts`)
- **Offline Capable:** The RAG system does not use expensive cloud Vector Databases. It uses a custom **BM25 algorithm**.
- **Chunking:** Files are split into code chunks (functions/classes).
- **Tool Integration:** The `search_codebase` tool allows the AI to perform semantic searches directly against this local index.

## 4. Prompt Injection Logic (`src/webview/sidebarProvider.ts`)
Regardless of the active mode (Chat, Architect, or Advanced), the system always injects context to ensure accuracy:
1. `ARCHITECTURE.md` (if exists) is read and injected inside `<project_architecture>` tags at the top of the prompt.
2. The UI sends a `statusUpdate` showing exactly how many previous messages are being sent (e.g., "Context Window: Sending previous 12 messages...").
3. **Architect Mode:** If enabled, the system prompt is strictly modified to output *only* scaffolding CLI commands first, and then step-by-step file modifications to prevent token explosion on massive projects.

## 5. UI and Mode Selection (`src/webview/ui.html`)
The user interface controls the routing behavior via the dropdown:
- **💬 Normal Chat:** Direct pass-through to the Main Executor with `ARCHITECTURE.md` injected. Fast and simple.
- **🏢 Architect:** Direct pass-through to the Main Executor but with stringent system instructions enforcing step-by-step scaffolding.
- **🚀 Advanced (Dual-Brain):** Routes through the `DualEngineRouter`, invoking the Support Scout first to dynamically gather extra file context via tools before generating code.

## Future Improvement Ideas
- **UI History Pagination:** Implement a sidebar menu to store, name, and load previous chat sessions from `.chat-history.json`.
- **Smart RAG Rebuilding:** Currently BM25 rebuilds chunks linearly. Implement an SQLite or IndexedDB backend to store chunks persistently across VS Code restarts.
- **AST Patching:** Expand `replace_symbol` to utilize full AST parsing rather than just LSP symbols, allowing for even more robust code replacements.
