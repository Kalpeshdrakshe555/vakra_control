# 🐛 Ultra Light AI — Full Bug & Issue Report

> Deep scan of the entire codebase. Categorized by severity.

---

## 🔴 CRITICAL BUGS (Will Crash or Break Features)

### 1. URL Construction Bug — API Calls Will Fail (realClients.ts:261)
The `completeWithHistory` streaming URL uses `&key=` but the non-streaming path uses `?key=`. When `stream=false`, the URL becomes:
```
.../generateContent&key=xxx   ← BROKEN (missing ?)
```
**File:** [realClients.ts](file:///d:/office/vs__code_code_extension/src/router/realClients.ts#L261)
```diff
- const url = `.../${this.model}:${endpoint}&key=${apiKey}`;
+ const url = `.../${this.model}:${endpoint}${stream ? '&' : '?'}key=${apiKey}`;
```
**Impact:** Non-streaming `completeWithHistory` calls (fallback chat) will get a 400/404 error from Google API.

---

### 2. `buildPrompt` Signature Mismatch (sidebarProvider.ts:144 vs 286)
The non-streaming `handleChatMessage` calls `buildPrompt` with **3 arguments**:
```typescript
buildPrompt(text, includeActiveFile, workspaceRoot)   // Line 144
```
But the function signature expects **4 arguments**:
```typescript
buildPrompt(text, includeActiveFile, includeWebSearch, workspaceRoot)  // Line 286
```
So `workspaceRoot` is being passed as `includeWebSearch` (a boolean slot receives a string), and the real `workspaceRoot` becomes `undefined`.

**File:** [sidebarProvider.ts](file:///d:/office/vs__code_code_extension/src/webview/sidebarProvider.ts#L144)
```diff
- let finalPrompt = await this.buildPrompt(text, includeActiveFile, workspaceRoot);
+ let finalPrompt = await this.buildPrompt(text, includeActiveFile, false, workspaceRoot);
```
**Impact:** Non-streaming chat will fail to resolve `@file` paths and will accidentally trigger web search with the workspace path as a query string.

---

### 3. Hardcoded API Key Exposed in Source Code (config.ts:106 & 207)
```typescript
return ["AIzaSy[REDACTED]"];  // Line 106
apiKey: "AIzaSy[REDACTED]",   // Line 207
```
**File:** [config.ts](file:///d:/office/vs__code_code_extension/src/config.ts#L106)

**Impact:** If published to marketplace or GitHub, this API key will be publicly visible, abused, and banned by Google. **Must be removed before publishing.**

---

### 4. Conversation History Lost on Reload (sidebarProvider.ts:11)
```typescript
private conversationHistory = new ConversationHistory(20);
```
History is stored **only in memory** (a plain JS array). When the user:
- Closes the sidebar panel
- Reloads the window
- Restarts VS Code

**All chat history is permanently lost.** There is no persistence to disk or `globalState`.

**File:** [sidebarProvider.ts](file:///d:/office/vs__code_code_extension/src/webview/sidebarProvider.ts#L11)

**Fix:** Serialize `messages[]` to `context.globalState` or a workspace `.chat-history.json` file on every `addMessage()`, and restore on `resolveWebviewView()`.

---

## 🟠 HIGH SEVERITY BUGS

### 5. Duplicate Model Option in UI (ui.html:210-213)
```html
<option value="gemma-4-31b-it">gemma-4-31b-it</option>   <!-- Line 210 -->
<option value="gemini-1.5-pro">gemini-1.5-pro</option>
<option value="gemini-2.0-flash">gemini-2.0-flash</option>
<option value="gemma-4-31b-it">gemma-4-31b-it</option>   <!-- Line 213 DUPLICATE -->
```
**File:** [ui.html](file:///d:/office/vs__code_code_extension/src/webview/ui.html#L210)

**Impact:** Confusing UX. User sees the same model listed twice.

---

### 6. Drag & Drop Overlay Blocks Interaction (ui.html:64)
```html
<div id="drop-overlay" class="... pointer-events-none ...">
```
The overlay has `pointer-events-none`, which means when it becomes visible during a drag, the user **cannot actually drop** onto it because pointer events are disabled. The `drop` event fires on the `window`, but the visible overlay might interfere with certain browsers/webviews.

**File:** [ui.html](file:///d:/office/vs__code_code_extension/src/webview/ui.html#L64)

---

### 7. `extractFiles` Regex Fails with Search/Replace Blocks (ui.html:603)
The new AI system instruction tells the model to output `<<<<<<< SEARCH` / `>>>>>>> REPLACE` blocks. But the UI's `extractFiles()` function doesn't understand this format — it will extract the raw SEARCH/REPLACE markers as file content and show broken "Apply" buttons.

**File:** [ui.html](file:///d:/office/vs__code_code_extension/src/webview/ui.html#L599)

**Fix:** `extractFiles()` should strip out `<<<<<<< SEARCH`, `=======`, and `>>>>>>> REPLACE` markers, or detect them and pass them through as-is (the backend handles them).

---

### 8. Memory Leak: CSS `<style>` Tag Injected Per Message (ui.html:648-660)
```javascript
const style = document.createElement('style');
style.textContent = `...`;
document.head.appendChild(style);   // Called EVERY time appendAiMessage runs
```
Every AI response appends a **new identical `<style>` element** to `<head>`. After 50 messages, there will be 50 duplicate style blocks.

**File:** [ui.html](file:///d:/office/vs__code_code_extension/src/webview/ui.html#L648)

**Fix:** Move the style to the static `<style>` block in `<head>`, or add it once with an ID check.

---

### 9. Rollback Only Reverts Chat, Not Code Changes
The `rollbackChat` function in sidebarProvider only calls `conversationHistory.rollbackToTimestamp()` which trims the message array. It does **not** undo any file changes that were applied via `applyWorkspaceEdits`.

**File:** [sidebarProvider.ts](file:///d:/office/vs__code_code_extension/src/webview/sidebarProvider.ts#L101)

**Impact:** User clicks ⏪ expecting code to revert, but only the chat messages disappear. The files remain modified.

---

### 10. Sandbox Bypass — Easy to Circumvent (sidebarProvider.ts:613-616)
```typescript
const dangerousPatterns = [
    'rm -rf', 'del /f', 'format ', 'diskpart', 
    'rmdir /s', 'mkfs', 'dd if=', 'shutdown', 
    'C:\\Windows', 'C:\\\\'
];
```
This blocklist can be trivially bypassed:
- `rm  -rf` (extra space)
- `r""m -rf` (shell quoting tricks)
- `powershell -c "Remove-Item -Recurse"` (not in the list)
- `cmd /c del` (not in the list)

**File:** [sidebarProvider.ts](file:///d:/office/vs__code_code_extension/src/webview/sidebarProvider.ts#L613)

---

## 🟡 MEDIUM SEVERITY ISSUES

### 11. CDN Dependencies Load in Webview (ui.html:8, 28-31)
```html
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
```
VS Code webviews have a **Content Security Policy (CSP)** that blocks external scripts by default. These CDN loads will silently fail in production builds, causing:
- No Tailwind CSS → broken layout
- No Marked.js → raw markdown displayed
- No Highlight.js → no syntax highlighting

**Fix:** Bundle these libraries locally via npm and reference them with `webview.asWebviewUri()`.

---

### 12. `@workspace` Sends Only File Names, Not Contents
The workspace scan only sends the file tree (names), not the actual file contents:
```typescript
contextParts.push(`Workspace Structure (${fileList.length} files):\n${fileList.join('\n')}`);
```
For a true "bird's eye view", the AI can see file names but **cannot read any code**. It needs at least key file snippets (e.g., first 50 lines of entry files).

**File:** [sidebarProvider.ts](file:///d:/office/vs__code_code_extension/src/webview/sidebarProvider.ts#L377)

---

### 13. `gemini-1.5-flash` Missing from Model Dropdown but Present in Validation
The settings validator checks for `gemini-1.5-flash` (line 387 in ui.html) but the dropdown doesn't include it. Conversely, `gemma-4-31b-it` appears twice.

---

### 14. `marked.setOptions` Called Inside Loop (ui.html:633)
`marked.setOptions()` with the `highlight` callback is called inside `appendAiMessage()`, meaning it runs on **every single AI message**. This is wasteful — it should be configured once at initialization.

---

### 15. No Error Boundary on Stream Abort
When the user clicks "Stop" during streaming, `currentStreamAbortController.abort()` fires, but the UI's `currentStreamText` might contain a partial/broken markdown block (e.g., an unclosed ` ``` `). This causes `marked.parse()` to produce broken HTML.

---

## 🔵 LOW SEVERITY / POLISH

| # | Issue | File | Description |
|---|-------|------|-------------|
| 16 | No `.agent-config.json` in `.gitignore` | Root | API keys will be committed to git |
| 17 | `historyLength` default is `2` | config.ts:213 | Only 2 turns of context = very poor multi-turn understanding |
| 18 | Tailwind CDN in production | ui.html:8 | Should use pre-built CSS for marketplace release |
| 19 | No loading state for web search | ui.html | User sees no feedback while DuckDuckGo query runs |
| 20 | `applyDiff` in diffPatcher.ts uses `fs.writeFileSync` | diffPatcher.ts:18 | Bypasses VS Code undo stack (old code path, may still be called) |
| 21 | No token count display during streaming | ui.html | Tokens only show after stream completes |
| 22 | Debug dump still active | ui.html:500-506 | `[DEBUG DROP: ...]` will appear for users in production |

---

## 📊 Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 4 |
| 🟠 High | 6 |
| 🟡 Medium | 5 |
| 🔵 Low/Polish | 7 |
| **Total** | **22** |

---

## 🎯 Recommended Fix Priority

1. **Fix URL bug** (Bug #1) — 1 character fix, prevents all non-streaming calls from crashing
2. **Fix `buildPrompt` signature** (Bug #2) — 1 line fix, prevents fallback chat from breaking
3. **Remove hardcoded API key** (Bug #3) — Security critical before publish
4. **Add chat persistence** (Bug #4) — Core UX feature users expect
5. **Fix `extractFiles` for S&R blocks** (Bug #7) — Otherwise the new patching architecture's Apply buttons won't work
6. **Bundle CDN deps locally** (Bug #11) — Without this, the entire UI breaks in production
7. **Remove debug dump** (Bug #22) — Quick cleanup before any user testing
