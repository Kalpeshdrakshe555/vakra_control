# Ultra Light AI — Copilot Extension Analysis & Implementation Plan

## Current State Analysis

### What Exists (Working)
| Feature | Status | Notes |
|---|---|---|
| Sidebar Chat UI | ✅ Partial | Basic chat, but no markdown rendering, no conversation history |
| Gemini API Client | ✅ Working | Multi-key failover, timeout support |
| Settings Panel | ✅ Working | Model/key/timeout config |
| File Queue Processing | ✅ Basic | Sequential batch refactor mode |
| Diff Patcher | ✅ Crude | Overwrites entire file — no real diff/merge |
| Web Search (`@search`) | ✅ Basic | DuckDuckGo scraper |
| Circuit Breaker | ✅ Working | 15-min cooldown per engine |
| State Machine | ✅ Working | File-based JSON persistence |

### Critical Missing Features for a Copilot-Like Extension

| # | Feature | Priority | Description |
|---|---|---|---|
| 1 | **Inline Code Completions** | 🔴 Critical | `InlineCompletionItemProvider` — type-ahead AI suggestions |
| 2 | **Active File Context in Chat** | 🔴 Critical | Chat should auto-include current file + selection as context |
| 3 | **Conversation History / Memory** | 🔴 Critical | Multi-turn context with history array sent to API |
| 4 | **Markdown Rendering in Chat** | 🔴 Critical | Code blocks with syntax highlighting, proper formatting |
| 5 | **Code Actions (Quick Fix)** | 🟡 High | `CodeActionProvider` — AI-powered fix suggestions on diagnostics |
| 6 | **Hover Explanations** | 🟡 High | `HoverProvider` — explain code on hover |
| 7 | **Terminal Command Execution** | 🟡 High | "Run in Terminal" button should actually work |
| 8 | **Streaming Responses** | 🟡 High | Stream API responses token-by-token instead of waiting |
| 9 | **`@workspace` Context** | 🟡 High | Include relevant workspace files as context |
| 10 | **`@file` Context** | 🟡 High | Reference specific files in chat |
| 11 | **Keyboard Shortcuts** | 🟢 Medium | `Ctrl+Shift+I` for inline chat, keybindings |
| 12 | **New Chat / Clear History** | 🟢 Medium | Button to start fresh conversation |
| 13 | **Copy Code Button** | 🟢 Medium | One-click copy for code blocks |
| 14 | **Status Bar Item** | 🟢 Medium | Show AI status in VS Code status bar |
| 15 | **Model Selector Quick Pick** | 🟢 Medium | Command palette model switching |
| 16 | **Updated Model List** | 🟢 Medium | Current model list is outdated |

## Implementation Plan

### Phase 1: Core Copilot Features (Backend)
1. Add streaming support to `GeminiCloudClient`
2. Add conversation history to `SidebarProvider` 
3. Add active file context injection (`@file`, `@workspace`, auto-context)
4. Register `InlineCompletionItemProvider` for code suggestions
5. Register `CodeActionProvider` for AI quick-fixes
6. Register `HoverProvider` for code explanations
7. Add terminal command execution support
8. Add status bar integration

### Phase 2: UI Overhaul
1. Full markdown rendering with syntax highlighting (no external deps)
2. Working "Apply Diff", "Copy Code", "Run in Terminal" buttons
3. New Chat button and conversation management
4. Streaming text display (token-by-token animation)
5. File context indicators in chat
6. Updated model list in settings

### Phase 3: Polish
1. Keyboard shortcuts and keybindings
2. Command palette commands for all features
3. Proper activation events
4. Error handling improvements
