# Ultra Light AI - Comprehensive Architecture & Features Spec

This document details the advanced, "Cursor-level" agentic features implemented in the Ultra Light AI VS Code extension. It covers the logic, use-cases, and constraints considered during development.

---

## 1. Multi-Agent Orchestration (Architect -> Coder Pipeline)
**Use Case:** Building complex features or entire applications from a single prompt without hitting API limits or causing context fragmentation.
**Implementation Logic:**
- **UI:** A `🏢 Architect` toggle in the chat footer.
- **Phase 1 (The Architect):** Instead of generating code, the AI is prompted to act as an Architect. It generates a strict **JSON Blueprint** containing a list of files to create/modify, the tasks for each file, and an `injected_knowledge` field.
- **Phase 2 (Knowledge Map-Reduce):** If the Architect reads a 5,000-word webpage via `@search` or RAG, it extracts ONLY the relevant snippets and places them in `injected_knowledge`. This prevents sending massive context to downstream agents.
- **Phase 3 (The Queue Manager):** The extension parses the JSON and spawns `SequentialOperator` to handle the tasks asynchronously.
- **Phase 4 (Coder Agents):** For each task, a fresh "Coder Agent" is spawned. It receives the task description, the injected knowledge, and the current file contents. It returns a Diff patch.
**Constraints Handled:**
- **RPM & Rate Limits:** A 3-second cooldown (`await new Promise(r => setTimeout(r, 3000))`) is hardcoded between Coder Agents to avoid hitting Gemini's 15 RPM limit.
- **Hardware (RAM/PC Freezing):** Processing sequentially (rather than parallel) ensures Local Ollama models do not crash the user's PC by maxing out VRAM.
- **Context Window:** Coder agents only get the context relevant to their specific file, saving thousands of tokens per run.

---

## 2. Autonomous Agentic Loop (Devin Mode)
**Use Case:** Allowing the AI to autonomously write code, run terminal commands to test the code, read the output, and fix any resulting errors in a self-healing loop.
**Implementation Logic:**
- **UI:** A `🤖 Agent Mode` toggle.
- **Logic:** The AI is instructed to output commands inside `<run_command>...</run_command>` blocks.
- If Agent Mode is ON, the `sidebarProvider` immediately executes the command using `child_process.exec` (with the workspace as `cwd`). 
- It captures `stdout` and `stderr`, formats it, and automatically triggers `injectChatAndSend` to feed the output back to the AI without requiring user intervention.
**Constraints Handled:**
- **Infinite Loops/Zombie Processes:** A strict 30-second execution timeout is enforced on all terminal commands.
- **Safety:** The user must explicitly opt-in via the toggle; otherwise, the extension waits for the user to manually click "Run Command".

---

## 3. Native Codebase Context (AST / LSP Integration)
**Use Case:** Providing the AI with exact, "Go-to-Definition" codebase awareness without relying purely on text search (BM25).
**Implementation Logic:**
- Intercepts the user's prompt and extracts potential CamelCase/PascalCase symbols (e.g., `UserService`, `fetchData`).
- Passes these symbols to VS Code's native Language Server Protocol API (`vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', symbol)`).
- Retrieves the exact file URI and line numbers of the symbol definitions.
- Extracts ~40 lines of surrounding code and injects it into the prompt context.
**Constraints Handled:**
- **Token Bloat:** We strictly limit the extraction to the top 2 symbols and slice only the surrounding lines instead of injecting the entire file.

---

## 4. Composer (Multi-File Preview Diff)
**Use Case:** Letting the user safely review massive multi-file changes before they are committed to the disk.
**Implementation Logic:**
- Adds an `👁️ Preview` button next to the generated file changes in the chat UI.
- When clicked, it applies the AI's search/replace patch to the original code in memory.
- It saves both the original and the newly patched code to temporary files via `os.tmpdir()`.
- Triggers `vscode.commands.executeCommand('vscode.diff')` to open a Git-style split diff natively in VS Code.
**Constraints Handled:**
- Prevents destructive, unrecoverable file modifications by giving the user a visual checkpoint.

---

## 5. Terminal Error Auto-Catch
**Use Case:** Instantly debugging compilation errors or failed test suites without manually copy-pasting the terminal output.
**Implementation Logic:**
- Exposes a new command `ultra-light-ai.fixTerminalError`.
- Emulates keypresses natively (`workbench.action.terminal.selectAll` -> `copySelection`).
- Reads the clipboard text, slices the last 60 lines (where the error stack trace resides), and instantly injects it into the AI chat box for resolution.
**Constraints Handled:**
- Avoids undocumented/proposed VS Code Extension APIs by using reliable clipboard and command palette macros with a safety `300ms` delay to allow asynchronous clipboard operations to resolve.

---

## 6. Ctrl+K (Inline Edit)
**Use Case:** Quick, surgical edits on a specific block of code without needing to open the chat sidebar.
**Implementation Logic:**
- Registered as `ultra-light-ai.inlineEdit`.
- Grabs `editor.document.getText(editor.selection)` and prompts the LLM to return ONLY the raw replacement code.
- Uses standard VS Code `WorkspaceEdit` builders to replace the active selection.
**Constraints Handled:**
- Ensures Markdown syntax blocks (e.g., \`\`\`javascript) returned by the LLM are aggressively stripped out before the text is injected into the code file.

---

## 7. Chat Rollback & File-System Reversion
**Use Case:** If the AI hallucinates and ruins 5 files, the user needs a way to undo everything with a single click.
**Implementation Logic:**
- Every time a file is modified via the UI, a snapshot of its *pre-modification* state is stored in `fileBackups` inside the `ChatMessage` object in `conversationHistory.ts`.
- When the user clicks "Rewind" in the chat, the system iterates through the deleted chat history, pulls the `fileBackups`, and writes the original content back to the disk.
**Constraints Handled:**
- Atomicity: It ensures both the chat context memory and the physical file system are reverted simultaneously, keeping the RAG engine and file state perfectly in sync.

---

## 8. `.agentrules` Support
**Use Case:** Ensuring the AI follows the specific architectural guidelines, naming conventions, and linting rules of a particular project.
**Implementation Logic:**
- Checks the root directory (`workspaceRoot`) for `.agentrules` or `.cursorrules`.
- If found, reads the content and invisibly prepends it to the `systemInstruction` of every API call.
**Constraints Handled:**
- Prevents the user from having to copy-paste their standard operating procedures (SOP) into every chat prompt.

---

## Core Operational Constraints Guiding the System
1. **Zero-Dependency Core:** Everything is built using pure VS Code APIs and `child_process`. No heavy npm modules (React, Vue, Cheerio) are used to maintain a sub-100MB memory footprint.
2. **Robust Fallbacks:** Local Ollama support is treated as a first-class citizen, ensuring all orchestration features work fully offline, pacing requests so local hardware isn't overwhelmed.
3. **Patcher Resiliency:** The 5-Tier Leniency Algorithm in `diffPatcher.ts` ensures that even if the AI hallucinates indentation or minor syntax spacing, the patch still applies securely.
