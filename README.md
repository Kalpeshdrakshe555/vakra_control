<div align="center">
  <img src="icon.png" width="100" height="100" alt="Ultra Light AI Logo" />
  <h1>🚀 Ultra Light AI</h1>
  <p><strong>The High-Performance, Token-Efficient Autonomous AI Coding Assistant for VS Code.</strong></p>
  <p><em>Engineered from the ground up to empower local small models (3B–7B parameters, 40k context) and cloud frontier models alike with Cursor-level autonomy.</em></p>

  <p>
    <a href="#-key-highlights">Highlights</a> •
    <a href="#-architecture--innovations">Architecture</a> •
    <a href="#-local-model-vision--setup">Local & Vision Setup</a> •
    <a href="#-skills-system">Skills System</a> •
    <a href="#-configuration--settings">Settings</a> •
    <a href="#-documentation">Deep Dive Logic</a>
  </p>
</div>

---

## 🌟 Key Highlights

- **⚡ Tailored for Small Models & Tight Contexts (4B / 40k Window):**  
  Unlike generic AI tools that collapse without 128k–200k tokens, Ultra Light AI is mathematically optimized to keep 3B–7B local models (e.g. Gemma 4B, Qwen 2.5 Coder, Llama 3.2) sharp, coherent, and loop-free within a strict 32k–40k context budget.
- **🔄 Autonomous Self-Healing Tool Loop:**  
  Executes file operations, terminal commands, directory explorations, and code modifications in a continuous execution cycle. Automatically captures compiler/runtime errors and self-corrects without manual prompt pasting.
- **🧠 Zero-Bloat Session Memory & Anti-Reread Heuristics:**  
  Maintains symbol-level footprints of visited files. Prevents the AI from repeatedly reading the same files, eliminating infinite loops and saving up to 75% of context window tokens.
- **🎯 Dynamic Workspace Skills Engine:**  
  Drop declarative skill protocols into `.ultra-light-ai/skills/<name>/SKILL.md`. Features built-in safety rules, strict checklist enforcement, and automated conflict resolution.
- **💻 Intelligent CWD & Terminal Auto-Routing:**  
  Automatically identifies the correct working directory for framework-specific commands (e.g. searching for `manage.py`, `package.json`, or nested project folders) before running terminal tasks.
- **👁️ Multimodal Vision Support:**  
  Feed UI screenshots, design mockups, or bug captures directly into the chat. Seamlessly works with local vision projectors (`--mmproj`) in `llama-server` or cloud multimodal vision endpoints.
- **🔌 Extensible MCP & Plugins Engine:**  
  One-click configuration for Model Context Protocol servers (`mcp.json`) and custom runtime JavaScript automation scripts (`plugins.js`).
- **🛡️ 100% Offline & Private Capability:**  
  Direct, native integration with local backends (`llama-server`, `Ollama`, `LM Studio`, `vLLM`) via OpenAI-compatible endpoints, keeping proprietary code strictly on your machine.

---

## 📐 Architecture & Core Innovations

```
┌────────────────────────────────────────────────────────────────────────┐
│                        VS Code Webview UI                              │
│         (Streaming Thoughts • Tool Cards • History • Settings)         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Webview Message Dispatcher
┌───────────────────────────────────▼────────────────────────────────────┐
│                    SidebarProvider & Engine Router                     │
├───────────────────────────────────┬────────────────────────────────────┤
│  PromptBuilder & Classifier       │  ToolDispatcher (Autonomous Loop)  │
│  - System Prompt & Framework Rules │  - readFile / writeFile / patch    │
│  - Micro AST Repo-Map (LSP)       │  - runCommand & Smart CWD Routing  │
│  - Session Memory Ingestion       │  - listDirectory / searchCodebase  │
│  - Active Skill Instructions      │  - webSearch & Doc Distiller       │
└─────────────────┬─────────────────┴──────────────────┬─────────────────┘
                  │                                    │
┌─────────────────▼─────────────────┐┌─────────────────▼─────────────────┐
│     Session & Context Memory      ││     Skills & Extensibility        │
│  - SessionMemory (Visited Cache)  ││  - Custom Workspace Skills        │
│  - ConversationHistory (Persist)  ││  - Built-in Safety Skills         │
│  - AST Skeletonizer (Code Slices) ││  - MCP Client & Plugin Hooks      │
└───────────────────────────────────┘└───────────────────────────────────┘
```

### 1. The Anti-Reread & Session Memory Engine
In small models, reading entire source files repeatedly exhausts the token budget and triggers repetitive loops. Ultra Light AI intercepts every `readFile` call and stores:
- File paths visited in the current session.
- Extracted top-level symbols (functions, classes, interfaces).
- Import signatures and line counts.  
When the model considers re-reading a known file, the prompt injects a concise cached summary, allowing the model to write precise patches without wasting context.

### 2. Turn-to-Turn State Continuity
When an autonomous tool loop finishes a turn (or hits the user-defined step limit), the system captures the execution summary—which files were edited, which tests were run, and what errors occurred—and embeds it into the next turn as an immutable `[PREVIOUS TURN EXECUTION RECORD]`. The agent never "forgets" what it just completed.

### 3. Smart Terminal Auto-Routing (CWD Heuristics)
Small models often execute commands in the workspace root instead of the nested subfolder where `manage.py` or `package.json` resides. The extension inspects commands prior to execution, resolves the true path of project anchors, and seamlessly directs the command to the target folder.

---

## 🖥️ Local Model & Vision Setup

Ultra Light AI is tested and optimized for local inference backends such as `llama-server` (llama.cpp) and `Ollama`.

### Running with a 4B Model + Multimodal Vision (Gemma / Qwen)

Launch `llama-server` with your base model and multimodal vision projector:

```powershell
& "D:\llama_coo\llama-server.exe" `
  -m "D:\models\gemma-4-E4B-it-Q4_K_M.gguf" `
  --mmproj "D:\models\mmproj-F16.gguf" `
  -ngl 99 `
  -c 40000 `
  -fa on `
  --context-shift `
  --cache-reuse 256 `
  --host 127.0.0.1 `
  --port 8083
```

In Ultra Light AI Settings (⚙️ icon in the sidebar):
1. **API Provider:** `Local (llama-server / Ollama / OpenAI Compatible)`
2. **Base URL:** `http://127.0.0.1:8083/v1`
3. **Model Name:** Enter your model tag (or leave as default)
4. **Max Steps / Turn:** Set according to your workflow (e.g. `20`–`35` for full-stack tasks)

---

## 🎯 Workspace Skills System

Skills provide modular, domain-specific intelligence without modifying system prompts.

### Directory Structure
```
your-project/
└── .ultra-light-ai/
    └── skills/
        └── my-django-skill/
            └── SKILL.md
```

### SKILL.md Specification
```markdown
---
name: "django-fullstack"
description: "Production-ready Django & DRF architecture with strict checklist enforcement"
trigger_rules: ["django", "manage.py", "drf", "rest_framework"]
---

## Django Protocol Checklist:
1. Always verify existing directory layout before running startproject.
2. Root project folder and app folder MUST have distinct names.
3. Register every new app immediately in INSTALLED_APPS.
4. Execute `python manage.py check` before declaring task complete.
```

### Automatic Conflict Resolution
- **Custom Overrides Built-in:** If you create a custom skill that triggers for `django`, any system-level fallback skill is **automatically suppressed**.
- **Transparent UI Indicators:** The sidebar dynamically displays active skills with color-coded badges:
  - `📁 Custom: .ultra-light-ai/skills/...` (Emerald)
  - `⚙️ Built-in System Skill` (Amber)
  - `📋 Enforcing Checklist` (Active verification protocol)

---

## ⚙️ Configuration & Key Settings

Access the Settings panel via the ⚙️ icon in the sidebar:

| Setting | Description | Default |
|---|---|---|
| **API Provider** | Gemini, Claude, OpenAI, DeepSeek, Groq, OpenRouter, Local | `Local` |
| **Model Name** | Identifier of the active language model | `gemma-4-E4B-it` |
| **Max Steps / Turn** | Maximum autonomous tool iterations per conversational turn | `25` |
| **Context Limit** | Target token window boundary (e.g. 32000, 40000) | `40000` |
| **Thinking Budget** | Reasoning token allocation for reasoning models | `1024` |
| **MCP Config** | Opens `.ultra-light-ai/mcp.json` to attach external MCP tools | Click to Open |
| **Plugins Script** | Opens `.ultra-light-ai/plugins.js` for custom JS runtime hooks | Click to Open |

---

## ⌨️ Shortcuts & Commands

| Shortcut / Command | Action |
|---|---|
| `Ctrl+Shift+P` → `Ultra Light AI: Open Chat` | Opens the assistant sidebar |
| `Ctrl+Shift+P` → `Ultra Light AI: New Chat` | Starts a fresh session with clean context |
| `Ctrl+Shift+P` → `Ultra Light AI: AI Quick Fix` | Analyzes and fixes current editor diagnostics |
| `Ctrl+K` (Inline Edit) | Surgically refactors selected code directly in the editor |
| Terminal Context Menu → `Fix Terminal Error` | Ingests last 60 terminal lines for instant debugging |

---

## 📚 Technical Documentation

For an in-depth breakdown of the internal algorithms, token budget allocations, AST skeletonization, and state machine mechanics, consult:
👉 **[project_logic.md](project_logic.md)**

---

## 📄 License

Ultra Light AI is licensed under the MIT License. Built with passion for high-performance, autonomous, local-first developer tooling.
