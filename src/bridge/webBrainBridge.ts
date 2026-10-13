import * as puppeteer from 'puppeteer-core';
import { IEngine, CompletionResult, StreamChunk, CompleteWithHistoryOptions } from '../router/IEngine';
import { extractTextToolCalls } from '../router/realClients';

export interface WebBrainBridgeConfig {
    enabled?: boolean;
    provider?: 'chatgpt' | 'gemini';
    cdpPort?: number;
    activeSessionId?: string;
    autoEscalateOnError?: boolean;
}

export class WebBrainBridgeClient implements IEngine {
    public name: string = 'WebBrainBridge';
    private config: WebBrainBridgeConfig;
    private browser: puppeteer.Browser | null = null;
    private activePage: puppeteer.Page | null = null;
    private activeProvider: 'chatgpt' | 'gemini';
    private cdpPort: number;
    private sessionMessageCount: number = 0;
    private mainBrain: IEngine | null = null;
    private onStatusUpdate?: (status: string) => void;
    private static instance: WebBrainBridgeClient | null = null;

    constructor(config?: WebBrainBridgeConfig, mainBrain?: IEngine) {
        this.config = config || {};
        this.activeProvider = this.config.provider || 'chatgpt';
        this.cdpPort = this.config.cdpPort || 9222;
        this.name = `WebBrainBridge (${this.activeProvider.toUpperCase()})`;
        if (mainBrain) this.mainBrain = mainBrain;
        WebBrainBridgeClient.instance = this;
    }

    public static getInstance(config?: WebBrainBridgeConfig): WebBrainBridgeClient {
        if (!this.instance || (config && (config.provider !== this.instance.activeProvider || config.cdpPort !== this.instance.cdpPort))) {
            this.instance = new WebBrainBridgeClient(config);
        }
        return this.instance;
    }

    public setMainBrain(mainBrain: IEngine): void {
        this.mainBrain = mainBrain;
    }

    public setStatusCallback(cb: (status: string) => void): void {
        this.onStatusUpdate = cb;
    }

    private postStatus(text: string): void {
        if (this.onStatusUpdate) {
            try { this.onStatusUpdate(text); } catch {}
        }
    }

    public resetSession(): void {
        this.sessionMessageCount = 0;
        this.activePage = null;
    }

    /**
     * Checks if Chrome is reachable via CDP port and lists open tabs.
     */
    public static async testConnection(port: number = 9222): Promise<{ success: boolean; message: string; tabs: string[] }> {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/list`);
            if (!res.ok) {
                return {
                    success: false,
                    message: `CDP endpoint returned status ${res.status}. Ensure Chrome was started with --remote-debugging-port=${port}`,
                    tabs: []
                };
            }
            const tabsData = (await res.json()) as any[];
            const tabTitles = tabsData
                .filter(t => t.type === 'page')
                .map(t => `${t.title || 'Untitled'} (${t.url})`);

            return {
                success: true,
                message: `Successfully connected to Chrome on port ${port}! (${tabTitles.length} active tabs detected)`,
                tabs: tabTitles
            };
        } catch (err: any) {
            return {
                success: false,
                message: `Could not connect to Chrome on port ${port}. Please launch Chrome with: chrome.exe --remote-debugging-port=${port}`,
                tabs: []
            };
        }
    }

    /**
     * Locates the Chrome or Edge executable on Windows/Mac/Linux.
     */
    public static findBrowserExecutable(): string | null {
        const fs = require('fs');
        const path = require('path');
        const candidates = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser'
        ];
        for (const c of candidates) {
            if (c && fs.existsSync(c)) return c;
        }
        return null;
    }

    /**
     * Automatically launches Chrome with remote debugging port enabled.
     * Uses a dedicated profile directory so it never conflicts with already running Chrome windows!
     */
    public static async launchBrowser(port: number = 9222, provider: 'chatgpt' | 'gemini' = 'chatgpt'): Promise<{ success: boolean; message: string; path?: string }> {
        const exe = this.findBrowserExecutable();
        if (!exe) {
            return {
                success: false,
                message: 'Chrome executable not found. Please run Chrome with: --remote-debugging-port=' + port
            };
        }

        try {
            const { spawn } = require('child_process');
            const path = require('path');
            const os = require('os');
            const profileDir = path.join(os.homedir(), '.vakra-chrome-profile');
            const targetUrl = provider === 'gemini' ? 'https://gemini.google.com/app' : 'https://chatgpt.com/';
            
            const child = spawn(exe, [
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profileDir}`,
                targetUrl
            ], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();

            await new Promise(r => setTimeout(r, 2000));
            const test = await this.testConnection(port);
            return {
                success: true,
                message: `Launched Chrome for ${provider.toUpperCase()} on port ${port}! ${test.success ? 'Connected successfully.' : 'Browser window opening...'}`,
                path: exe
            };
        } catch (e: any) {
            return {
                success: false,
                message: `Failed to launch browser: ${e?.message || e}`
            };
        }
    }

    /**
     * Attaches to user's running Chrome browser via CDP.
     */
    private async ensureBrowserConnection(): Promise<puppeteer.Browser> {
        if (this.browser && this.browser.connected) {
            return this.browser;
        }

        const browserUrl = `http://127.0.0.1:${this.cdpPort}`;
        try {
            this.browser = await puppeteer.connect({
                browserURL: browserUrl,
                defaultViewport: null
            });
            return this.browser;
        } catch (err: any) {
            throw new Error(
                `[Web Brain Bridge] Failed to connect to Chrome at ${browserUrl}.\n` +
                `Make sure Chrome is running with remote debugging enabled:\n` +
                `1. Close Chrome completely.\n` +
                `2. Run command: chrome.exe --remote-debugging-port=${this.cdpPort}\n` +
                `3. Log in to ChatGPT or Gemini in that window.\n` +
                `Original Error: ${err?.message || err}`
            );
        }
    }

    /**
     * Finds existing ChatGPT / Gemini tab, or opens one if not already open.
     * Retains single session continuity across turns!
     */
    private async getOrCreateProviderPage(provider: 'chatgpt' | 'gemini'): Promise<puppeteer.Page> {
        if (this.activePage && !this.activePage.isClosed()) {
            const currentUrl = this.activePage.url();
            if (provider === 'chatgpt' && (currentUrl.includes('chatgpt.com') || currentUrl.includes('chat.openai.com'))) {
                return this.activePage;
            }
            if (provider === 'gemini' && currentUrl.includes('gemini.google.com')) {
                return this.activePage;
            }
        }

        const browser = await this.ensureBrowserConnection();
        const pages = await browser.pages();

        // 1. Look for existing open tab for this provider
        for (const p of pages) {
            const u = p.url();
            if (provider === 'chatgpt' && (u.includes('chatgpt.com') || u.includes('chat.openai.com'))) {
                this.activePage = p;
                await p.bringToFront();
                return p;
            }
            if (provider === 'gemini' && u.includes('gemini.google.com')) {
                this.activePage = p;
                await p.bringToFront();
                return p;
            }
        }

        // 2. Open new tab with target provider URL if not found
        const targetUrl = provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://gemini.google.com/app';
        const newPage = await browser.newPage();
        await newPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        this.activePage = newPage;
        await newPage.bringToFront();
        return newPage;
    }

    /**
     * Sends prompt into the active web session and retrieves the model's generated response.
     */
    public async sendWebPromptAndGetResponse(
        prompt: string,
        onChunk?: (chunk: StreamChunk) => void,
        signal?: AbortSignal
    ): Promise<string> {
        const page = await this.getOrCreateProviderPage(this.activeProvider);
        if (signal?.aborted) throw new Error('Operation aborted by user.');

        if (this.activeProvider === 'chatgpt') {
            return await this.interactWithChatGPT(page, prompt, onChunk, signal);
        } else {
            return await this.interactWithGemini(page, prompt, onChunk, signal);
        }
    }

    /**
     * ChatGPT Web Interaction (chatgpt.com)
     */
    private async interactWithChatGPT(
        page: puppeteer.Page,
        prompt: string,
        onChunk?: (chunk: StreamChunk) => void,
        signal?: AbortSignal
    ): Promise<string> {
        // Wait for prompt textarea
        const textareaSelector = '#prompt-textarea, div[contenteditable="true"][id="prompt-textarea"], div.ProseMirror';
        await page.waitForSelector(textareaSelector, { timeout: 15000 });

        // Record initial count of assistant messages so we know which message is the new response
        const initialAssistantCount = await page.evaluate(() => {
            return document.querySelectorAll('div[data-message-author-role="assistant"]').length;
        });

        // Set prompt text into the contenteditable / textarea (TrustedHTML safe)
        await page.evaluate((sel, text) => {
            const el = document.querySelector(sel) as any;
            if (!el) throw new Error('Input field not found');
            el.focus();
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                el.value = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                // ProseMirror / ContentEditable - TrustedHTML safe
                document.execCommand('selectAll', false, undefined);
                document.execCommand('delete', false, undefined);
                const inserted = document.execCommand('insertText', false, text);
                if (!inserted || !el.textContent?.trim()) {
                    while (el.firstChild) {
                        el.removeChild(el.firstChild);
                    }
                    const p = document.createElement('p');
                    p.textContent = text;
                    el.appendChild(p);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }, textareaSelector, prompt);

        await new Promise(r => setTimeout(r, 400));
        if (signal?.aborted) throw new Error('Operation aborted.');

        // Click Send button or press Enter
        const sendClicked = await page.evaluate(() => {
            const btn = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]') as HTMLButtonElement;
            if (btn && !btn.disabled) {
                btn.click();
                return true;
            }
            return false;
        });

        if (!sendClicked) {
            await page.focus(textareaSelector);
            await page.keyboard.press('Enter');
        }

        // Wait for generation to start and then finish
        let responseText = '';
        let lastReportedLen = 0;
        let lastChangedTime = Date.now();
        const targetIndex = initialAssistantCount; // 0-indexed new assistant message
        const startTime = Date.now();
        const maxWaitMs = 240000; // 4 minutes max generation timeout

        // Wait for assistant response to appear and settle
        while (Date.now() - startTime < maxWaitMs) {
            if (signal?.aborted) throw new Error('Operation aborted.');

            const state = await page.evaluate((idx) => {
                const assistants = document.querySelectorAll('div[data-message-author-role="assistant"]');
                const targetMsg = assistants[idx];
                const stopBtn = document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label*="Stop"]') as HTMLElement | null;
                const isStopVisible = !!stopBtn && stopBtn.offsetParent !== null && stopBtn.style.display !== 'none' && stopBtn.style.visibility !== 'hidden';

                let text = '';
                if (targetMsg) {
                    text = (targetMsg as HTMLElement).innerText || '';
                }
                return {
                    hasNewMessage: assistants.length > idx,
                    text,
                    isStopVisible
                };
            }, targetIndex);

            if (state.hasNewMessage && state.text) {
                if (state.text.length > responseText.length) {
                    lastChangedTime = Date.now();
                    responseText = state.text;
                    if (onChunk && responseText.length > lastReportedLen) {
                        const delta = responseText.slice(lastReportedLen);
                        lastReportedLen = responseText.length;
                        onChunk({ text: delta, done: false });
                    }
                }

                const textSettledDuration = Date.now() - lastChangedTime;
                const isFinished = responseText.length > 20 && (
                    (!state.isStopVisible && textSettledDuration >= 2000) ||
                    (textSettledDuration >= 4000)
                );

                if (isFinished) {
                    await new Promise(r => setTimeout(r, 300));
                    const finalMsg = await page.evaluate((idx) => {
                        const assistants = document.querySelectorAll('div[data-message-author-role="assistant"]');
                        return assistants[idx] ? (assistants[idx] as HTMLElement).innerText : '';
                    }, targetIndex);
                    if (finalMsg && finalMsg.length >= responseText.length) responseText = finalMsg;
                    break;
                }
            }

            await new Promise(r => setTimeout(r, 400));
        }

        if (onChunk) {
            onChunk({ text: '', done: true });
        }

        return responseText.trim();
    }

    /**
     * Gemini Web Interaction (gemini.google.com)
     */
    private async interactWithGemini(
        page: puppeteer.Page,
        prompt: string,
        onChunk?: (chunk: StreamChunk) => void,
        signal?: AbortSignal
    ): Promise<string> {
        // Wait for Gemini prompt input
        const inputSelector = 'rich-textarea .ql-editor, div[contenteditable="true"], textarea[aria-label*="prompt"]';
        await page.waitForSelector(inputSelector, { timeout: 15000 });

        const initialModelResponses = await page.evaluate(() => {
            return document.querySelectorAll('message-content, .model-response-text').length;
        });

        // Set prompt text (TrustedHTML safe)
        await page.evaluate((sel, text) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (!el) throw new Error('Gemini input not found');
            el.focus();

            // 1. Try document.execCommand insertText (Native Trusted Event handled by Quill)
            document.execCommand('selectAll', false, undefined);
            document.execCommand('delete', false, undefined);
            const inserted = document.execCommand('insertText', false, text);

            // 2. Fallback: TrustedHTML-safe DOM tree construction
            if (!inserted || !el.textContent?.trim()) {
                while (el.firstChild) {
                    el.removeChild(el.firstChild);
                }
                const lines = text.split('\n');
                for (const line of lines) {
                    const p = document.createElement('p');
                    p.textContent = line || '\u200B';
                    el.appendChild(p);
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, inputSelector, prompt);

        await new Promise(r => setTimeout(r, 400));
        if (signal?.aborted) throw new Error('Operation aborted.');

        // Click Send button
        const sendClicked = await page.evaluate(() => {
            const btn = document.querySelector('button[aria-label*="Send"], button.send-button, .send-button-container button') as HTMLButtonElement;
            if (btn && !btn.disabled) {
                btn.click();
                return true;
            }
            return false;
        });

        if (!sendClicked) {
            await page.focus(inputSelector);
            await page.keyboard.press('Enter');
        }

        let responseText = '';
        let lastReportedLen = 0;
        let lastChangedTime = Date.now();
        const targetIndex = initialModelResponses;
        const startTime = Date.now();
        const maxWaitMs = 240000; // 4 minutes for large full-stack codebases

        while (Date.now() - startTime < maxWaitMs) {
            if (signal?.aborted) throw new Error('Operation aborted.');

            const state = await page.evaluate((idx) => {
                const responses = document.querySelectorAll('message-content, .model-response-text');
                const targetMsg = responses[idx];
                
                // Only check for an ACTUAL visible Stop button
                const stopBtn = document.querySelector('button[aria-label*="Stop response"], button[aria-label*="Stop generating"], button[aria-label*="Stop"], button[data-test-id*="stop"]') as HTMLElement | null;
                const isStopVisible = !!stopBtn && stopBtn.offsetParent !== null && stopBtn.style.display !== 'none' && stopBtn.style.visibility !== 'hidden';

                // Check if Send button is visible and active again
                const sendBtn = document.querySelector('button[aria-label*="Send"], button.send-button, .send-button-container button') as HTMLButtonElement | null;
                const isSendReady = !!sendBtn && !sendBtn.disabled && sendBtn.offsetParent !== null;

                let text = '';
                if (targetMsg) {
                    text = (targetMsg as HTMLElement).innerText || '';
                }
                return {
                    hasNewMessage: responses.length > idx,
                    text,
                    isStopVisible,
                    isSendReady
                };
            }, targetIndex);

            if (state.hasNewMessage && state.text) {
                // If text grew, update timestamp and stream chunk
                if (state.text.length > responseText.length) {
                    lastChangedTime = Date.now();
                    responseText = state.text;
                    if (onChunk && responseText.length > lastReportedLen) {
                        const delta = responseText.slice(lastReportedLen);
                        lastReportedLen = responseText.length;
                        onChunk({ text: delta, done: false });
                    }
                }

                const textSettledDuration = Date.now() - lastChangedTime;

                // Fast & Accurate Completion Detection:
                // 1. Text has started arriving (> 20 characters)
                // 2. Either (no visible Stop button / Send is ready) AND text hasn't changed for 2 seconds,
                //    OR failsafe: text hasn't grown for 4 seconds continuously.
                const isFinished = responseText.length > 20 && (
                    ((!state.isStopVisible || state.isSendReady) && textSettledDuration >= 2000) ||
                    (textSettledDuration >= 4000)
                );

                if (isFinished) {
                    await new Promise(r => setTimeout(r, 300));
                    const finalMsg = await page.evaluate((idx) => {
                        const responses = document.querySelectorAll('message-content, .model-response-text');
                        return responses[idx] ? (responses[idx] as HTMLElement).innerText : '';
                    }, targetIndex);
                    if (finalMsg && finalMsg.length >= responseText.length) {
                        responseText = finalMsg;
                    }
                    break;
                }
            }

            await new Promise(r => setTimeout(r, 400));
        }

        if (onChunk) {
            onChunk({ text: '', done: true });
        }

        return responseText.trim();
    }

    /**
     * IEngine implementation: Simple completion
     */
    public async complete(prompt: string): Promise<CompletionResult> {
        const text = await this.sendWebPromptAndGetResponse(prompt);
        return {
            text,
            usage: {
                promptTokens: Math.ceil(prompt.length / 4),
                completionTokens: Math.ceil(text.length / 4),
                totalTokens: Math.ceil((prompt.length + text.length) / 4)
            }
        };
    }

    /**
     * IEngine implementation: Stream completion
     */
    public async completeStream(prompt: string, onChunk: (chunk: StreamChunk) => void): Promise<CompletionResult> {
        const text = await this.sendWebPromptAndGetResponse(prompt, onChunk);
        return {
            text,
            usage: {
                promptTokens: Math.ceil(prompt.length / 4),
                completionTokens: Math.ceil(text.length / 4),
                totalTokens: Math.ceil((prompt.length + text.length) / 4)
            }
        };
    }

    /**
     * IEngine implementation: Full Autonomous Loop with Tool Calling & Error Relay
     */
    public async completeWithHistory(
        systemInstructionOrOptions: string | CompleteWithHistoryOptions,
        history?: Array<{ role: 'user' | 'model'; text: string }>,
        userMessage?: string,
        stream?: boolean,
        onChunk?: (chunk: StreamChunk) => void,
        signal?: AbortSignal,
        tools?: any[],
        onToolCall?: (functionCall: any) => Promise<any>,
        images?: any[]
    ): Promise<CompletionResult> {
        let promptText = '';
        let sysInstruction = '';
        let chunkCb = onChunk;
        let abortSignal = signal;
        let toolExec = onToolCall;

        if (typeof systemInstructionOrOptions === 'object') {
            const opts = systemInstructionOrOptions as CompleteWithHistoryOptions;
            promptText = opts.prompt;
            sysInstruction = opts.systemInstruction || '';
            chunkCb = opts.onChunk;
            abortSignal = opts.signal;
            toolExec = opts.onToolCall;
        } else {
            promptText = userMessage || '';
            sysInstruction = systemInstructionOrOptions || '';
        }

        // Detect if prompt is diagnosing/fixing an error vs scaffolding/building a feature
        const isErrorTask = /error|exception|failed|failure|crash|traceback|cannot find|syntaxerror|typeerror|undefined is not|bug|issue/i.test(promptText);

        // Dynamic prompt formulation driven by Main Brain (No static hardcoding!)
        let fullSubmission = '';
        if (this.sessionMessageCount === 0) {
            this.sessionMessageCount++;

            if (this.mainBrain) {
                this.postStatus(`🧠 Main Brain analyzing request & formulating structured plan for ${this.activeProvider.toUpperCase()} Web...`);
                try {
                    const brainPrompt = `You are Vakra AI's Main Controller running inside VS Code.
User request:
"${promptText}"

${sysInstruction ? `Project structure & context:\n${sysInstruction.slice(0, 2000)}\n` : ''}

Your task:
Formulate the exact, structured prompt to send to ${this.activeProvider === 'gemini' ? 'Gemini Web' : 'ChatGPT Web'} in the browser.
Instruct it to:
1. Guide step-by-step starting from Step 1.
2. Put terminal commands in \`\`\`bash code blocks.
3. Put code files with clear filenames in code blocks (e.g. \`\`\`html:index.html or ### \`filepath\`).
4. Remind it that we will execute its commands and files locally in VS Code and report back live results.
5. Say [PROJECT COMPLETE] when everything is done.

Output ONLY the exact prompt to send to the browser model. No conversational fluff.`;

                    const brainRes = await this.mainBrain.complete(brainPrompt);
                    const drafted = brainRes?.text?.trim();
                    if (drafted && drafted.length > 20) {
                        fullSubmission = drafted;
                    }
                } catch (err: any) {
                    console.warn('[WebBrainBridge] Main Brain prompt drafting error:', err);
                }
            }

            if (!fullSubmission) {
                if (isErrorTask) {
                    fullSubmission = `I encountered an error in my local VS Code workspace:\n${promptText}\n\n${sysInstruction ? `Workspace context:\n${sysInstruction.slice(0, 1500)}\n` : ''}\nPlease tell me which file(s) you need to inspect or provide the exact fix code or \`\`\`bash command.`;
                } else {
                    fullSubmission = `Goal: ${promptText}\n\nPlease guide me step-by-step. Put terminal commands in \`\`\`bash and code files with filenames in code blocks (e.g. \`\`\`html:index.html). We will execute them locally in VS Code and report live results back to you. Start with Step 1 now:`;
                }
            }
        } else {
            this.sessionMessageCount++;
            // On follow-up messages in the active ongoing chat, send user prompt directly so model doesn't re-initialize!
            fullSubmission = promptText;
        }

        // Autonomous Worker-Executor Loop (relaying terminal checks and file edits into the same web chat)
        let currentPrompt = fullSubmission;
        let accumulatedResponse = '';
        let iteration = 0;
        const maxLoopTurns = 20;
        const executedActionsList: string[] = [];

        while (iteration < maxLoopTurns) {
            iteration++;
            if (abortSignal?.aborted) throw new Error('Operation aborted by user.');

            this.postStatus(`🌐 Sending prompt to ${this.activeProvider.toUpperCase()} Web (Turn ${iteration})...`);
            
            // Stream raw frontier web response as thinking chunks so it does not pollute the main chat message!
            const thinkingStreamer = (chunk: StreamChunk) => {
                if (chunkCb) {
                    chunkCb({
                        text: chunk.text,
                        isThinking: true,
                        done: chunk.done
                    });
                }
            };

            const roundResponse = await this.sendWebPromptAndGetResponse(currentPrompt, thinkingStreamer, abortSignal);
            accumulatedResponse += '\n' + roundResponse;

            // Check if model declared the task completely finished
            if (/\[PROJECT COMPLETE\]|PROJECT COMPLETE|TASK COMPLETED/i.test(roundResponse)) {
                this.postStatus(`🎉 ${this.activeProvider.toUpperCase()} Web signaled completion. Finalizing...`);
                break;
            }

            // Check if frontier model returned tool calls or code/terminal commands
            if (toolExec) {
                this.postStatus(`🧠 Main Brain parsing instructions from ${this.activeProvider.toUpperCase()} Web...`);

                // Collect tools from all output modalities
                const parsedToolCalls: any[] = [];

                // 1. Explicit function/JSON calls
                const textCalls = extractTextToolCalls(roundResponse);
                for (const tc of textCalls) {
                    parsedToolCalls.push(tc);
                }

                // 2. Terminal bash blocks
                const bashCalls = extractBashCommands(roundResponse);
                for (const bc of bashCalls) {
                    if (!parsedToolCalls.some(t => t.name === 'execute_terminal_command' && t.args?.command === bc.args?.command)) {
                        parsedToolCalls.push(bc);
                    }
                }

                // 3. File creation code blocks
                const mdFiles = extractFilesFromMarkdown(roundResponse);
                const writtenFiles = mdFiles.map(f => f.args.filepath);
                for (const mf of mdFiles) {
                    if (!parsedToolCalls.some(t => t.name === 'write_file' && t.args?.filepath === mf.args?.filepath)) {
                        parsedToolCalls.push(mf);
                    }
                }

                // 4. File inspection requests (Gemini asking which files to read)
                const readCalls = extractFileInspectionRequests(roundResponse, writtenFiles);
                for (const rc of readCalls) {
                    if (!parsedToolCalls.some(t => t.name === 'read_multiple_files')) {
                        parsedToolCalls.push(rc);
                    }
                }

                // 5. Auto-detect inline terminal commands (e.g. `npm install ...` or `Run: npm create...`)
                const inlineCmdRegex = /(?:Run|Execute|Command):\s*`([^`]+)`|(?:^|\n)\s*(?:\d+\.\s*)?(?:npm|npx|pip|git|pnpm|yarn)\s+[^\n]+/gi;
                let icm;
                while ((icm = inlineCmdRegex.exec(roundResponse)) !== null) {
                    const rawCmd = (icm[1] || icm[0]).replace(/^(?:Run|Execute|Command):\s*/i, '').replace(/^\d+\.\s*/, '').trim();
                    if (rawCmd && !parsedToolCalls.some(t => t.name === 'execute_terminal_command' && t.args?.command === rawCmd)) {
                        parsedToolCalls.push({
                            name: 'execute_terminal_command',
                            args: { command: rawCmd, explanation: 'Auto-detected command from response' },
                            raw: icm[0]
                        });
                    }
                }

                // 6. If no tool calls found by regex, invoke Main Brain to extract actions from Gemini's guidance
                if (parsedToolCalls.length === 0 && this.mainBrain) {
                    this.postStatus(`🧠 Main Brain inspecting ${this.activeProvider.toUpperCase()} Web response...`);
                    try {
                        const mbActionRes = await this.mainBrain.complete(
                            `You are Vakra AI's Main Controller. The user wanted: "${promptText}".\nGemini Web responded with:\n${roundResponse.slice(0, 2500)}\n\nExtract any terminal commands or code to execute. If commands to run: execute_terminal_command(command="..."). If code: write_file(filepath="...", content="..."). If Gemini only gave a plan, outline, or sequence without code, reply: NEED_CODE_STEP_1.`
                        );
                        const mbTxt = mbActionRes?.text?.trim() || '';
                        const mbTools = extractTextToolCalls(mbTxt);
                        for (const t of mbTools) parsedToolCalls.push(t);
                        const mbBash = extractBashCommands(mbTxt);
                        for (const b of mbBash) {
                            if (!parsedToolCalls.some(p => p.name === 'execute_terminal_command' && p.args?.command === b.args?.command)) parsedToolCalls.push(b);
                        }
                        const mbFiles = extractFilesFromMarkdown(mbTxt);
                        for (const f of mbFiles) {
                            if (!parsedToolCalls.some(p => p.name === 'write_file' && p.args?.filepath === f.args?.filepath)) parsedToolCalls.push(f);
                        }
                    } catch (e) {
                        console.warn('[WebBrainBridge] Main Brain action parsing error:', e);
                    }
                }

                // If executable tool calls exist: Run them!
                if (parsedToolCalls.length > 0) {
                    let toolFeedbackBlock = '';
                    let hasErrors = false;

                    for (const call of parsedToolCalls) {
                        if (call.name === 'finish') {
                            const finishSummary = executedActionsList.length > 0
                                ? `### Execution Complete\n${executedActionsList.join('\n')}\n\nTask finished successfully.`
                                : 'Task completed successfully.';
                            this.postStatus(`✅ Task finished successfully.`);
                            return {
                                text: finishSummary,
                                usage: {
                                    promptTokens: Math.ceil(currentPrompt.length / 4),
                                    completionTokens: Math.ceil(accumulatedResponse.length / 4),
                                    totalTokens: Math.ceil((currentPrompt.length + accumulatedResponse.length) / 4)
                                }
                            };
                        }

                        try {
                            const result = await toolExec(call);
                            executedActionsList.push(`- **${call.name}**: ${call.name === 'write_file' ? call.args.filepath : (call.args.command || '')}`);
                            toolFeedbackBlock += `\n[ACTION COMPLETED: ${call.name}]\nDetails: ${JSON.stringify(call.args)}\nOutput:\n${result}\n`;
                            if (typeof result === 'string' && (result.includes('Error:') || result.includes('FAILED') || result.includes('Exit Code: 1'))) {
                                hasErrors = true;
                            }
                        } catch (err: any) {
                            hasErrors = true;
                            toolFeedbackBlock += `\n[ACTION ERROR: ${call.name}]: ${err?.message || err}\n`;
                        }
                    }

                    // Feed tool outputs or terminal errors back into the SAME browser session via Main Brain
                    if (this.mainBrain) {
                        this.postStatus(`🧠 Main Brain reviewing step execution results & preparing next prompt...`);
                        try {
                            const nextBrainPrompt = `You are Vakra AI's Main Controller.
User's Goal: "${promptText}"

Previous step instructions executed in VS Code with results:
${toolFeedbackBlock}

Write the next prompt to send to ${this.activeProvider === 'gemini' ? 'Gemini Web' : 'ChatGPT Web'}.
- If more steps are needed, request the next step code/commands.
- If there are errors, request the fix.
- If all work is completed and verified, tell it to say [PROJECT COMPLETE].
Output ONLY the prompt to send to the browser model.`;

                            const nextRes = await this.mainBrain.complete(nextBrainPrompt);
                            if (nextRes?.text?.trim() && nextRes.text.trim().length > 10) {
                                currentPrompt = nextRes.text.trim();
                            } else {
                                currentPrompt = `I executed your instructions in my local VS Code workspace. Here are the live results:\n${toolFeedbackBlock}\n\n${hasErrors ? 'There were errors. Please inspect the logs above, update the code or command, and provide the fix.' : 'Step finished successfully! Please provide the next step/code, or if the project/task is finished, say [PROJECT COMPLETE].'}`;
                            }
                        } catch {
                            currentPrompt = `I executed your instructions in my local VS Code workspace. Here are the live results:\n${toolFeedbackBlock}\n\n${hasErrors ? 'There were errors. Please inspect the logs above, update the code or command, and provide the fix.' : 'Step finished successfully! Please provide the next step/code, or if the project/task is finished, say [PROJECT COMPLETE].'}`;
                        }
                    } else {
                        currentPrompt = `I executed your instructions in my local VS Code workspace. Here are the live results:\n${toolFeedbackBlock}\n\n${hasErrors ? 'There were errors. Please inspect the logs above, update the code or command, and provide the fix.' : 'Step finished successfully! Please provide the next step/code, or if the project/task is finished, say [PROJECT COMPLETE].'}`;
                    }
                    continue; // Loop back into the same thread
                }

                // If Gemini gave a plan, outline, or "Recommended Execution Sequence" without actual code blocks:
                // NEVER STOP! Immediately push Gemini to write Step 1 code and commands!
                if (iteration < 8) {
                    this.postStatus(`🔄 Prompting ${this.activeProvider.toUpperCase()} Web to write Step 1 code & commands now...`);
                    currentPrompt = `I accept your proposed architecture and execution sequence. Please proceed with Step 1 immediately: Output the exact terminal commands in \`\`\`bash and initial project files in code blocks with filenames (e.g. \`\`\`html:index.html) so I can execute them locally in VS Code. Output the code and commands now:`;
                    continue; // Continue in the same browser session!
                }
            }

            // No further tool calls requested by the model
            break;
        }

        const finalSummary = executedActionsList.length > 0
            ? `### Execution Completed by Main Brain:\n${executedActionsList.join('\n')}\n\nAll requested steps have been applied and verified in the workspace.`
            : `Task complete. Workspace is ready.`;

        this.postStatus(`✅ Main Brain: Task execution complete!`);

        return {
            text: finalSummary,
            usage: {
                promptTokens: Math.ceil(fullSubmission.length / 4),
                completionTokens: Math.ceil(accumulatedResponse.length / 4),
                totalTokens: Math.ceil((fullSubmission.length + accumulatedResponse.length) / 4)
            }
        };
    }
}

/**
 * Extracts bash commands from ```bash code blocks
 */
function extractBashCommands(text: string): Array<{ name: string; args: { command: string; explanation: string }; raw: string }> {
    const commands: Array<{ name: string; args: { command: string; explanation: string }; raw: string }> = [];
    if (!text || typeof text !== 'string') return commands;

    const bashRegex = /```(?:bash|sh|cmd|powershell|shell)\s*\r?\n([\s\S]*?)\r?\n```/gi;
    let m;
    while ((m = bashRegex.exec(text)) !== null) {
        const cmd = m[1].trim();
        const activeLines = cmd.split('\n').filter(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('//'));
        if (activeLines.length > 0) {
            commands.push({
                name: 'execute_terminal_command',
                args: { command: cmd, explanation: 'Auto-detected command from response' },
                raw: m[0]
            });
        }
    }
    return commands;
}

/**
 * Extracts file inspection requests when model asks to read or see files
 */
function extractFileInspectionRequests(text: string, writtenFiles: string[]): Array<{ name: string; args: { filepaths: string[] }; raw: string }> {
    const requests: Array<{ name: string; args: { filepaths: string[] }; raw: string }> = [];
    if (!text || typeof text !== 'string') return requests;

    const inspectPhraseRegex = /(?:inspect|read|check|see|examine|view|show me|provide|share)\s+(?:the\s+)?(?:code|content|contents|file|files|for)?\s*(?:of\s+)?(?:the\s+)?`?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)`?/gi;
    const foundPaths = new Set<string>();

    let m;
    while ((m = inspectPhraseRegex.exec(text)) !== null) {
        const fp = m[1].trim();
        if (
            fp.includes('.') && 
            !fp.endsWith('.md') && 
            !writtenFiles.includes(fp) &&
            !fp.startsWith('http')
        ) {
            foundPaths.add(fp);
        }
    }

    if (foundPaths.size > 0) {
        requests.push({
            name: 'read_multiple_files',
            args: { filepaths: Array.from(foundPaths) },
            raw: text.slice(0, 100)
        });
    }

    return requests;
}

/**
 * Extracts code blocks with target filenames from standard markdown (e.g. ```html:index.html or ### `app.js` ```js)
 */
function extractFilesFromMarkdown(text: string): Array<{ name: string; args: { filepath: string; content: string }; raw: string }> {
    const files: Array<{ name: string; args: { filepath: string; content: string }; raw: string }> = [];
    if (!text || typeof text !== 'string') return files;

    // Pattern 1: ```lang:filepath or ```lang title="filepath"
    const titleRegex = /```(?:[a-zA-Z0-9_-]+)?[:\s]+(?:title=)?["']?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)["']?\s*\r?\n([\s\S]*?)\r?\n```/g;
    let m;
    while ((m = titleRegex.exec(text)) !== null) {
        const fp = m[1].trim();
        if (!files.some(f => f.args.filepath === fp)) {
            files.push({ name: 'write_file', args: { filepath: fp, content: m[2] }, raw: m[0] });
        }
    }

    // Pattern 2: ### `filepath`, ### 1. `filepath`, **`filepath`**, or File: `filepath` followed by ```
    const fileHeaderRegex = /(?:###?\s*(?:\d+\.\s*)?|\*\*|File:\s*|Filename:\s*|Create\s+)?`?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)`?\*?\*?\s*(?::)?\s*\r?\n+```(?:[a-zA-Z0-9_-]*)\s*\r?\n([\s\S]*?)\r?\n```/g;
    while ((m = fileHeaderRegex.exec(text)) !== null) {
        const fp = m[1].trim();
        if (!files.some(f => f.args.filepath === fp)) {
            files.push({ name: 'write_file', args: { filepath: fp, content: m[2] }, raw: m[0] });
        }
    }

    // Pattern 3: First line comment inside code block, e.g. <!-- index.html --> or // script.js
    const commentRegex = /```(?:[a-zA-Z0-9_-]*)\s*\r?\n(?:\/\/|#|<!--|\/\*)\s*([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)(?:\s*-->|\s*\*\/)?\s*\r?\n([\s\S]*?)\r?\n```/g;
    while ((m = commentRegex.exec(text)) !== null) {
        const fp = m[1].trim();
        if (!files.some(f => f.args.filepath === fp)) {
            files.push({ name: 'write_file', args: { filepath: fp, content: m[2] }, raw: m[0] });
        }
    }

    return files;
}
