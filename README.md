<div align="center">
  <h1>🚀 Ultra Light AI (The Ultimate Agentic Coding Assistant)</h1>
  <p><strong>A blazingly fast, context-aware, fully autonomous offline-capable AI Assistant for VS Code.</strong></p>
  <p><em>Experience "Cursor-level" power natively inside standard VS Code.</em></p>
</div>

> **⚠️ STATUS: STABLE & FEATURE-COMPLETE**  
> We've just completed a massive architectural upgrade! Ultra Light AI is now a **fully autonomous Agentic tool** featuring native LSP codebase context, inline ghost text, Composer diff previews, and Devin-style autonomous execution loops!

---

## 🌟 Overview

Ultra Light AI is a powerful coding assistant extension designed from the ground up to be ultra-lightweight and highly performant. Built entirely in Vanilla TypeScript (zero heavy frameworks) with a sub-100MB memory footprint, it acts as an autonomous 10x pair-programmer right inside your IDE. 

We've bridged the gap between VS Code and premium AI IDEs like Cursor by introducing 7 industry-leading features directly into your environment!

---

## 🔒✨ 100% PRIVATE OFFLINE CODING WITH OLLAMA ✨🔒

Tired of sending your proprietary, top-secret codebase to the cloud? **Ultra Light AI natively supports Ollama** for completely offline, local AI assistance!

- **Zero Data Leaks:** Your code never leaves your machine. Period.
- **Lightning Fast Local Inference:** Connect to your local `http://127.0.0.1:11434` instance instantly.
- **Model Agnostic:** Use Llama 3, CodeQwen, DeepSeek Coder, or any model supported by Ollama.
- **Flight Mode Coding:** Keep building and refactoring even when you have no internet connection.

Just click the ⚙️ Gear Icon, select **Local Provider**, enter your model name, and experience true private AI.

---

## 🚀🔥 7 New "Cursor-Killer" Agentic Features

We've heavily upgraded the core engine. You now have access to:

### 1. ⌨️ Ctrl+K (Inline Edit)
Highlight any code, press `Ctrl+K` (`Cmd+K` on Mac), and type a quick instruction (e.g., *"Make this async"*). The AI will surgically replace the selected text in real-time, right in your editor. No need to open the sidebar!

### 2. 🤖 Agent Mode (Autonomous Execution Loops)
Toggle **"🤖 Agent Mode"** in the chat footer to unleash a Devin-style autonomous agent! When the AI needs to run tests or debug, it will generate a terminal command. The extension will automatically execute it in the background and feed the stdout/stderr directly back to the AI. The AI will autonomously loop, debug, and fix your code until the task is complete!

### 3. 👁️ Composer / Multi-File Unified Diff Preview
Before applying any AI code changes, click the **"👁️ Preview"** button. The extension will generate a temporary file and open VS Code's native Split-Screen Diff View, allowing you to review exactly what the AI changed before injecting it into your live files!

### 4. 🧠 True Codebase Context (Native AST/LSP Integration)
Basic text search is dead. Ultra Light AI now hooks directly into VS Code's Language Server Protocol (`executeWorkspaceSymbolProvider`). When you type a class or function name in your prompt, the AI natively locates its definition across your entire workspace and extracts the exact surrounding code—providing pixel-perfect codebase awareness without blowing up your token budget!

### 5. 🚨 Terminal Error Auto-Catch
Did your compilation or tests fail? No need to copy-paste the error! Run the command **`Ultra Light AI: Fix Terminal Error`** (via Command Palette or Terminal Context Menu). The extension will instantly capture the last 60 lines of your active terminal and send it to the AI for debugging.

### 6. 📜 Project-Specific Rules (`.agentrules`)
Create a `.agentrules` (or `.cursorrules`) file in the root of your workspace. Define your architectural guidelines (e.g., *"Always use TailwindCSS, never use classes"*). The AI will silently ingest these rules before every generation to ensure absolute consistency.

### 7. 👻 Ghost Text Autocomplete (FIM)
Experience Copilot-style inline ghost text as you type. Pause for a split second, and the AI will predict your next lines of code based on the surrounding context.

---

## ✨ Classic Features

- **🧠 Semantic RAG Context (@rag):** Built-in BM25 Search Engine for fast offline codebase retrieval.
- **⚡ Search & Replace Patching:** Intelligent `<<<<<<< SEARCH` and `>>>>>>> REPLACE` blocks to surgically patch files instead of completely overwriting them. 
- **📁 Drag & Drop Context:** Drop files directly into the chat interface to inject them into the AI's brain.
- **🔄 Universal Model Support:** Switch between Cloud (Gemini 1.5 Pro, Flash, Gemma) and Offline (Ollama) with one click.
- **🌐 Deep Web Scraping (@search):** Type `@search <query>` to give the AI real-time internet access. It reads full HTML pages and preserves code blocks for accurate, up-to-date documentation scraping!
- **🔙 Safe Git-Style Chat Rollbacks:** Click "Rewind" in the chat history, and the system won't just delete the message—it will automatically revert any physical files that the AI modified during that turn!

---

## ⚙️ Configuration & The `.agent-config.json` File

To keep your settings portable, Ultra Light AI uses a local configuration file. 
When you configure your API Keys, Tokens, or Model via the **⚙️ Gear Icon**, the extension creates a hidden `.agent-config.json` file in your project's root directory.

> **💡 Note to Users:** 
> - Your API Keys are stored here. 
> - **Please add `.agent-config.json` to your `.gitignore`** so you don't commit your keys!
> - This file overrides any global `.env` settings.

---

## 🛠️ Getting Started

1. **Open the AI Sidebar:** Press `Ctrl+Shift+A` to open the chat interface. *(Pro Tip: Drag the icon to your Secondary Sidebar on the right for a better layout!)*
2. **Add Context:** 
   - Type `@rag` for semantic codebase search.
   - Type `@file path/to/file` or **drag and drop** a file.
   - Mention a function name directly (e.g. `AuthService`) to trigger the native LSP Symbol lookup.
3. **Write a Prompt:** Ask the AI to build a feature, fix a bug, or write tests.
4. **Agent Mode:** Tick the **🤖 Agent Mode** checkbox to allow the AI to autonomously run terminal commands and debug itself.
5. **Preview & Apply:** Click **👁️ Preview** to review changes in a Diff View, then click **Apply** to inject them!

---

## 🏗️ Architecture & Code Flow

Ultra Light AI avoids heavy dependencies (no React, no Vue) in favor of pure DOM manipulation and native VS Code APIs. 

### ⚙️ Technologies Used
- **VS Code Extension API** (`vscode`)
- **Vanilla TypeScript** (Backend)
- **Vanilla HTML/JS + Tailwind CSS via CDN** (Webview UI)
- **Marked.js** (Markdown rendering)
- **esbuild** (Bundling)

### 📂 Core Files
- **`src/extension.ts`**: The entry point. Handles `Ctrl+K`, Terminal Error Catching, and State Machine orchestration.
- **`src/webview/sidebarProvider.ts`**: **The Brain.** Orchestrates Prompt building, RAG execution, LSP symbol resolution, and Composer Diff Previews.
- **`src/operations/diffPatcher.ts`**: Contains our ultra-resilient 5-tier Search & Replace algorithm that prevents file corruption.
- **`src/state/conversationHistory.ts`**: Manages multi-turn memory and handles physical file-reversion during chat rollbacks.

---

## 🤝 Contributing

We just upgraded the extension to full Agentic Status! If you want to help push it further:

1. **Find Bugs:** Open an issue if the AI hallucinates or breaks a file.
2. **Suggest Improvements:** Ideas for better UI or prompt engineering are always welcome.
3. **Submit PRs:** Want to add Claude 3.5 Sonnet support or optimize the LSP resolver? PRs are deeply appreciated.

### Developer Setup
1. Clone the repo.
2. Run `npm install`.
3. Press `F5` in VS Code to open the Extension Development Host.
4. Run `npm run compile` or `npm run watch` to compile TypeScript changes.

---
*Happy Coding! Let's build the ultimate AI assistant together.* 🚀
