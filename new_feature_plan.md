# 🚀 Ultra Light AI - Next-Gen Feature Roadmap

*This document outlines the ultra-optimized architectural upgrades derived from advanced LLM analysis. These features are strictly designed for low-end hardware (i3, 8GB RAM) and free-tier API limits (8k TPM).*

---

## 🎨 1. The "Design Brain" Architecture (Zero-Cost UI Engine)
**Concept:** Decouple design decisions from code generation. Stop asking the heavy AI model to "think" of colors and layouts while writing code.
**Implementation Steps:**
1. **Stage 1 - Semantic Decoder (Low Cost):** Use a fast, free Groq API call to parse the user's prompt into a strict JSON (e.g., `{"industry": "fitness", "vibe": "dark neon"}`). Cost: ~800 tokens.
2. **Stage 2 - Brand DNA Extractor (Zero Cost):** Write pure local TypeScript logic that maps the JSON to predefined color palettes, Google Fonts, and base geometric SVGs.
3. **Stage 3 - Asset Orchestrator (Zero Cost):** Dynamically build Unsplash (`https://source.unsplash.com/1600x900/?fitness`) and Pravatar URLs deterministically.
4. **Stage 4 - Code Synthesizer (High Cost):** Pass the exact "Brand DNA" (colors, fonts, URLs) to Gemini. Gemini now only acts as a pure coder (HTML/Tailwind), not a designer.
5. **Bonus - State Persistence:** Save the generated Brand DNA into `.agentrules` so future components automatically match the theme without re-generating the design!

---

## 🦴 2. AST "Skeletonization" (Extreme Token Optimization)
**Concept:** Currently, reading 5 full files blows up the 8k TPM limit. We need to map a 50-file workspace into less than 3,000 tokens.
**Implementation Steps:**
- Build a local VS Code LSP-powered script that strips out function bodies, variable assignments, and logic from files.
- It will leave *only* function signatures, class names, and docstrings.
- Example: `function calculateKPI() { ...heavy logic... }` becomes just `function calculateKPI();`.
- If the AI needs to see the actual logic, it must use a native tool `expand_symbol` to fetch only that specific block.

---

## 🚦 3. The "Traffic Cop" Routing (API Bypass)
**Concept:** Stop using Gemini 1.5 Pro for simple tasks.
**Implementation Steps:**
- Set up a lightweight, free Groq endpoint (Llama-3-8B) as the "Traffic Cop".
- This Cop will handle all binary decisions: "Is this prompt a simple question?", "Did this terminal command fail?", "Which files do I need to search?".
- Only when the Cop decides that complex code generation is required, will it wake up the main Gemini Architect. This reserves the strict 8k TPM budget purely for coding.

---

## 🎯 4. Surgical Terminal Heuristics (Fixing Bug #1)
**Concept:** Pumping 60 raw lines of terminal output into the chat box consumes too many tokens and confuses the AI.
**Implementation Steps:**
- Add a local Node.js heuristic regex layer to intercept `stderr`.
- Extract ONLY the error name (e.g., `IndexError`, `SyntaxError`) and the file path/line number.
- Use native VS Code APIs to grab exactly 5 lines of code above and below the crash site.
- Send *only* the Error Name + 10 lines of code to the AI. This turns a 2,000-token stack trace dump into a 150-token surgical strike.

---

## 🧠 5. Cache-Aware Hashing (Zero-Cost Memory)
**Concept:** Never ask the AI to solve the exact same problem twice.
**Implementation Steps:**
- When the `ARCHITECTURE.md` is updated or a specific diff is generated, calculate a lightweight hash (SHA-256) of the prompt and the file state.
- Before calling the AI, check the hash map. If the user asks for "add a button" on a file state that matches a previous exact request, instantly load the cached response from disk.

---

### 🚀 Execution Plan for Next Sprint:
1. **Priority 1:** Implement Stage 2 of the **Design Brain** (Local TypeScript DNA Extractor). It requires no API changes and brings instant value.
2. **Priority 2:** Implement **Surgical Terminal Heuristics** to fix the massive error dumps and save immediate tokens.
3. **Priority 3:** Integrate the **AST Skeletonization** logic into `sidebarProvider.ts` to compress RAG queries.