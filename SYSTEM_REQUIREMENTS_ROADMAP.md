# 🚀 Ultra Light AI — System Upgrade & Master Requirements Specification

Yeh document humare project ke saare core issues, architecture improvements, aur next-gen Copilot features ka single source of truth hai. Requirement freeze hone ke baad hum ise step-by-step implement karenge.

---

## 📌 Phase 1: Core User Problems & Architectural Bottlenecks (Critical Fixes)

### 1. Architect Mode Failure & Chat Clutter (Professional UX) — [COMPLETED & VERIFIED ✅]
- **Problem**:
  - Architect mode me bada code generate hote hi prompt token context explode ho jata hai ya model beech me output cut kar deta hai.
  - Saara raw code chat message ke andar dump ho jata hai, jisse chat bohot messy aur unprofessional lagti hai.
- **Solution Implemented**:
  - **Clean Architectural Prompt Flow**: Model ko strictly instruct kiya gaya hai ki step 1 me blueprint de bina raw code dump ke, step 2 me terminal scaffold de, aur files generation turn-by-turn max 2 files me kare.
  - **Modified Files Artifact Card**: Chat window me raw code ki jagah sleek **"Modified Files" Card** dikhta hai with:
    - File icon, file name, relative path
    - `[ 👁️ Diff ]` button: Side-by-side native VS Code diff preview
    - `[ ⚡ Apply ]` button: Instant atomic workspace edit
    - `[ ✕ ]` reject & `[ ↩️ Undo ]` rollback options
    - Collapsible code payload drawer (`View code payload (X lines) ▾`) taaki chat clean rahe
    - `[ ✨ APPLY ALL FILES ]` multi-file batch button

### 2. Collapsible Thinking Accordion (`<think>`) — [COMPLETED & VERIFIED ✅]
- **Problem**:
  - Thinking process ya toh gayab ho jati hai ya chat ka layout kharab karti hai.
- **Solution Implemented**:
  - UI me sleek **Dropdown/Accordion (Collapsible Arrow)** render kiya gaya hai with `<details class="thinking-accordion">` aur live thinking stream support.

### 3. Transparent Tool Calling UI (Terminal & Custom Tools) — [COMPLETED & VERIFIED ✅]
- **Problem**:
  - AI secretly background me command execute kar raha hai ya tool run karta hai jo user ko pata nahi chalta.
- **Solution Implemented**:
  - **Tool Calling Event System**: Jab bhi model koi tool run karta hai (`read_multiple_files`, `search_codebase`, `execute_terminal_command`), backend instantly Webview UI ko transparent `toolCallEvent` bhejta hai.
  - **Interactive Terminal Review Card**:
    - AI command execute karne ke liye `execute_terminal_command` tool call karta hai with explanation.
    - UI me ek clean card popup hota hai jisme command editable `<input>` box me aati hai.
    - User command ko edit kar sakta hai aur `[ ▶ Approve & Run in Terminal ]` ya `[ Reject ]` click kar sakta hai.
    - Approve karte hi command direct VS Code ke Integrated Terminal me safe execution ke sath send hoti hai.
  - **Sleek Tool Badges/Pills**: File inspection (`🔍 Inspected X file(s)`) aur Codebase search (`🧠 Searched codebase for "query"`) ke liye clean, subtle pills stream me render hote hain.

### 4. Direct In-File Code Application (Search/Replace & Diff Patcher Fix) - ✅ COMPLETED & VERIFIED
- **Problem**:
  - `<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE` blocks fail hote hain agar context anchors me slight whitespace ya line shift ho. Model kabhi-kabhi poora file rewrite karne lagta hai.
- **Solution Implemented**:
  - **Multi-Tier Robust Diff Patcher (`diffPatcher.ts` & `sidebarProvider.ts`)**:
    1. *Exact Match*: Exact tabs/spaces and newline-normalized matching.
    2. *Indentation Normalization Match*: Line-by-line whitespace-agnostic alignment.
    3. *Context Anchors*: First 2 & last 2 boundary anchor matching.
    4. *Fuzzy Levenshtein Match*: Sliding window similarity match (threshold lowered to 0.70).
    5. *Scout SEARCH Healer*: Local micro-LLM healing broken blocks automatically.
    6. *AST-Based Symbol Fallback*: VS Code language server document symbols se target function/class match aur replacement without corruption.
    7. *Safe DiffValidator*: Lazy placeholder comments reject karta hai aur dangerous silent file-appending block karta hai.
  - User UI se direct `[ ⚡ Apply ]` ya `[ ✨ APPLY ALL FILES ]` click karke code buffer me write kar sakta hai.

### 5. True File Rewind / Rollback (Collateral State Revert) - ✅ COMPLETED & VERIFIED
- **Problem**:
  - Rewind button dabane par sirf chat history purani state pe aati hai, lekin us session/turn me bani hui new files ya modified code revert nahi hota.
- **Solution Implemented**:
  - **Full Dual-Layer State Reversion (`sidebarProvider.ts` & `fileVersioning.ts`)**:
    1. *Created File Destruction*: Agar us turn me koi file nayi bani thi (`content === null`), rollback par wo disk (`fs.unlinkSync`) aur workspace (`revertEdit.deleteFile`) dono se permanently remove ho jati hai.
    2. *Modified File Full Reversion*: Jo files modify hui thi, unka exact original state disk par direct write hota hai (`fs.writeFileSync`) aur open VS Code buffers ko update karke dirty buffer auto-save kiya jata hai.
    3. *Snapshot Fallback Recovery*: Agar explicit `fileBackups` na mile, toh `.ultra-light-ai/snapshots` se automatically previous snapshot fetch karke restore karta hai.
    4. *Apply Diff Backup*: Single code-block `[ Apply Diff ]` ke time par bhi active editor ka backup store hota hai taaki future rollback me wo bhi revert ho sake.
    5. *Single File Undo*: Individual file card me `[ ↩️ Undo ]` click karne par snapshot se direct revert aur buffer refresh hota hai.
    6. *User Input Injection*: Rolled back turn ka prompt automatically chat input box me wapas inject ho jata hai.

---

## 📌 Phase 2: Previous 6 System Audit Suggestions

### 6. Dynamic Multi-Root & Workspace Switching — [COMPLETED & VERIFIED ✅]
- Extension khule rehne ke dauran agar user naya folder open kare ya folder switch kare, toh `onDidChangeWorkspaceFolders` event ke through saare components (RAG Engine, File Watchers, Webview Provider, Config) dynamically re-initialize aur auto-reload ho rahe hain.

### 7. Startup Optimization & On-Demand Lazy Loading — [COMPLETED & VERIFIED ✅]
- Extension launch lightweight hai, RAG background me index create karta hai with status bar `$(sync~spin)` loading indicator.

### 8. Integrated Terminal vs Blind Child Process — [COMPLETED & VERIFIED ✅]
- Execution standard VS Code Terminal API (`vscode.window.createTerminal`) aur `TerminalCapture` se handle ho raha hai without blind `child_process.exec`.

### 9. Secure SecretStorage (`context.secrets`) — [COMPLETED & VERIFIED ✅]
- API keys VS Code ke encrypted OS Keychain (`context.secrets.store`) me safe tarike se manage ho rahi hain.

### 10. Memory & Token Budget Optimization — [COMPLETED & VERIFIED ✅]
- `.gitignore` aur custom `.aiignore` both strictly honored hain in `RagEngine` & `ProjectScanner`.

### 11. Interactive First-Run Wizard — [COMPLETED & VERIFIED ✅]
- Missing API key detect hone par pehli launch par interactive welcome input box se API key prompt ki jaati hai.

---

## 📌 Phase 3: Additional Next-Gen Suggestions (For Maximum Polish)

### 12. Smart "Apply All" / "Reject All" Code Diff Preview
- Jab AI 4-5 files ek saath change kare, toh user ko har file par accept/reject ka interactive side-by-side diff preview mile (jaise Cursor ya GitHub Copilot me hota hai).

### 13. Context Mentions System (`@file`, `@folder`, `@terminal`, `@git`) — [COMPLETED & VERIFIED ✅]
- Chat input me `@file`, `@terminal` (last terminal output) aur `@git` (uncommitted diffs) injection functional hai.

### 14. Error Diagnostics Auto-Healer (Squiggly Red Lines Awareness) — [COMPLETED & VERIFIED ✅]
- `ultra-light-ai.autoFixDiagnostics` command `vscode.languages.getDiagnostics()` errors fetch karke AI ko auto-fix prompt bhejta hai.

---

## 📌 Phase 4: Elite Level Next-Gen Suggestions (To Rival Cursor & Claude 3.7 Dev)

### 15. Real-Time Token Budget & Cost Meter in Chat Footer — [COMPLETED & VERIFIED ✅]
- Chat footer me live token count, context percentage, aur estimated cost meter render ho raha hai.

### 16. In-Line Floating Ghost Edit / Diff Overlay (Like Cursor Ctrl+K)
- **Idea**: Abhi ka `Ctrl+K` simple input box leta hai aur direct text replace karta hai. Iski jagah editor me inline green/red diff widget render ho jisme "Accept (Ctrl+Y)" aur "Reject (Ctrl+N)" button aate hain.

### 17. Intelligent Checkpoint System (Git Branch-Independent Stash) — [COMPLETED & VERIFIED ✅]
- `.ultra-light-ai/checkpoints/` system in `FileVersioning` and snapshot rollback supported.

### 18. Auto Self-Healing Feedback Loop (Agentic Retry)
- **Idea**: Jab AI code modify kare aur automatically build/test run kare: syntax error ya test fail hone par silent agentic retry.

### 19. Multi-Model Hybrid Routing (Gemma 2 / Flash for Fast tasks, Pro for Architect)
- **Idea**: Fast tasks vs Pro architect routing.

### 20. Codebase Knowledge Graph / Symbol Map Cache (Supercharged RAG)
- **Idea**: Sirf text matching (BM25) ke bajay workspace ke Class, Functions, aur Interfaces ki dependency graph banaye (`User -> imports AuthController -> uses AuthService`).
- **Fayda**: AI ko instantly pata hota hai ki function badalne se kaun-kaun si doosri files break ho sakti hain.

---

## 🎯 Implementation Roadmap Order
1. **Milestone 1**: Architect Clean Chat + Thinking Accordion + Professional Cards
2. **Milestone 2**: Transparent Tool Calling + Interactive Terminal Approval/Editing
3. **Milestone 3**: 3-Tier Diff Patcher + File Rollback Checkpoint System
4. **Milestone 4**: SecretStorage + Dynamic Multi-root + Startup Lazy Loading
5. **Milestone 5**: Self-Healing Agent Loop + Hybrid Model Routing + In-line Diff Widget

