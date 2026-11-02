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
    <img src="https://img.shields.io/badge/Tests-101%20Passing-brightgreen?style=flat-square" alt="Tests" />
  </p>

  <p>
    <a href="#-quick-start-run-on-your-pc">Quick Start (PC)</a> •
    <a href="#-recommended-models--hardware-expectations">Model Guidelines</a> •
    <a href="#-safety--approval-notice">Safety Caution</a> •
    <a href="#-core-architecture--innovations">Architecture</a> •
    <a href="#-contributing--bug-fixes">Contributing & PRs</a>
  </p>
</div>

---

## 📢 Beta Status & Community Call

> [!IMPORTANT]
> **Vakra AI is currently in BETA (Active Development & Working Prototype).**  
> Ye system abhi active testing aur improvement phase me hai. We are opening this repository early to the open-source community, AI developers, and local LLM enthusiasts.  
> **Aap log ise apne local PC pe clone karke test kar sakte hain, bugs fix kar sakte hain, aur Pull Requests (PRs) open kar sakte hain!**
> 
> * Agar koi bug milta hai ya koi suggestion hai, to please GitHub Issues me report karein ya PR submit karein.

---

## ⚠️ Safety & Approval Notice

> [!WARNING]
> **Direct Full Control (Auto-Approve) dene se pahile zaroor check karein:**  
> Autonomous coding agents shell commands execute karte hain aur project files ko modify karte hain. Settings me bina-dekhe session auto-approval enable karne se pahile **model ke proposed plan aur commands ko inspect kar lijiye**, khas kar production ya uncommitted git repositories par.
> * Hamesha ek clean, Git-tracked workspace me kaam karein taaki aap kisi bhi unwanted change ko easily review ya revert kar sakein.

---

## 🎯 Recommended Models & Hardware Expectations

### 🧠 The Reality of 4B Parameter Models
Zyadatar existing coding agents (Devin, Cursor, Claude Code) 70B–200B+ frontier models ke liye design kiye gaye hain jinme 128k–200k+ tokens ka context window hota hai. Jab un agents ko 4B local models pe chalaya jata hai, to wo context overload aur looping ki wajah se fail ho jate hain.

**Vakra AI is problem ko solve karta hai by shifting cognitive load to deterministic TypeScript middleware.**

Lekin 4B local models ki physical capabilities aur limitations ko samajhna bohot zaroori hai:
* **✅ Small & Medium Tasks ke liye Better:**
  * Scoped feature additions aur specific modules/components create karna.
  * Surgical bug fixes aur terminal crash stack-traces diagnose karke resolve karna.
  * Standard project scaffolding (Django, React/Vite, FastAPI, Express).
  * `PLAN.md` aur `.ultra-light-ai/RESEARCH.md` ke dwara structured step-by-step execution.
* **❌ Bahut bade tasks isse expect mat karna:**
  * Ek hi prompt me dozens of legacy files ka massive enterprise refactor 4B models se expect mat karein; waha 4B context aur reasoning limitations aati hain. Aise tasks ko hamesha step-by-step plan me tod kar execute karein.
* **⚠️ 4B se niche wale models (<4B) isme sahi se work nahi karte:**
  * 1B–2B parameter wale models autonomous multi-agent tool calling aur complex reasoning handle nahi kar pate aur fail ho jate hain.
  * Agar aap 4B category test karna chahte hain, to **Gemma 2 4B (`gemma-2-4b-it`)** ya **Qwen 2.5 4B / Qwen 2.5 Coder 3B/7B** jaise models hi try karein.
  * Superior reasoning ke liye aap **Qwen 2.5 Coder 7B/14B**, **Llama 3.1 8B**, ya 9B+ parameter models use kar sakte hain.

### 🏆 Recommended Models Matrix
| Model Tier | Recommended Models | Local Provider | Best For |
| :--- | :--- | :--- | :--- |
| **Top 4B Choice** | `gemma-2-4b-it` / `gemma-2-4b` | LM Studio / Ollama | Sharp instruction following & clean command syntax |
| **Top 4B Code Alternative** | `Qwen2.5-Coder-3B-Instruct` / `Qwen2.5-4B` | LM Studio / Ollama | Accurate code patches & JSON tool syntax |
| **Optimal Balance (7B–9B)** | `Qwen2.5-Coder-7B-Instruct` / `Llama-3.1-8B-Instruct` | Ollama / LM Studio | Best overall speed, syntax accuracy, and edge reliability |
| **Advanced Local (14B+)** | `Qwen2.5-Coder-14B-Instruct` | LM Studio / Ollama | Complex multi-app fullstack projects |

---

## 🚀 Quick Start: Run on Your Local PC

Apne PC pe Vakra AI ko setup karke run karne ke liye ye simple steps follow karein:

### 1. Prerequisites
* **Node.js** (v18.0.0 or higher) & **npm**
* **VS Code** (v1.85.0 or higher)
* Ek local LLM runner: [Ollama](https://ollama.com/) ya [LM Studio](https://lmstudio.ai/)
  * Example with Ollama:
    ```bash
    ollama run gemma2:2b    # (Not recommended)
    ollama run gemma2:latest # (Recommended: gemma-2-4b-it / qwen2.5-coder:7b)
    ```

### 2. Clone the Repository
```bash
git clone https://github.com/kalpeshdrakshe555/vakra_control.git
cd vakra_control
```

### 3. Install Dependencies & Build
```bash
npm install
npm run compile
```

### 4. Launch in VS Code (Extension Development Host)
1. Is folder ko VS Code me open karein:
   ```bash
   code .
   ```
2. Press **`F5`** (ya sidebar me **Run and Debug** me ja kar **"Run Extension"** select karein).
3. Ek naya **Extension Development Host** window open ho jayega jisme Vakra AI sidebar active hoga!

### 5. Connect Your Model
1. Naye window me Activity Bar me **⚡ Vakra AI** icon pe click karein.
2. Sidebar ke bottom me **Settings (gear icon)** pe click karein.
3. Apna local model URL configure karein:
   * **API Base URL:** `http://localhost:11434/v1` (Ollama) ya `http://localhost:1234/v1` (LM Studio)
   * **API Key:** `lm-studio` ya `ollama` (koi bhi dummy string)
   * **Model ID:** Jo model aapne load kiya hai (e.g. `gemma-2-4b-it` ya `qwen2.5-coder:7b`)
4. Save karein aur prompt dekar test karna shuru karein!

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
│  • Researches verified docs via DuckDuckGo extraction & Framework Recipes               │
│  • Generates clean user roadmap in root PLAN.md                                         │
│  • Generates deep architectural specification in .ultra-light-ai/RESEARCH.md            │
│  • Displays dedicated UI Plan Approval Card: [✔ Approve & Proceed]                      │
│  • Pauses and awaits user authorization                                                 │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │ User Click / Direct Task
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                        Agent 2: Autonomous Executor & Developer                         │
│  • Pre-Execution Inspection: Checks directory tree & existing files before taking action │
│  • Reads .ultra-light-ai/RESEARCH.md for framework commands, package names & doc links  │
│  • Smart VirtualEnv Auto-Binding: Pre-binds .venv/Scripts to PATH for pip/python/CLI   │
│  • READ-THEN-ACTION Protocol: Prevents mindless file reading loops                      │
│  • File Operations: Surgical Search/Replace (edit_file) & full creation (write_file)    │
│  • Deterministic Integrity Gate: Validates INSTALLED_APPS, TEMPLATES.DIRS, syntax check │
│  • 1-Strike Web Search Gate: Intercepts library/syntax errors & retrieves latest docs   │
│  • Marks step complete in PLAN.md & concludes cleanly                                   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1. Clean File Placement Policy
* **`PLAN.md`:** Maintained directly in your workspace root so both you and the model see the human-readable roadmap.
* **`.ultra-light-ai/` Directory:** Internal metadata files (`PLAN.json`, `RESEARCH.md`, `STATE_LEDGER.md`, `SESSION_MEMORY.json`) reside strictly inside `.ultra-light-ai/`, keeping the workspace root pristine.

### 2. Pre-Execution Project & Directory Awareness
* Before taking action on any step, the model inspects the workspace directory structure via `list_directory_tree` to detect existing configurations and files, preventing conflicting app creation (e.g. `auth/` collisions) or redundant scaffolding.

### 3. Read-Then-Action Protocol
* Prevents small models from falling into mindless inspection loops. When code context is loaded, the model is directed to apply surgical edits immediately rather than repeatedly re-reading files.

### 4. Smart Virtual Environment Auto-Binding
* Automatically detects `.venv`, `venv`, or `env` in your workspace.
* Automatically prepends `.venv/Scripts` (Windows) or `.venv/bin` (macOS/Linux) to `PATH` in spawned processes.
* Commands like `python`, `pip`, and `django-admin` **always run inside your virtual environment** without requiring manual shell activation.

### 5. 1-Strike Web Search Gate (Post-2024 Knowledge Grounding)
* If a terminal command fails with a missing module, syntax error, or unfamiliar library, the system blocks blind guesswork edits and prompts the model to execute `search_web` for the exact error and library version first.

---

## 🧪 Verification & Test Suite

Vakra AI is strictly developed under the **Gravitas Reliability Runtime** framework (empirical proof, no fabricated claims, bounded retries).

Run the full test suite locally:
```bash
# Run 101 unit, contract, platform, and multi-agent workflow tests
npx mocha -u tdd -r ./out/test/suite/mockVscode.js "./out/test/suite/!(realModelBenchmark).test.js"

# Compile TypeScript
npx tsc -p .

# Build CSS and Webview bundles
npm run compile
```
> **Current Status:** 101/101 passing tests (100% pass rate).

---

## 🤝 Contributing & Bug Fixes

We warmly welcome community contributions! Here is how you can help:
1. **Fork the Repo** and create your branch (`git checkout -b feature/cool-enhancement` or `bugfix/fix-terminal-handling`).
2. Make your changes and write unit tests under `src/test/suite/`.
3. Ensure all tests pass: `npm test` or `npx mocha ...`.
4. Submit a **Pull Request (PR)** with a clear description of the bug and empirical verification output.

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.
