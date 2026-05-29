<div align="center">
  <h1>🚀 Ultra Light AI (Copilot Alternative)</h1>
  <p><strong>A blazingly fast, context-aware, offline-capable AI Coding Assistant for VS Code.</strong></p>
</div>

> **⚠️ STATUS: UNDER DEVELOPMENT (BETA/UNSTABLE)**  
> This extension is actively being built and is currently in an unstable beta phase. It is not yet a stable release. You might encounter bugs, unexpected behaviors, or unoptimized flows. We welcome you to try it out, catch bugs, suggest improvements, and contribute to taking this to the next level!

---

## 🌟 Overview

Ultra Light AI is a Copilot-style AI assistant extension designed from the ground up to be ultra-lightweight and highly performant. Built entirely in Vanilla TypeScript (zero heavy frameworks) with a sub-100MB memory footprint, it acts as a 10x pair-programmer right inside your IDE. 

It supports **both Online (Cloud APIs like Gemini/Claude)** and **Offline (Local LLMs like Ollama/LMStudio)** models natively. 

The goal is to evolve this into a "Cursor-level" AI experience, with full RAG-based codebase understanding, surgical diff-patching, and automated terminal execution.

---

## ✨ Key Features (Current)

- **⚡ Search & Replace Patching:** Instead of rewriting whole files, the AI intelligently outputs targeted `<<<<<<< SEARCH` and `>>>>>>> REPLACE` blocks to surgically fix bugs and update code, minimizing data loss.
- **📁 Drag & Drop Context:** Easily drag and drop files directly into the chat interface to instantly inject their contents into the AI's context window.
- **🔄 Online & Offline Model Support:** Switch seamlessly between Cloud models (Gemini 1.5 Pro, Flash, Gemma) and Local Offline Models.
- **🕊️ Bird's Eye View (@workspace):** Automatically scans your workspace directory structure to understand the project architecture without blowing up the token budget.
- **🌐 Real-Time Web Search:** Type `@search <query>` to give the AI real-time internet access via DuckDuckGo to search for documentation and solutions on the fly. Source links are provided in the response!
- **🔙 Safe Rollbacks:** Native VS Code `WorkspaceEdit` integration allows you to press `Ctrl+Z` to safely revert any AI-generated code changes. Chat history can also be rewound.
- **🛡️ Basic Terminal Sandboxing:** The AI can execute terminal commands for you (e.g., `npm install`), but destructive commands (`rm -rf`, disk formatting) are blocked.
- **🧠 Persistence:** Chat history automatically persists across window reloads so you never lose your context.

---

## 🛠️ How to Use

1. **Open the AI Sidebar:** Press `Ctrl+Shift+A` (or `Cmd+Shift+A` on Mac) to open the chat interface. *(Note: You can drag the icon from the Activity Bar to your Secondary Sidebar on the right for a better layout!)*
2. **Add Context:** 
   - Type `@file path/to/file` or simply **drag and drop** a file into the chat.
   - Keep the "Include Active File" checkbox ticked to automatically send the currently open file.
3. **Write a Prompt:** Ask the AI to fix a bug, refactor a function, or explain a concept.
4. **Apply Changes:** If the AI generates a code block or a Search/Replace patch, click the **Apply** button to automatically inject the code into your active editor.
5. **Switch Models:** Use the dropdown in the chat UI to switch between models. You can also configure a custom model endpoint!

---

## 🏗️ Architecture & Code Flow

Ultra Light AI avoids heavy dependencies (no React, no Vue) in favor of pure DOM manipulation and native VS Code APIs. 

### ⚙️ Technologies Used
- **VS Code Extension API** (`vscode`)
- **Vanilla TypeScript** (Backend & Orchestration)
- **Vanilla HTML/JS + Tailwind CSS via CDN** (Webview UI)
- **Marked.js + Highlight.js** (Markdown parsing & Syntax highlighting)
- **esbuild** (Bundling)

### 📂 File Structure Explanation

- **`src/extension.ts`**: The entry point of the extension. Initializes the State Machine, Cloud/Local clients, registers commands, and mounts the `SidebarProvider`.
- **`src/webview/sidebarProvider.ts`**: **The Brain.** Orchestrates communication between the Webview UI and the VS Code IDE. Handles prompt building, context injection (parsing `@file`), applying WorkspaceEdits (Diff Patching), and Terminal sandboxing.
- **`src/webview/ui.html`**: The frontend chat interface. Handles Tailwind rendering, Drag & Drop event listeners, and streaming Markdown parsing.
- **`src/config.ts`**: Manages user preferences, reads `.env` variables, and auto-generates the `.agent-config.json` file in the user's workspace.
- **`src/state/conversationHistory.ts`**: Manages the multi-turn memory of the AI. Ensures history stays within token limits and handles reading/writing to `.chat-history.json` for persistence.
- **`src/router/realClients.ts` & `dummyClients.ts`**: The API integration layer. Manages streaming server-sent events (SSE) for Gemini/OpenAI endpoints and handles model switching.
- **`src/tools/scraper.ts`**: Contains the zero-dependency web scraper and search parser used when the `@search` directive is triggered.

---

## 🛣️ Roadmap & Future Capabilities (To "Cursor-Level")

We have massive plans to push this extension to match and exceed the capabilities of standalone AI IDEs like Cursor:

- [ ] **Semantic RAG (Retrieval-Augmented Generation):** Transition from simple `@file` injections to a local vector database. The AI will instantly search across 10,000+ files to find exact function definitions without manual context passing.
- [ ] **Advanced Multi-File Diff Resolution:** Better handling of conflicting edits when multiple files are modified simultaneously.
- [ ] **Automated Agent Workflows (Auto-Fix):** The AI will run your tests, read the terminal output, identify the failing lines, and write a patch entirely autonomously.
- [ ] **Deep Terminal Sandboxing:** Migrating from a regex blacklist to a fully restricted execution environment for safer automated system operations.
- [ ] **Codebase Indexing:** A background worker that indexes codebase structures (AST) for instant "Bird's eye view" accuracy.

---

## 🤝 Contributing

This is a community-driven, ultra-lightweight project! Because it is currently in its early beta phase, there is plenty of room for improvement. 

**How you can help:**
1. **Find Bugs:** Use the extension daily. If the AI breaks a file or the UI glitches, open an issue!
2. **Suggest Improvements:** Have an idea for a better UI or prompt engineering strategy? Let us know.
3. **Submit PRs:** Pick up items from the Roadmap above. Whether it's adding a new Local API provider (like LMStudio) or optimizing the Search/Replace regex, PRs are deeply appreciated.

### Developer Setup
1. Clone the repo.
2. Run `npm install`.
3. Press `F5` in VS Code to open the Extension Development Host.
4. Run `npm run watch` to hot-reload your TypeScript changes.

---
*Happy Coding! Let's build the fastest AI assistant together.* 🚀
