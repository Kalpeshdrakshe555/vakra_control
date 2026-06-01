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

## 🛠️ Step-by-Step Setup Guide (Beginner Friendly)

Setting up Ultra Light AI is extremely easy, whether you want to use the cloud (Gemini) or a free local model (Ollama).

### Option A: Quick Start (Cloud AI)
1. **Get an API Key:** Go to [Google AI Studio](https://aistudio.google.com/) and get a free Gemini API key.
2. **Open the Extension:** After installing the extension, press `Ctrl+Shift+A` (or click the robot icon) to open the AI Sidebar.
3. **Configure the Key:** 
   - Click the **⚙️ Gear Icon** in the top right of the chat panel.
   - Select **Cloud (Gemini)** as the AI Provider.
   - Paste your API key into the input box.
   - Click **Save Configuration**.
4. **Reload:** Press `F5` or `Ctrl+Shift+P` -> `Developer: Reload Window`. You're ready to code!

### Option B: 100% Free & Private (Local Ollama)
1. **Install Ollama:** Download and install [Ollama](https://ollama.com/) on your PC.
2. **Download a Model:** Open your terminal and run `ollama run qwen2.5-coder:1.5b` (or any other model like `llama3`). Wait for it to download.
3. **Configure the Extension:**
   - Click the **⚙️ Gear Icon** in the chat panel.
   - Select **Local Offline (Ollama / LM Studio)** as the AI Provider.
   - Set the Local API Endpoint to `http://127.0.0.1:11434`.
   - In the Active Model dropdown, choose **Custom Model...** and type the exact name of the model you downloaded (e.g., `qwen2.5-coder:1.5b`).
   - Click **Save Configuration** and reload VS Code.

---

## 🎯 How to Use (Features Guide)

1. **Add Context Automatically:** 
   - Check the **`@workspace`** box in the UI to let the AI search your entire codebase (RAG).
   - Check the **`@active`** box to automatically send your currently open file.
   - Just type a class or function name (e.g. `AuthService`) and the AI will auto-locate it using VS Code's AST!
2. **Step-by-Step Architect:** Tick the **`🏢 Architect`** box when asking for a large project (like "Build a Django App"). The AI will guide you step-by-step, providing terminal commands and code blocks one by one for flawless context memory.
3. **Preview & Apply:** Click **👁️ Preview** to review changes in a Diff View, then click **Apply** to inject them!

---

## 🏗️ Architecture & Code Flow

Ultra Light AI avoids heavy dependencies (no React, no Vue) in favor of pure DOM manipulation and native VS Code APIs. 

## 💻 Technologies & Tools Used

To maintain its blazing-fast performance and ultra-lightweight memory footprint (<100MB), this extension relies purely on native solutions and avoids heavy frontend frameworks.

* **TypeScript (Backend & Logic)**: Strongly typed backend ensuring zero runtime errors in production.
* **VS Code Extension API (`vscode`)**: Deep native integration for AST parsing (LSP), file operations, and editor manipulation.
* **Vanilla HTML5 / JavaScript (Frontend)**: The Webview UI is written in pure JS to guarantee instant load times and zero framework overhead.
* **Tailwind CSS (via CDN)**: Used for crafting the hyper-premium, Cyberpunk-themed UI with glassmorphism and glowing hover effects.
* **Marked.js & DOMPurify**: Safely parses and renders Markdown and code blocks from the AI's response.
* **esbuild**: A lightning-fast bundler used to package the extension.
* **BM25 Algorithm (Custom implementation)**: Used for local, offline semantic code search (RAG) without needing external vector databases.

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
