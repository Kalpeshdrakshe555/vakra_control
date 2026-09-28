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

### 2. Collapsible Thinking Accordion (`<think>`)
- **Problem**:
  - Thinking process ya toh gayab ho jati hai ya chat ka layout kharab karti hai.
- **Solution / Requirement**:
  - UI me ek sleek **Dropdown/Accordion (Collapsible Arrow)** hona chahiye:
    - Default state: Collapsed (`🧠 Reasoning / Thinking Process (Click to expand)`).
    - User arrow pe click kare toh smooth animation ke sath AI ki thinking trace expand ho.

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

### 6. Dynamic Multi-Root & Workspace Switching
- Extension khule rehne ke dauran agar user naya folder open kare ya folder switch kare, toh `onDidChangeWorkspaceFolders` event ke through saare components (RAG, Chat, State, Config) auto-reload hon.

### 7. Startup Optimization & On-Demand Lazy Loading
- Extension launch ko 100% lightweight rakhne ke liye commands (`playGame`, `skeletonExpand`, `smartSearch`) aur heavy providers ko dynamic `import()` par shift karna.
- RAG index build hone ke dauran status bar me non-blocking loader icon dikhana.

### 8. Integrated Terminal vs Blind Child Process
- `child_process.exec` se blind execution band karke VS Code standard Terminal API (`vscode.window.createTerminal`) ka use karna taaki user live logs, ANSI colors aur output dekh sake.

### 9. Secure SecretStorage (`context.secrets`)
- API keys ko plain text file `.agent-config.json` me rakhne ke bajay VS Code ke official OS Keychain (`context.secrets.store`) me encypted rakhna taaki GitHub leak ka risk zero ho jaye.

### 10. Memory & Token Budget Optimization
- Large projects (5,000+ files) me `.gitignore` aur custom `.aiignore` rule honor karna taaki memory consumption low rahe aur RAG BM25 crash na ho.
- Streaming ke waqt client-side `AbortController` ko user "Cancel" pe instantly terminate karna.

### 11. Interactive First-Run Wizard
- Jab extension pehli baar launch ho aur koi API key na mile, toh silent fail hone ke bajay ek friendly welcome notification + modal aaye jo user ko directly key save karne ka input box de.

---

## 📌 Phase 3: Additional Next-Gen Suggestions (For Maximum Polish)

### 12. Smart "Apply All" / "Reject All" Code Diff Preview
- Jab AI 4-5 files ek saath change kare, toh user ko har file par accept/reject ka interactive side-by-side diff preview mile (jaise Cursor ya GitHub Copilot me hota hai).

### 13. Context Mentions System (`@file`, `@folder`, `@terminal`, `@git`)
- Chat input me user `@` type kare toh quick autocomplete list aaye:
  - `@file:src/auth.ts`: File ka content prompt me inject kare.
  - `@terminal`: Last terminal error ya output direct fetch kare.
  - `@git`: Uncommitted diffs ko context me inject kare.

### 14. Error Diagnostics Auto-Healer (Squiggly Red Lines Awareness)
- Jab user kisi file me error dekhe, status bar ya context menu se "AI Auto-Fix Diagnostics" click karne par VS Code ke active language server ki errors (`vscode.languages.getDiagnostics`) AI ke paas jayein aur wo 1-shot search/replace patch generate kare.

---

---

## 📌 Phase 4: Elite Level Next-Gen Suggestions (To Rival Cursor & Claude 3.7 Dev)

### 15. Real-Time Token Budget & Cost Meter in Chat Footer
- **Idea**: Chat ke footer me ek subtle live badge dikhe: `Tokens: 3.2k / 8k | Est. Cost: $0.002 | Context: 18%`.
- **Fayda**: User ko hamesha pata rehta hai ki kitna context fill hua hai aur kab model summarize karega, taaki sudden context overflow na ho.

### 16. In-Line Floating Ghost Edit / Diff Overlay (Like Cursor Ctrl+K)
- **Idea**: Abhi ka `Ctrl+K` simple input box leta hai aur direct text replace karta hai. Iski jagah editor me inline green/red diff widget render ho jisme "Accept (Ctrl+Y)" aur "Reject (Ctrl+N)" button aate hain.
- **Fayda**: User ko bina file save kiye live editor ke andar preview milta hai ki kya change ho raha hai.

### 17. Intelligent Checkpoint System (Git Branch-Independent Stash)
- **Idea**: AI koi bhi complex task shuru karne se pehle ek internal local checkpoint banaye (`.ultra-light-ai/checkpoints/<timestamp>`).
- **Fayda**: User 1-click me kisi bhi puraane checkpoint par pure workspace ko rewind kar sakta hai, bhale hi project me git initialized na ho!

### 18. Auto Self-Healing Feedback Loop (Agentic Retry)
- **Idea**: Jab AI code modify kare aur automatically build/test run kare:
  - Agar syntax error ya test fail ho, toh AI turant khud terminal error padh kar **silently 1 aur retry** kare aur bug fix karke user ko bole: `“Build failed initially due to missing import, auto-fixed and verified successfully ✅”`.
- **Fayda**: User ko bar-bar copy-paste karke "fix this error" bolne ki jarurat nahi padegi.

### 19. Multi-Model Hybrid Routing (Gemma 2 / Flash for Fast tasks, Pro for Architect)
- **Idea**: 
  - Chhote tasks (explain code, inline edit, docstring): `gemini-2.0-flash` ya `gemma` (ultra-fast, instant response).
  - Architect/Multi-file refactor tasks: `gemini-1.5-pro` / `gemini-2.5-pro` (maximum reasoning power).
- **Fayda**: Speed 3x fast ho jayegi aur heavy reasoning wale tasks fail nahi honge.

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

