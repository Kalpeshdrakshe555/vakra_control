# Browser Tool Plan — Vakra AI

> Status: **Planned (not implemented yet)**. File names / line numbers ko implementation ke time dobara verify karna hai.

## Goal
Coder code likhe → server chalaye → browser me page khole → errors khud dekhe → fix kare. "Task Completed" tabhi bole jab page sach me bina error ke chal raha ho.

```
Coder code likhe → Dev server start → Browser page khole → Report
   → Error? → Haan: error Coder ko wapas → fix → dobara check
            → Nahi: Step Verified ✅
```

---

## Phase 1 — Dev Server Manager (base)
**Problem:** `runserver` / `npm run dev` kabhi khatam nahi hote, isliye synchronous terminal hang ho jata hai.

**Naya module:** `src/runtime/devServerManager.ts`
- `child_process.spawn` se server background me chalega, tool loop block nahi hoga.
- Server ke logs ek ring buffer me save honge (last ~500 lines), taaki Python/Node traceback model ko mile.
- **Ready check:** port listening ho ya log me `Starting development server` / `Local:` dikhe. Timeout ~30 sec.
- **Auto cleanup:** extension band ho ya task khatam ho to process tree kill hoga (Windows: `taskkill /T /F`), taaki zombie ports na rahein.
- Agar port pehle se busy hai to woh detect hoga.

| Tool | Kaam |
|---|---|
| `start_dev_server(command, cwd, port?)` | Server background me start, URL return |
| `server_logs(lines?)` | Latest logs / traceback |
| `stop_dev_server()` | Server band |

---

## Phase 2 — Lightweight HTTP Check (sabse sasta)
**Tool:** `http_check(url, method?, body?)`
- Status code (200/404/500), response time, content-type aur body ka shuru wala hissa.
- Django 500 debug page se sirf **exception type + message** nikalega (jaise `TemplateDoesNotExist: home.html`), poora HTML nahi.
- API endpoints (FastAPI / Django REST) ke liye JSON validate karega.

Ye ~80% backend bugs pakad lega aur 4B/9B model pe bhi halka padega.

---

## Phase 3 — Real Browser Tool
**Engine:** `playwright-core` + system ka **Edge/Chrome** (`channel: 'msedge'`), isliye 150MB browser download nahi karna padega.
- Browser lazy launch hoga aur headless mode default rahega.
- Ek hi browser session reuse hoga.

| Tool | Output |
|---|---|
| `browser_open(url)` | Compact page report |
| `browser_click(ref)` | Click karke naya report |
| `browser_type(ref, text, submit?)` | Form bharega |
| `browser_report()` | Current page ki state |
| `browser_screenshot()` | **Sirf vision models** ke liye (Gemini / Claude / GPT-4o / Qwen-VL) |

**Compact Page Report** (raw DOM nahi):
```
URL: http://localhost:8000/login   Status: 200   Title: "Login"
❌ Console Errors (2):
  - Uncaught TypeError: Cannot read 'value' of null (app.js:42)
❌ Failed Requests (1):
  - POST /api/login → 500
📄 Page Structure:
  [e1] heading "Login"
  [e2] textbox "Email"
  [e3] textbox "Password"
  [e4] button "Sign in"
```
- Accessibility tree se sirf interactive/important elements aayenge, `[e1]` jaise refs ke saath. Model click/type ke liye `ref` dega, CSS selector guess nahi karega.
- Errors **poore** jayenge, unpe koi limit nahi. Sirf page structure summarize hoga (raw HTML 50k+ tokens ka hota hai, wo useful context nahi hai).

---

## Phase 4 — Orchestrator Integration (auto verification)
`agentOrchestrator.ts` me **Runtime Verification step**:
1. Coder step complete hote hi framework detect hoga (Framework Recipes se): Django / FastAPI / Flask / Vite / React / Next.
2. Recipe se start command + port milega (`manage.py runserver`, `uvicorn`, `npm run dev`).
3. Routes nikalenge (`urls.py`, FastAPI decorators, React router). Har route pe `http_check`, UI pages pe `browser_open`.
4. **Error mila** → report Coder ko jayega. Unknown error ho to existing auto web search trigger hoga.
5. Retry limit: max 3 fix attempts per error. Fir bhi fail ho to user ko clear report milegi, infinite loop nahi chalega.
6. Sab green ho to hi step ✅ "Verified" mark hoga.

**Trigger rule:** Sirf web projects pe, ya jab user bole "run karke check kar". Simple file edits pe nahi (purani verifier wali galti repeat nahi karni).

---

## Phase 5 — Prompt Updates
`rolePrompts.ts` / `realClients.ts`:
- Tool docs aur exact JSON examples (chhote models ke liye bahut zaroori).
- Rule: "UI/route change ke baad `http_check` ya `browser_open` se verify kar."
- Rule: "Server error dikhe to pehle `server_logs`, fir relevant file `start_line`/`end_line` se padh, fir `edit_file`."
- Tool aliases normalize: `open_browser`, `navigate` → `browser_open`.

---

## Phase 6 (Optional) — MCP Client
- Generic MCP client (stdio transport) jo `.ultra-light-ai/mcp.json` se servers load kare.
- Official **Playwright MCP / Chrome DevTools MCP** ya koi bhi third-party tool bina core code chhede plug ho jayega.
- Native tools (Phase 1–3) default rahenge, MCP power users ke liye hoga.

---

## Safety & Settings
- **Default sirf `localhost` / `127.0.0.1`** khulega. Bahar ke URL ke liye user se confirmation lena padega.
- Settings: `vakra.browser.enabled`, `vakra.browser.headless`, `vakra.browser.executablePath`, `vakra.runtimeVerify.autoRun`.
- UI status chip ("🟢 Server running :8000") aur Stop button.

---

## Testing Plan
1. **Unit:** DevServerManager (fake process, ready detection, kill), report formatter, Django error extractor.
2. **Integration:** chhota local HTML fixture server jisme jaan-boojh ke JS error + 500 route ho. Tool ko ye errors pakadne chahiye.
3. **E2E:** sample Django app jisme `TemplateDoesNotExist` bug ho. Agent ko khud detect karke fix karna chahiye.
4. Existing 101 tests pass rehne chahiye.

---

## Order & Effort (rough)
| Phase | Kya | Effort | Value |
|---|---|---|---|
| 1 | Dev Server Manager | 1 din | 🔥 Base |
| 2 | `http_check` | ½ din | 🔥 Sabse zyada value / sasta |
| 3 | Playwright browser | 1–2 din | UI bugs |
| 4 | Auto verification loop | 1 din | Full autonomy |
| 5 | Prompts + aliases | ½ din | Chhote models ke liye zaroori |
| 6 | MCP client | 1–2 din | Optional |

**Recommendation:** Pehle **Phase 1 + 2 + 5**, fir Phase 3–4, aur MCP sabse last.

