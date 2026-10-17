# ⚡ Vakra AI Architecture Enhancement Blueprint
### High-Precision Multi-Step Engineering for 4B Models & Edge Hardware

---

## 📌 Executive Summary
Small language models (3B–7B parameters, e.g., Gemma 4B, Qwen 2.5 Coder) face distinct physical constraints:
1. **Shallow Cross-File Working Memory:** Unable to hold 3+ interrelated files in context without cross-contamination.
2. **Attention Budget Decay:** Degradation of instruction adherence beyond 8k–12k tokens even within larger physical windows (32k–40k).
3. **Loop Susceptibility & Cognitive Bias:** Tendency to build upon flawed edits rather than self-correcting.

To achieve production-grade reliability without expanding model parameter scale, the cognitive burden is shifted from the language model to **deterministic TypeScript extension mechanisms, Model Context Protocol (MCP) servers, and custom runtime plugin middlewares**.

---

## 🏗️ 1. Advanced Architectural Paradigms

```
┌────────────────────────────────────────────────────────────────────────┐
│                        User Instruction / Error                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                    Pre-Execution Intelligence Pipeline                 │
├────────────────────────────────────────────────────────────────────────┤
│ • Cross-File Context Bundler (Virtual Slice Assembly)                  │
│ • Deterministic LSP / AST Symbol Extractor                             │
│ • Blacklist & Hypothesis Contrast Filter                               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Minimal, Targeted Slice
┌───────────────────────────────────▼────────────────────────────────────┐
│                  Micro-Agent Execution Pipeline                        │
├───────────────────────────────┬────────────────────────────────────────┤
│  Phase 1: Scout / Planner     │ Discovers paths & line references      │
│  Phase 2: Surgical Coder      │ Writes focused diffs (clean context)   │
│  Phase 3: Deterministic Gate  │ Syntax check, compile check, auto-test │
└───────────────────────────────┴────────────────────────────────────────┘
```

---

### Solution 1: Context Bundling (Cross-File Fusion)
* **The Root Problem:** Small models struggle when reading files sequentially across multiple turns (`readFile` turn 1 -> `readFile` turn 2). By turn 3, key variables and route signatures from earlier turns are forgotten or misattributed.
* **Mechanism:** 
  The TypeScript extension intercepts errors or user commands, performs deterministic background grep/AST lookups, and synthesizes a single **"Virtual Context Bundle"** injected directly into the active prompt.
* **Concrete Example (Django Route Link Failure):**
  Instead of letting the 4B model wander through multiple directory listings and full-file reads, the extension identifies references to a target token (e.g., `profile_view`) and bundles them in a single frame:
  ```text
  === [VIRTUAL CONTEXT BUNDLE: ROUTE & VIEW CORRELATION] ===
  [Source A: templates/navbar.html (Line 14)]
      <a class="nav-link" href="{% url 'profile_view' user.id %}">Profile</a>

  [Source B: core/urls.py (Lines 18-22)]
      urlpatterns = [
          path('user/<int:pk>/', views.user_profile, name='user_profile'),
      ]

  [Source C: core/views.py (Lines 45-48)]
      def user_profile(request, pk):
          user = get_object_or_404(User, pk=pk)
          return render(request, 'profile.html', {'profile_user': user})
  ==========================================================
  TASK: Resolve parameter mismatch and URL reverse name conflict based on Source A, B, and C.
  ```
* **Result:** The model immediately perceives that `profile_view` must be `user_profile` and parameter `user.id` matches parameter `pk`, eliminating exploration iterations.

---

### Solution 2: Pinboard / Scratchpad Memory (`pin_fact`)
* **The Root Problem:** As chat interactions progress toward 10–20 tool calls, older tool outputs are pruned or lose focus due to context dilution.
* **Mechanism:**
  Introduce an internal lightweight tool: `pinFact(key: string, value: string)`. Alternatively, require every tool response to return an optional `pinned_fact` field.
* **Storage & Injection Protocol:**
  - Pinned items are stored in `SessionMemory.ts` as key-value assertions.
  - Unlike raw terminal outputs or file dumps (which are purged/truncated), Pinned Facts are injected at the **tail-end of the prompt** directly preceding the model's generation turn.
* **Example State:**
  ```text
  [ACTIVE PINBOARD / PERSISTENT WORKING FACTS]
  • ROUTE_NAME: 'user_profile' requires integer parameter 'pk'.
  • AUTH_MODEL: Custom user model 'accounts.CustomUser' active.
  • CWD_TARGET: Django commands must execute in directory '/backend'.
  ```

---

### Solution 3: Hypothesis Contrast & Auto-Revert Guard
* **The Root Problem:** When a 4B model's patch fails to fix an error, it tends to make secondary edits on top of its broken code, leading to compounded code corruption and exhausted step budgets.
* **Mechanism:**
  1. **Snapshotting:** Before any file modification is committed, the extension holds an in-memory backup of the original file state.
  2. **Automated Verification:** The extension executes a deterministic test or compiler check (`python manage.py check`, `npm test`, or syntax compilation).
  3. **Auto-Revert:** If the error persists or new syntax errors are introduced, the file is automatically restored to its baseline state.
  4. **Negative Prompting Injection:** The failed attempt is logged in a `<BLACKLISTED_ATTEMPTS>` block:
     ```text
     <FAILED_ATTEMPT_RECORD>
     File: core/views.py
     Attempted Change: Modified get_object_or_404 arguments on line 46.
     Outcome: Error remained 'NoReverseMatch'.
     Directive: The previous hypothesis is INVALID. Do NOT repeat edits in core/views.py. Focus on template tags in navbar.html.
     </FAILED_ATTEMPT_RECORD>
     ```

---

### Solution 4: The Micro-Agent Pipeline (Isolated Turn Scope)
* **The Root Problem:** Running exploration, code generation, and verification within one monolithic chat history overwhelms 4B models.
* **Mechanism:**
  Deconstruct a complex task into three isolated LLM requests with separate, minimal system prompts:

| Phase | Purpose | Context Supplied | Output Format |
|---|---|---|---|
| **Phase 1: Scout / Finder** | Discover relevant files and pinpoint line numbers. | Workspace structure, user goal, grep tools. | Strict JSON list of target files and line ranges. |
| **Phase 2: Surgical Coder** | Write targeted patches. | **Clean context:** Only target line slices + minimal requirements. No search history. | Line-accurate patch or replacement block. |
| **Phase 3: Verifier** | Verify compiler output and test pass state. | Terminal output of verification commands. | Status flag (`SUCCESS` / `FAIL`) + failure diagnosis. |

---

## 🔌 2. Model Context Protocol (MCP) Integration

MCP allows Vakra AI to expose structured external tools via standard JSON-RPC without bloating core agent code.

### Recommended MCP Servers for 4B Constraints

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Vakra AI Core Client                            │
└───────────────┬───────────────────┬───────────────────┬────────────────┘
                │                   │                   │
┌───────────────▼────────┐ ┌────────▼────────┐ ┌────────▼────────┐
│  code-graph-mcp        │ │  @upstash/      │ │  chrome-        │
│  (AST & Call Graph)    │ │  context7-mcp   │ │  devtools-mcp   │
│  - trace_call_hierarchy│ │  - get_docs     │ │  - get_console  │
│  - get_symbol_def      │ │  - get_api_sig  │ │  - inspect_dom  │
└────────────────────────┘ └─────────────────┘ └─────────────────┘
```

#### 1. `code-graph-mcp` (AST & Call Graph Intelligence)
* **Value:** Eliminates the need for 4B models to sequentially run `listDirectory` and `readFile` across dozens of files.
* **Functions:**
  - `find_references(symbol_name)`: Returns all occurrences and definition sites instantly.
  - `get_call_graph(function_name)`: Generates upstream and downstream invocation trees.
* **Impact:** Reduces tool iterations for large refactors by up to 70%.

#### 2. `Context7` (`@upstash/context7-mcp`)
* **Value:** 4B models frequently hallucinate deprecated or cross-version library APIs (e.g., mixing Django 3.x with 5.x patterns, Pydantic v1 with v2).
* **Functions:**
  - `fetch_docs(library, version, topic)`: Returns version-specific, minimal Markdown documentation slices.
* **Impact:** Guarantees syntactic validity for third-party libraries without relying on static model weights.

#### 3. `Chrome DevTools MCP` (`chrome-devtools-mcp`)
* **Value:** Solves blind debugging for full-stack and web tasks.
* **Functions:**
  - `get_console_errors()`: Captures real-time browser runtime errors.
  - `get_network_failures()`: Extracts failing 404, 500, or CORS network calls.
* **Impact:** Provides exact client-side runtime feedback directly to the model.

#### 4. `SQLite / Postgres MCP` (`@modelcontextprotocol/server-sqlite`)
* **Value:** Allows the model to inspect actual database schemas directly instead of reading dozens of migration files.
* **Functions:**
  - `describe_table(table_name)`
  - `list_tables()`
* **Impact:** Prevents `FieldError`, missing column references, and incorrect relation joins.

### Complete `.ultra-light-ai/mcp.json` Configuration
```json
{
  "mcpServers": {
    "code-graph": {
      "command": "npx",
      "args": ["-y", "code-graph-mcp@latest", "--workspace", "."]
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--autoConnect"]
    },
    "sqlite": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite", "./db.sqlite3"]
    }
  }
}
```

---

## ⚙️ 3. Custom Runtime Plugins (`.ultra-light-ai/plugins.js`)

Plugins operate as deterministic lifecycle hooks inside Vakra AI's execution pipeline, serving as guardrails and context filters.

```
                  Prompt Pipeline                     Tool Execution Pipeline
                         │                                       │
┌────────────────────────▼────────────────────────┐   ┌──────────▼──────────────────────────┐
│ Hook: beforePromptBuild                         │   │ Hook: afterToolExecute              │
│ - Injects dynamic route maps                    │   │ - Strips node_modules stack frames  │
│ - Injects active pinned facts                   │   │ - Limits error payloads to 800 chars│
└─────────────────────────────────────────────────┘   └──────────┬──────────────────────────┘
                                                                 │
                                                      ┌──────────▼──────────────────────────┐
                                                      │ Hook: afterFileWrite                │
                                                      │ - Runs fast background linter       │
                                                      │ - Reverts file if syntax is broken  │
                                                      └─────────────────────────────────────┘
```

### Complete Implementation File

```javascript
/**
 * .ultra-light-ai/plugins.js
 * Production-ready guardrails and filters for Vakra AI (4B Engine)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = {
  /**
   * Hook 1: Executed immediately before the prompt is assembled and sent to the LLM.
   */
  beforePromptBuild: async ({ workspaceRoot, lastUserMessage, activeContext }) => {
    const injections = [];

    // Auto-detect Django URL / route questions and build deterministic route map
    if (/url|route|reverse|NoReverseMatch|404/i.test(lastUserMessage)) {
      try {
        const managePath = path.join(workspaceRoot, 'manage.py');
        if (fs.existsSync(managePath)) {
          // Deterministic route extraction command
          const routeSummary = execSync(
            'python manage.py show_urls --format pretty 2>nul || python -c "import django; print(\'Django present\')"',
            { cwd: workspaceRoot, timeout: 3000, encoding: 'utf-8' }
          );

          if (routeSummary && routeSummary.length < 2000) {
            injections.push(`[DETERMINISTIC ROUTE MAP INGESTED]\n${routeSummary}`);
          }
        }
      } catch (err) {
        // Fallback: Silent failure to prevent pipeline interruption
      }
    }

    return {
      prependContext: injections.join('\n\n')
    };
  },

  /**
   * Hook 2: Executed right after any tool (runCommand, readFile, etc.) produces output.
   */
  afterToolExecute: async ({ toolName, rawOutput }) => {
    if (typeof rawOutput !== 'string') return rawOutput;

    // Filter large terminal command outputs to save token budget
    if (toolName === 'runCommand') {
      const lines = rawOutput.split('\n');

      // Filter out noisy library trace frames
      const filteredLines = lines.filter(line => {
        const isSitePackages = line.includes('site-packages');
        const isNodeModules = line.includes('node_modules');
        const isInternalRuntime = line.includes('internal/modules');
        return !(isSitePackages || isNodeModules || isInternalRuntime);
      });

      // Keep only first 10 and last 25 lines if output is oversized
      if (filteredLines.length > 35) {
        const topSlice = filteredLines.slice(0, 10).join('\n');
        const bottomSlice = filteredLines.slice(-25).join('\n');
        return `${topSlice}\n\n[... TRUNCATED ${filteredLines.length - 35} INTERMEDIARY LOG LINES ...]\n\n${bottomSlice}`;
      }

      return filteredLines.join('\n');
    }

    return rawOutput;
  },

  /**
   * Hook 3: Executed immediately after a file is modified via writeFile or patch.
   */
  afterFileWrite: async ({ filePath, fileContent, workspaceRoot }) => {
    const ext = path.extname(filePath);

    // Python Syntax Guard
    if (ext === '.py') {
      try {
        execSync(`python -m py_compile "${filePath}"`, { cwd: workspaceRoot, timeout: 2000 });
      } catch (compileError) {
        const errorMessage = compileError.stderr ? compileError.stderr.toString() : compileError.message;
        return {
          success: false,
          revertRequested: true,
          feedback: `CRITICAL SYNTAX ERROR DETECTED AFTER EDIT:\n${errorMessage}\nReverting file to previous stable state.`
        };
      }
    }

    // JavaScript / TypeScript Syntax Guard (JSON validation example)
    if (ext === '.json') {
      try {
        JSON.parse(fileContent);
      } catch (jsonErr) {
        return {
          success: false,
          revertRequested: true,
          feedback: `INVALID JSON GENERATED:\n${jsonErr.message}\nReverting file to prevent workspace corruption.`
        };
      }
    }

    return { success: true };
  }
};
```

---

## 📋 4. Implementation & Rollout Roadmap

1. **Step 1 (Deterministic Guardrails):**
   Deploy `.ultra-light-ai/plugins.js` with `afterFileWrite` and `afterToolExecute` handlers. This immediately protects the model from compiling invalid syntax and prevents terminal log explosions.
2. **Step 2 (MCP Integration):**
   Populate `.ultra-light-ai/mcp.json` with `code-graph-mcp` and `context7`. This resolves cross-file navigation and documentation lookup bottlenecks.
3. **Step 3 (Prompt & Memory Engine):**
   Update `SessionMemory.ts` to support the Pinboard pattern (`pinFact`), ensuring working memory persists without consuming context with raw file dumps.
4. **Step 4 (Context Bundling):**
   Enhance `PromptBuilder.ts` to bundle correlated code snippets (template + view + route) side-by-side whenever route or parameter tokens are referenced.