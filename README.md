<div align="center">
  <h1>🚀 Ultra Light AI (Copilot Alternative)</h1>
  <p><strong>A blazingly fast, context-aware, offline-capable AI Coding Assistant for VS Code.</strong></p>
</div>

> **⚠️ STATUS: STABLE BETA**  
> We've just completed a massive squashing of 18 critical and high-severity bugs! The extension is now highly stable, but we still welcome feedback to take this to the next level.

---

## 🌟 Overview

Ultra Light AI is a Copilot-style AI assistant extension designed from the ground up to be ultra-lightweight and highly performant. Built entirely in Vanilla TypeScript (zero heavy frameworks) with a sub-100MB memory footprint, it acts as a 10x pair-programmer right inside your IDE. 

The goal is to evolve this into a "Cursor-level" AI experience, with full RAG-based codebase understanding, surgical diff-patching, and automated terminal execution.

---

## 🔒✨ 100% PRIVATE OFFLINE CODING WITH OLLAMA ✨🔒

Tired of sending your proprietary, top-secret codebase to the cloud? **Ultra Light AI natively supports Ollama** for completely offline, local AI assistance!

- **Zero Data Leaks:** Your code never leaves your machine. Period.
- **Lightning Fast Local Inference:** Connect to your local `http://127.0.0.1:11434` instance instantly.
- **Model Agnostic:** Use Llama 3, CodeQwen, DeepSeek Coder, or any model supported by Ollama.
- **Flight Mode Coding:** Keep building and refactoring even when you have no internet connection.

Just click the ⚙️ Gear Icon, select **Local Provider**, enter your model name, and experience true private AI.

---

## ✨ Key Features (Current)

- **🧠 Semantic RAG Context (@rag):** The AI uses a built-in BM25 Search Engine to instantly search your workspace for exact function definitions and semantic context without blowing up your token budget!
- **⚡ Search & Replace Patching:** Instead of rewriting whole files, the AI intelligently outputs targeted `<<<<<<< SEARCH` and `>>>>>>> REPLACE` blocks to surgically fix bugs and update code, minimizing data loss.
- **📁 Drag & Drop Context:** Easily drag and drop files directly into the chat interface to instantly inject their contents into the AI's context window.
- **🔄 Online & Offline Model Support:** Switch seamlessly between Cloud models (Gemini 1.5 Pro, Flash, Gemma) and Local Offline Models.
- **🕊️ Bird's Eye View (@workspace):** Automatically scans your workspace directory structure to understand the project architecture. (Optimized to strictly ignore `node_modules` and `dist`!).
- **🌐 Deep Web Scraping (@search):** Type `@search <query>` to give the AI real-time internet access. Unlike basic extensions that only read search snippets, Ultra Light AI fetches and reads the full HTML of the top web resources, preserving code blocks for maximum accuracy. From latest IPL scores to untouched official documentation!
- **🔙 Safe Rollbacks:** Native VS Code `WorkspaceEdit` integration allows you to press `Ctrl+Z` to safely revert any AI-generated code changes across multiple files. Chat history can also be rewound.
- **🛡️ Secure Terminal Sandboxing:** The AI can execute terminal commands for you, but will ALWAYS prompt you for explicit permission with a VS Code Warning Dialog before running anything.

---

## ⚙️ Configuration & The `.agent-config.json` File

To keep your settings portable and workspace-specific, Ultra Light AI uses a local configuration file instead of burying settings deep in VS Code preferences.

When you configure your API Keys, Tokens, or Model via the **⚙️ Gear Icon** in the chat interface, the extension automatically creates a hidden `.agent-config.json` file in your project's root directory.

> **💡 Note to Users:** 
> - Your API Keys are stored in this `.agent-config.json` file. 
> - **We highly recommend adding `.agent-config.json` to your `.gitignore`** so you don't accidentally commit your keys to GitHub!
> - The extension will always prioritize the `.agent-config.json` file over `.env` files. If you are testing or debugging, remember that this file dictates your active API keys.

---

## 🛠️ How to Use

1. **Open the AI Sidebar:** Press `Ctrl+Shift+A` (or `Cmd+Shift+A` on Mac) to open the chat interface. *(Note: You can drag the icon from the Activity Bar to your Secondary Sidebar on the right for a better layout!)*
2. **Add Context:** 
   - Type `@rag` to trigger a semantic search over your codebase.
   - Type `@file path/to/file` or simply **drag and drop** a file into the chat.
   - Keep the "Include Active File" checkbox ticked to automatically send the currently open file.
3. **Write a Prompt:** Ask the AI to fix a bug, refactor a function, or explain a concept.
4. **Apply Changes:** If the AI generates a code block or a Search/Replace patch, click the **Apply** button to automatically inject the code into your active editor. You can also **Reject** the code block natively!
5. **Switch Models:** Use the dropdown in the chat UI to switch between models. 

---

## 🏗️ Architecture & Code Flow

Ultra Light AI avoids heavy dependencies (no React, no Vue) in favor of pure DOM manipulation and native VS Code APIs. 

### ⚙️ Technologies Used
- **VS Code Extension API** (`vscode`)
- **Vanilla TypeScript** (Backend & Orchestration)
- **Vanilla HTML/JS + Tailwind CSS via CDN** (Webview UI)
- **Marked.js** (Markdown parsing & syntax rendering)
- **esbuild** (Bundling)

### 📂 File Structure Explanation

- **`src/extension.ts`**: The entry point of the extension. Initializes the State Machine, Cloud/Local clients, registers commands, and mounts the `SidebarProvider`.
- **`src/webview/sidebarProvider.ts`**: **The Brain.** Orchestrates communication between the Webview UI and the VS Code IDE. Handles prompt building, RAG semantic search execution, applying WorkspaceEdits (Diff Patching), and Terminal sandboxing.
- **`src/rag/ragEngine.ts`**: Custom-built BM25 search engine that chunks and indexes your codebase for lightning-fast, offline context retrieval.
- **`src/webview/ui.html`**: The frontend chat interface. Handles Tailwind rendering, Drag & Drop event listeners, streaming Markdown parsing, and inline Action buttons.
- **`src/config.ts`**: Manages user preferences, reads `.env` variables, and auto-generates the `.agent-config.json` file.
- **`src/state/conversationHistory.ts`**: Manages the multi-turn memory of the AI. Ensures history stays strictly within exact token limits (calculated at characters / 3) and handles persistence.
- **`src/router/realClients.ts`**: The API integration layer. Manages streaming server-sent events (SSE) for Cloud endpoints and Offline Local Clients (Ollama).

---

## 🤝 Contributing

This is a community-driven, ultra-lightweight project! We recently squashed 18 major architectural bugs to stabilize the core loop, making it a perfect time to contribute new features.

**How you can help:**
1. **Find Bugs:** Use the extension daily. If the AI breaks a file or the UI glitches, open an issue!
2. **Suggest Improvements:** Have an idea for a better UI or prompt engineering strategy? Let us know.
3. **Submit PRs:** Whether it's adding a new Local API provider (like LMStudio) or optimizing the Search/Replace regex, PRs are deeply appreciated.

### Developer Setup
1. Clone the repo.
2. Run `npm install`.
3. Press `F5` in VS Code to open the Extension Development Host.
4. Run `npm run watch` to hot-reload your TypeScript changes.

---
*Happy Coding! Let's build the fastest AI assistant together.* 🚀
