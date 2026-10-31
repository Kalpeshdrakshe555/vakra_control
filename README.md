<div align="center">
  <img src="icon.png" width="90" height="90" alt="Vakra AI Logo" />
  <h1>⚡ Vakra AI (Beta)</h1>
  <p><strong>The Open-Source Autonomous AI Coding Assistant for VS Code.</strong><br/>
  <em>Mathematically engineered to empower local 4B parameter models and edge hardware with disciplined, deterministic multi-agent coding.</em></p>

  <p>
    <a href="#-beta-status--community-call"><img src="https://img.shields.io/badge/Status-Beta%20%7C%20Active%20Dev-orange?style=flat-square" alt="Status" /></a>
    <a href="#-recommended-models--hardware-expectations"><img src="https://img.shields.io/badge/Optimized%20For-4B%20Models-blueviolet?style=flat-square" alt="Model Tier" /></a>
    <a href="#-local-first--privacy"><img src="https://img.shields.io/badge/Privacy-100%25%20Local%20First-success?style=flat-square" alt="Privacy" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="License" /></a>
    <img src="https://img.shields.io/badge/Tests-91%20Passing-brightgreen?style=flat-square" alt="Tests" />
  </p>

  <p>
    <a href="#-quick-start-run-locally">Quick Start</a> •
    <a href="#-recommended-models--hardware-expectations">Model Guidelines</a> •
    <a href="#-safety--approval-notice">Safety Caution</a> •
    <a href="#-core-architecture--innovations">Architecture</a> •
    <a href="#-contributing--bug-fixes">Contributing & PRs</a>
  </p>
</div>

---

## 📢 Beta Status & Community Call

> [!IMPORTANT]
> **Vakra AI is currently in BETA (Active Development).**  
> We are opening this repository early to the open-source community, AI researchers, and developers. You are warmly invited to **clone it, test it on your local machines, discover edge cases, fix bugs, and open Pull Requests (PRs)**!

If you find a bug or have an optimization idea for small local models, please [open an issue](https://github.com/) or submit a PR. Let's build the future of local-first agentic coding together!

---

## ⚠️ Safety & Approval Notice

> [!WARNING]
> **Check before giving Direct Full Control (Auto-Approve):**  
> Autonomous coding agents execute terminal commands and modify files. Before enabling session auto-approval in settings, **always review the proposed plan and commands**, especially on production or uncommitted codebases. Run inside a clean, git-tracked workspace so you can easily review and revert changes.

---

## 🎯 Recommended Models & Hardware Expectations

### 🧠 The Reality of 4B Parameter Models
Most existing coding agents (Devin, Cursor, Claude Code) are built for **70B–200B+ frontier models** with massive context windows (128k–200k+ tokens). When run on small 4B local models, standard agents fail due to token thrashing, instruction competition, and context degradation.

**Vakra AI solves this by shifting cognitive load from the model to deterministic TypeScript middleware.**

However, small models have physical boundaries:
* **✅ What Vakra AI handles great on 4B models:**
  * Scoped feature additions and component creation.
  * Surgical bug fixes and stack-trace crash diagnosis.
  * New project scaffolding (Django, React/Vite, FastAPI, Node.js).
  * Structured multi-step task execution guided by `PLAN.md`.
* **❌ What you should NOT expect from a 4B model:**
  * Massive architectural refactors touching dozens of legacy files in a single breath.
  * Abstract domain guessing without reading existing file lines.
* **⚠️ Models below 4B (<4B):**
  * Models smaller than 4B (e.g. 1B–2B) **do NOT possess enough reasoning depth or structured tool-calling reliability** for autonomous workflows. Please use 4B+ models.

### 🏆 Recommended Models to Run
| Model Tier | Recommended Models | Local Provider | Notes |
| :--- | :--- | :--- | :--- |
| **Primary 4B Choice** | `gemma-2-4b-it` / `gemma4-agentic` | LM Studio / Ollama / llama-server | Sharp instruction following & clean CLI generation |
| **Code-Specialized** | `Qwen2.5-Coder-7B-Instruct` / `Qwen2.5-Coder-3B` | LM Studio / Ollama | Excellent surgical syntax & diff accuracy |
| **Balanced Edge** | `Llama-3.2-3B-Instruct` / `Llama-3.1-8B-Instruct` | Ollama / LM Studio | Fast local inference on consumer laptop GPUs/CPUs |

---

## 🚀 Quick Start: Run on Your Local PC

Follow these steps to set up and run Vakra AI locally in under 3 minutes:

### 1. Prerequisites
* **Node.js** (v18.0.0 or higher) & **npm**
* **VS Code** (v1.85.0 or higher)
* A local LLM server running (e.g., **LM Studio**, **Ollama**, or **llama-server**) with an OpenAI-compatible API endpoint (e.g. `http://localhost:1234/v1` or `http://localhost:11434/v1`).

### 2. Clone the Repository
```bash
git clone https://github.com/<your-username>/vakra_control.git
cd vakra_control
```

### 3. Install Dependencies & Build
```bash
npm install
npm run compile
```

### 4. Launch in VS Code Extension Host
1. Open the project folder in VS Code:
   ```bash
   code .
   ```
2. Press **`F5`** (or go to **Run and Debug** in the sidebar and select **"Run Extension"**).
3. A new **Extension Development Host** VS Code window will launch with Vakra AI installed!

### 5. Connect Your Model
1. In the new window, click the **⚡ Vakra AI** icon in the Activity Bar.
2. Click the **Settings (gear icon)** at the bottom of the sidebar.
3. Configure your local endpoint:
   * **API Base URL:** `http://localhost:1234/v1` (LM Studio) or `http://localhost:11434/v1` (Ollama)
   * **API Key:** `lm-studio` (or leave as dummy)
   * **Model ID:** Your loaded model name (e.g. `gemma-2-4b-it` or `qwen2.5-coder-7b-instruct`)
4. Save and start coding!

---

## 🏛️ Core Architecture & Reliability Innovations

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 USER PROMPT / TASK                                      │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│              Agent 1: Architect & Planner (Explicit Plan / New Projects)                │
│  • Researches online docs via DuckDuckGo extraction                                     │
│  • Generates clean roadmap in root PLAN.md                                              │
│  • Displays dedicated UI Plan Approval Card: [✔ Approve & Proceed]                      │
│  • Pauses and awaits user authorization                                                 │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │ User Click / Direct Bug Fix
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                        Agent 2: Autonomous Executor & Developer                         │
│  • Auto-Environment Snapshot (<30ms): Live OS, PowerShell, .venv path & versions        │
│  • Smart VirtualEnv Auto-Binding: Pre-binds .venv/Scripts to PATH for pip/python/CLI   │
│  • File Operations: Surgical Search/Replace (DiffPatcher) & write_file                  │
│  • Official Self-Verification: python manage.py check, npm test, get_code_diagnostics  │
│  • 1-Strike Web Search Gate: Intercepts library/syntax errors & retrieves latest docs   │
│  • Marks step complete in PLAN.md & concludes cleanly                                   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1. 2-Agent Lean Architecture
* **Agent 1 (Architect / Planner):** Triggers only on explicit planning requests or new project scaffolding. Researches modern syntax, establishes high-level steps in `PLAN.md`, and yields to the user with a UI Plan Approval card.
* **Agent 2 (Autonomous Executor):** Executes approved steps one-by-one or handles direct bug fixes without unnecessary agent handoffs. Has full developer tools (`execute_terminal_command`, `write_file`, `edit_file`, `search_web`, `get_code_diagnostics`, `complete_plan_step`, `finish`).

### 2. Single Source of Truth (`PLAN.md`)
* No hidden duplicate files or out-of-sync metadata.
* `PLAN.md` is maintained directly in your workspace root so both you and the model see the exact same progress.

### 3. Smart Virtual Environment Auto-Binding
* Automatically detects `.venv`, `venv`, or `env` in your workspace.
* Automatically prepends `.venv/Scripts` (Windows) or `.venv/bin` (macOS/Linux) to `PATH` in spawned processes.
* Commands like `python`, `pip`, and `django-admin` **always run inside your virtual environment** without requiring manual shell activation.

### 4. 1-Strike Web Search Gate (Post-2024 Knowledge Grounding)
* Small models often suffer from 2024 training cutoffs and hallucinate outdated library APIs.
* If a terminal command fails with a missing module or syntax error, the system blocks blind guesswork edits and prompts the model to execute `search_web` for the exact error and library version first.

### 5. Fast Grounding & Crash Traceback Diagnoser
* Pasted terminal errors and stack traces are automatically parsed by `ErrorDiagnoser`, which extracts crashing filepaths and line numbers to pre-ground the model before it executes its turn.

---

## 🧪 Verification & Test Suite

Vakra AI is strictly developed under the **Gravitas Reliability Runtime** framework (empirical proof, no fabricated claims, bounded retries).

Run the full test suite locally:
```bash
# Run 91 unit, contract, platform, and guard tests
npx mocha -u tdd -r ./out/test/suite/mockVscode.js "./out/test/suite/!(realModelBenchmark).test.js"

# Compile TypeScript
npx tsc -p .

# Build CSS and Webview bundles
npm run compile
```
> **Current Status:** 91/91 passing tests (100% pass rate).

---

## 🤝 Contributing & Bug Fixes

We love community contributions! Here is how you can help:
1. **Fork the Repo** and create your branch (`git checkout -b feature/cool-enhancement` or `bugfix/fix-terminal-handling`).
2. Make your changes and write unit tests under `src/test/suite/`.
3. Ensure all tests pass: `npm test`.
4. Submit a **Pull Request (PR)** with a clear description of the bug and empirical verification output.

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.
