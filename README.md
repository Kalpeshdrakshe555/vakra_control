<div align="center">
  <img src="icon.png" width="100" height="100" alt="Vakra AI Logo" />
  <h1>⚡ Vakra AI</h1>
  <p><strong>The Autonomous, High-Precision AI Coding Agent Tailored for 4B Models & Edge Hardware.</strong></p>
  <p><em>Engineered from the ground up to empower small local models (3B–7B parameters, 40k context) and frontier LLMs alike with Cursor-level autonomy, full-duplex voice, and deterministic self-healing.</em></p>

  <p>
    <a href="#-key-highlights">Highlights</a> •
    <a href="#-architecture--innovations">Architecture</a> •
    <a href="#-production-features">Features</a> •
    <a href="#-local-model--vision-setup">Local Setup</a> •
    <a href="#-skills-system">Skills System</a> •
    <a href="#-configuration--settings">Settings</a> •
    <a href="#-deep-dive-logic">Project Logic</a>
  </p>
</div>

---

## 🌟 Key Highlights

- **⚡ Tailored for Small Models & Tight Contexts (4B / 40k Window):**  
  Unlike generic AI tools that collapse without 128k–200k tokens, **Vakra AI** is mathematically optimized to keep 3B–7B local models (e.g. Gemma 4B, Qwen 2.5 Coder, Llama 3.2) sharp, coherent, and loop-free within a strict 32k–40k context budget.
- **🎙️ Full-Duplex Real-Time Voice Assistant:**  
  Built with dynamic energy threshold gating (0.015 idle / 0.075 speaking), instant barge-in interruption (<500ms), 850ms trailing silence auto-submit, Whisper STT, and Kokoro-82M / Edge TTS speech synthesis.
- **🌐 Deep Web Search & Verified Dual-Layer Citations:**  
  Searches DuckDuckGo and deep-fetches 7,000+ characters of rich context per authoritative website. Strictly enforces inline citations `[[1]](url)` and a dedicated `### 🌐 Sources & References` markdown section with one-click external browser opening.
- **⏪ Granular Rollback & File Recovery Modal:**  
  Interactive rollback modal showing exact line deltas (`+X / -Y lines`) across every modified or created file. Reverts workspace files to their exact pre-prompt state with zero manual git stashing.
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
- **📊 Real-Time Three-Tier Token Meter:**  
  Live visual breakdown displaying **Input Tokens**, **Output Tokens**, and **Active Context Window %** so developers always know their exact consumption and billing.
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
In small models, reading entire source files repeatedly exhausts the token budget and triggers repetitive loops. Vakra AI intercepts every `readFile` call and stores:
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

Vakra AI is tested and optimized for local inference backends such as `llama-server` (llama.cpp) and `Ollama`.

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

In Vakra AI Settings (⚙️ icon in the sidebar):
1. **API Provider:** `Local (llama-server / Ollama / OpenAI Compatible)`
2. **Base URL:** `http://127.0.0.1:8083/v1`
3. **Model Name:** Enter your model tag (e.g. `gemma-4-31b-it` or `gemma-4-E4B-it`)
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
| **Model Name** | Identifier of the active language model | `gemma-4-31b-it` |
| **Max Steps / Turn** | Maximum autonomous tool iterations per conversational turn | `25` |
| **Context Limit** | Target token window boundary (e.g. 32000, 40000) | `40000` |
| **Voice STT / TTS** | Browser Web Speech, local Whisper, Kokoro-82M, Edge TTS | `Browser` |
| **MCP Config** | Opens `.ultra-light-ai/mcp.json` to attach external MCP tools | Click to Open |
| **Plugins Script** | Opens `.ultra-light-ai/plugins.js` for custom JS runtime hooks | Click to Open |

---

## ⌨️ Shortcuts & Commands

| Shortcut / Command | Action |
|---|---|
| `Ctrl+Shift+P` → `Vakra AI: Open Chat` | Opens the assistant sidebar |
| `Ctrl+Shift+P` → `Vakra AI: New Chat` | Starts a fresh session with clean context |
| `Ctrl+Shift+P` → `Vakra AI: AI Quick Fix` | Analyzes and fixes current editor diagnostics |
| `Ctrl+K` (Inline Edit) | Surgically refactors selected code directly in the editor |
| Terminal Context Menu → `Fix Terminal Error` | Ingests last 60 terminal lines for instant debugging |

---

## 📚 Deep Dive Logic

For an in-depth breakdown of the internal algorithms, token budget allocations, AST skeletonization, and state machine mechanics, consult:
👉 **[project_logic.md](project_logic.md)**

---

## 📄 License

Vakra AI is licensed under the MIT License. Built with passion for high-performance, autonomous, local-first developer tooling.
