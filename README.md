<div align="center">
  <img src="icon.png" width="100" height="100" alt="Vakra AI Logo" />
  <h1>⚡ Vakra AI</h1>
  <p><strong>The Autonomous, High-Precision AI Coding Agent Engineered for Small Models & Frontier LLMs.</strong></p>

  <p>
    <a href="https://github.com/Kalpeshdrakshe555/vakra_control/stargazers"><img src="https://img.shields.io/github/stars/Kalpeshdrakshe555/vakra_control?style=flat-square" alt="Stars" /></a>
    <a href="https://github.com/Kalpeshdrakshe555/vakra_control/network/members"><img src="https://img.shields.io/github/forks/Kalpeshdrakshe555/vakra_control?style=flat-square" alt="Forks" /></a>
    <a href="https://github.com/Kalpeshdrakshe555/vakra_control/issues"><img src="https://img.shields.io/github/issues/Kalpeshdrakshe555/vakra_control?style=flat-square" alt="Issues" /></a>
    <img src="https://img.shields.io/badge/status-beta%20(active%20development)-amber?style=flat-square" alt="Beta" />
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome" />
    <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" />
  </p>

  <p>
    <a href="#-project-status--community-call">Beta Notice</a> •
    <a href="#-known-limitations--model-guidance">Model Guidance</a> •
    <a href="#-security--safe-usage-guidelines">Security</a> •
    <a href="#-quickstart--installation">Quickstart</a> •
    <a href="#-running--debugging-in-vs-code">Run in VS Code</a> •
    <a href="#-model-configuration">Model Setup</a> •
    <a href="#-the-unified-planmd-architecture">Architecture</a> •
    <a href="#-contributing">Contributing</a>
  </p>
</div>

---

## 🚧 Project Status & Community Call

> [!WARNING]
> **Vakra AI is currently in BETA and under active daily development.**  
> Features, prompt structures, and internal tool signatures are evolving rapidly. You may encounter edge-case behaviors, especially during complex multi-file refactoring sessions.

### 🤝 We Need Your Help to Build the Future of Local AI Coding!
Whether you are an AI researcher, frontend developer, TypeScript enthusiast, or system engineer:
- Found a bug? [Open an Issue](https://github.com/Kalpeshdrakshe555/vakra_control/issues).
- Have an architectural idea or performance fix? **Submit a Pull Request (PR)!**
- All contributions—from documentation polish to benchmark testing on new models—are deeply appreciated.

---

## 🧠 Known Limitations & Model Guidance (Realistic Overview)

We believe in complete technical transparency with the developer community:

### 1. Small Local Models (SLMs: 3B – 7B Parameters)
* **What works well:** Vakra AI is mathematically tuned for small local models (e.g. `Qwopus 4B`, `Qwen 2.5 Coder 7B`, `Gemma 4B`, `Llama 3.2`). It excels at **small to mid-sized tasks**: single-feature development, targeted bug fixes, script creation, unit testing, and surgical edits.
* **The Attention Limit (The Big Known Issue):** In **very large, multi-phase tasks or lengthy continuous chat sessions**, small 4B models can experience **attention drift / context saturation**. They may begin repeating actions, re-checking files unnecessarily, or outputting loops.  
  * *Tip:* For small models, keep chat turns focused. Use the **New Chat** button when switching to a completely new feature, and let `PLAN.md` carry your project memory.

### 2. Frontier Cloud Models (Unleashed Autonomous Power)
* If you plug in a high-parameter cloud model via API (e.g. **Claude 3.5 Sonnet**, **GPT-4o**, **Gemini 2.5 Pro / Flash**, or **DeepSeek-V3**), Vakra AI performs **exceptionally well**!
* Large models easily navigate deep multi-file dependency trees, execute 30+ step autonomous loops without drift, and produce rock-solid full-stack code.

---

## 🔒 Security & Safe Usage Guidelines

Because Vakra AI operates as an autonomous agent capable of executing terminal commands and modifying files, adhere strictly to the following security practices:

> [!CAUTION]
> **1. Never Open Root or Sensitive Folders:**  
> NEVER open your user directory (`C:\Users\username`, `~`, `/`), system root (`C:\`, `/`), SSH keys folder, or credential vaults in VS Code when using the agent. **Only open the specific project folder you intend to work on.**

> [!IMPORTANT]
> **2. Review Commands Before Approval:**  
> When the agent suggests terminal commands, **always inspect the command line** before clicking approve—especially commands involving package installations, network access, or file deletions (`rm`, `del`, `git reset`).

> [!TIP]
> **3. Protect Secrets:**  
> Store environment secrets in `.env` files. Vakra AI's `.gitignore` automatically prevents `.env` and `.agent-config.json` files from being committed to version control.

---

## 🚀 Quickstart & Installation

Follow these step-by-step instructions to clone, build, and run Vakra AI from source:

### Prerequisites
- **[Node.js](https://nodejs.org/)** (v18.0.0 or higher required)
- **[Git](https://git-scm.com/)**
- **[Visual Studio Code](https://code.visualstudio.com/)** (v1.85.0 or higher)

### 1. Clone the Repository
```bash
git clone https://github.com/Kalpeshdrakshe555/vakra_control.git
cd vakra_control
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Compile the Extension
Build the Tailwind CSS assets and package the TypeScript bundle:
```bash
npm run compile
```

*(Optional: For live re-compilation during development, run `npm run watch` in a background terminal.)*

---

## 💻 Running & Debugging in VS Code

Once compiled, launch the extension inside a sandboxed **Extension Development Host**:

### Windows
1. Open the `vakra_control` folder in VS Code (`File > Open Folder...`).
2. Press **`F5`** (or **`Ctrl + F5`** to Run Without Debugging).
3. A new VS Code window titled **`[Extension Development Host]`** will open.
4. Click the **Vakra AI** icon in the Activity Bar (or press `Ctrl+Shift+P` → type `Vakra AI: Open Chat`).

### macOS
1. Open the `vakra_control` folder in VS Code (`File > Open Folder...`).
2. Press **`F5`** (or **`Cmd + F5`** to Run Without Debugging).  
   *Alternative:* Open the **Run and Debug** view (`Cmd + Shift + D`) and click the green play button next to **"Run Extension"**.
3. In the new **`[Extension Development Host]`** window, access Vakra AI from the sidebar.

### Linux
1. Open the `vakra_control` folder in VS Code.
2. Press **`F5`** (or **`Ctrl + F5`**).
3. The Extension Development Host will launch with Vakra AI ready in the sidebar.

---

## 🤖 Model Configuration (Local & Cloud)

Open the Settings panel by clicking the ⚙️ icon in the top-right corner of the Vakra AI sidebar:

### Option A: Local Inference (`llama-server` / `Ollama`)

> [!IMPORTANT]
> **Context Size is Critical:** When running `llama-server.exe`, **always pass `-c 16384` (or `-c 32768`)**! Without the `-c` flag, llama.cpp defaults to only 2048 or 4096 tokens, causing context overflow and hallucination after 3–4 turns.

**Example Windows PowerShell Launch Command:**
```powershell
& "D:\llama_coo\llama-server.exe" `
  -m "D:\local_coding_agent\models\other\Qwopus3.5-4B-Coder-MTP-Q6_K.gguf" `
  -c 16384 `
  -ngl 99 `
  -fa on `
  --host 127.0.0.1 `
  --port 8083
```

**Sidebar Settings (⚙️):**
* **API Provider:** `Local (llama-server / Ollama / OpenAI Compatible)`
* **Endpoint:** `http://127.0.0.1:8083` (or `http://127.0.0.1:11434` for Ollama)
* **Model Name:** Your model identifier (e.g. `qwopus-4b` or `qwen2.5-coder-7b`)
* **Max Steps / Turn:** `25`–`40`

### Option B: Cloud Frontier Models (Recommended for Production / Large Tasks)
* **Gemini Cloud:** Enter one or more Gemini API Keys (comma-separated for auto-failover).
* **OpenAI / Groq / OpenRouter / Anthropic:** Set provider and enter your API key to tackle massive full-stack applications with high reasoning depth.

---

## 📐 The Unified `PLAN.md` Architecture

To prevent small models from losing state, Vakra AI uses a **Hierarchical 4-Phase Execution Contract** centered around `./PLAN.md` as the Single Source of Truth:

```
┌────────────────────────────────────────────────────────┐
│ Phase 1: High-Level Macro Plan (set_task_plan)        │
│ - Understands User Requirements                        │
│ - Creates sequential roadmap [ ] Step 1, 2, ...        │
│ - Pauses and asks user for approval                    │
└───────────────────────────┬────────────────────────────┘
                            │ User Approves
┌───────────────────────────▼────────────────────────────┐
│ Phase 2: Active Step Expansion (expand_plan_step)     │
│ - Expands ONLY Step 1 into atomic sub-steps (1.1, 1.2) │
│ - Leaves remaining macro steps clean & untouched       │
└───────────────────────────┬────────────────────────────┘
                            │ Sequential Execution
┌───────────────────────────▼────────────────────────────┐
│ Phase 3: Sub-Step Blueprint & Verification            │
│ - Formulates 2-3 line [BLUEPRINT] before code edits    │
│ - Performs surgical code edit & verification checks    │
│ - Calls complete_plan_step(sub_step_id, summary)       │
└───────────────────────────┬────────────────────────────┘
                            │ All Sub-Steps Complete
┌───────────────────────────▼────────────────────────────┐
│ Phase 4: User Handoff & Boundary Stop                 │
│ - Marks Step 1 [x] in PLAN.md with modified files      │
│ - STOPS autonomous loop, presents report to user       │
│ - Prompts: "Step 1 completed. Proceed with Step 2?"    │
└────────────────────────────────────────────────────────┘
```

### Format of `./PLAN.md` in Your Workspace Root
```markdown
# 🎯 User Requirements
User goal and technical specifications described here.

--------------------------------------------------
[x] Step 1: Initialize Database Models & Migrations
      *Modified*: src/models/user.py, src/models/auth.py
      *Logic & Summary*: Defined User and Token models with bcrypt hashing.
      [x] Step 1.1: Create base User schema
         *Outcome*: Created User class with email uniqueness.
      [x] Step 1.2: Generate and apply migrations
         *Outcome*: Ran makemigrations and migrate successfully.
[>] Step 2: Implement REST API Endpoints & Serializers
      [>] Step 2.1: Add UserSerializer and validator
      [ ] Step 2.2: Register ViewSet and URL routing
[ ] Step 3: Frontend Integration & End-to-End Verification
```

---

## ✨ Features at a Glance

* **⏪ Granular Rollback & File Recovery Modal:** Preview exact `+X / -Y` line diffs and restore files to pre-turn snapshots with a single click.
* **🎙️ Full-Duplex Voice Assistant:** Dynamic energy gating (0.015 idle / 0.075 speaking), barge-in interruption (<500ms), Whisper STT, and Kokoro-82M / Edge TTS.
* **🌐 Web Brain Browser Bridge:** Connect to active Google Chrome sessions via `--remote-debugging-port=9222` to pair-program with Gemini/ChatGPT Web without API costs.
* **🎯 Declarative Workspace Skills:** Add custom domain guidelines to `.ultra-light-ai/skills/<skill>/SKILL.md` with automatic conflict resolution.
* **💻 Windows PowerShell Native Sanitization:** Auto-converts chained `&&` commands to `;`, prevents sub-process `cd` errors, and routes working directories to nested framework roots.

---

## ⌨️ Shortcuts & Commands

| Command | Action | Keybinding |
|---|---|---|
| `Vakra AI: Open Chat` | Opens the assistant sidebar | `Ctrl+Shift+P` → Open Chat |
| `Vakra AI: New Chat` | Clears memory and starts fresh session | `Ctrl+Shift+P` → New Chat |
| `Vakra AI: AI Quick Fix` | Analyzes and fixes current editor error diagnostics | `Ctrl+Shift+P` → Quick Fix |
| `Inline Edit` | Surgically edits selected code directly in editor | `Ctrl+K` |
| `Fix Terminal Error` | Captures last 60 lines of terminal output for debugging | Right-click terminal |

---

## 🤝 Contributing

We welcome contributions of all kinds! Here is how you can help:

1. **Fork the Repository:** Click the **Fork** button on GitHub.
2. **Clone your Fork:**
   ```bash
   git clone https://github.com/<your-username>/vakra_control.git
   cd vakra_control
   ```
3. **Create a Feature Branch:**
   ```bash
   git checkout -b feature/amazing-improvement
   ```
4. **Make Changes & Test:**
   ```bash
   npm run compile
   ```
5. **Commit & Push:**
   ```bash
   git commit -m "feat: enhance local context pruning"
   git push origin feature/amazing-improvement
   ```
6. **Open a Pull Request:** Submit your PR with a clear summary of changes and test steps.

---

## 📄 License

Vakra AI is open-source software licensed under the **[MIT License](LICENSE)**. Built with ❤️ for the open-source developer and local AI community.
