import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GeminiCloudClient } from '../router/realClients';
import { getGeminiApiKeys, getGeminiModel, getGeminiTimeout, getAgentConfig, ensureAgentConfig } from '../config';
import { ConversationHistory } from '../state/conversationHistory';
import { allocateBudget, ContextSource, estimateTokens, truncateToTokens, TokenAccountant } from '../utils/tokenBudget';
import { skeletonizeFile, generateStructuralRepoMap } from '../utils/astSkeletonizer';
import { generateCacheKey, checkCache, saveCache } from '../utils/queryCache';
import { ContextSelector } from '../utils/contextSelector';
import { PromptBuilder, TaskState } from './promptBuilder';
import { PromptClassifier } from '../utils/promptClassifier';
import { InMemoryTaskPlanner } from '../state/inMemoryTaskPlanner';
import { TerminalCapture } from '../tools/terminalCapture';
import { ErrorDiagnoser } from '../utils/errorDiagnoser';
import { SessionMemory } from '../state/sessionMemory';
import { SkillsManager } from '../features/skillsManager';
import { ToolDispatcher } from './tools/toolDispatcher';
import { MessageDispatcher, DispatchContext } from './handlers/messageDispatcher';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ultraLightAi.sidebar';
    private _view?: vscode.WebviewView;
    private currentAbortController: AbortController | null = null;
    private isTurnAbortedByUser: boolean = false;
    private currentTurnToolCalls: Array<{ tool: string; title: string; data: any }> = [];
    private conversationHistory: ConversationHistory;
    private taskPlanner: InMemoryTaskPlanner;
    private isTerminalSessionAutoApproved: boolean = false;
    private isEditSessionAutoApproved: boolean = false;
    private pendingTerminalResolvers: Map<string, (approvedOrResult: any, autoApproveSession?: boolean, command?: string) => void> = new Map();
    private pendingEditResolvers: Map<string, (approved: boolean, autoApproveSession?: boolean) => void> = new Map();
    private currentTaskState?: TaskState;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private _workspaceRoot: string,
        private ragEngine?: any,
        private readonly _extensionContext?: vscode.ExtensionContext
    ) {
        const config = getAgentConfig(this._workspaceRoot);
        const historyLimit = config?.contextLimits?.historyLength || 10;
        this.conversationHistory = new ConversationHistory(historyLimit * 2, this._workspaceRoot);
        this.taskPlanner = new InMemoryTaskPlanner(this._extensionContext, (msg) => this.postMessageToWebview(msg));
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : this._workspaceRoot;
        const modelName = getGeminiModel(workspaceRoot);

        const htmlPath = path.join(this._extensionUri.fsPath, 'src', 'webview', 'ui.html');
        try {
            let htmlContent = fs.readFileSync(htmlPath, 'utf8');

            // 2. Replace model name using function replacer so '$' is never interpreted
            htmlContent = htmlContent.replace('gemma-4-31b-it', () => modelName);

            // 3 & 4. Resolve placeholders, check file existence, and build URIs
            const assetSpecs = [
                {
                    placeholder: '{{TAILWIND_CSS_URI}}',
                    name: 'tailwind.css',
                    segments: ['dist', 'tailwind.css']
                },
                {
                    placeholder: '{{MARKED_URI}}',
                    name: 'marked.min.js',
                    segments: ['node_modules', 'marked', 'marked.min.js']
                },
                {
                    placeholder: '{{HIGHLIGHT_JS_URI}}',
                    name: 'highlight.min.js',
                    segments: ['node_modules', '@highlightjs', 'cdn-assets', 'highlight.min.js']
                },
                {
                    placeholder: '{{HIGHLIGHT_CSS_URI}}',
                    name: 'atom-one-dark.min.css',
                    segments: ['node_modules', '@highlightjs', 'cdn-assets', 'styles', 'atom-one-dark.min.css']
                }
            ];

            for (const asset of assetSpecs) {
                const diskPath = path.join(this._extensionUri.fsPath, ...asset.segments);
                if (!fs.existsSync(diskPath)) {
                    console.error(`Ultra Light Agent: missing asset file on disk: ${diskPath}`);
                    vscode.window.showWarningMessage(`Ultra Light Agent: missing asset ${asset.name}`);
                }

                const uri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, ...asset.segments)).toString();
                htmlContent = htmlContent.split(asset.placeholder).join(uri);
            }

            // 5. Inject CSP <meta> right after <head>
            const cspSource = webviewView.webview.cspSource;
            const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: https:; media-src ${cspSource} data: blob:; connect-src ${cspSource} http: https: ws: wss: data: blob:; style-src ${cspSource} 'unsafe-inline' https://fonts.googleapis.com; font-src ${cspSource} https://fonts.gstatic.com; script-src ${cspSource} 'unsafe-inline';">`;
            htmlContent = htmlContent.replace(/<head>/i, `<head>\n    ${cspMeta}`);

            webviewView.webview.html = htmlContent;
        } catch (error: any) {
            console.error('Failed to load Webview HTML:', error);
            const rawErrorMsg = String(error?.stack || error?.message || error);
            const escapedError = rawErrorMsg
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
            webviewView.webview.html = `<h3>Error loading webview template</h3><p>${escapedError}</p>`;
        }

        const dispatchCtx: DispatchContext = {
            workspaceRoot: workspaceRoot || '',
            conversationHistory: this.conversationHistory,
            taskPlanner: this.taskPlanner,
            postMessage: (msg) => this.postMessageToWebview(msg),
            handleChatMessageStream: async (msg) => this.handleChatMessageStream(msg),
            handleRunInTerminal: async (cmd) => this.handleRunInTerminal(cmd),
            handleRequestWorkspaceFiles: async (query) => this.handleRequestWorkspaceFiles(query),
            isEditSessionAutoApproved: this.isEditSessionAutoApproved,
            isTerminalSessionAutoApproved: this.isTerminalSessionAutoApproved,
            setEditSessionAutoApproved: (val) => { this.isEditSessionAutoApproved = val; },
            setTerminalSessionAutoApproved: (val) => { this.isTerminalSessionAutoApproved = val; },
            pendingTerminalResolvers: this.pendingTerminalResolvers,
            pendingEditResolvers: this.pendingEditResolvers,
            getAiMetaDir: (root) => this.getAiMetaDir(root),
            abortCurrentStream: () => {
                this.isTurnAbortedByUser = true;
                if (this.currentAbortController) {
                    this.currentAbortController.abort();
                    this.currentAbortController = null;
                }
            }
        };

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {

                case 'resolveFileChange': {
                    const { callId, approved, autoApproveSession } = message;
                    if (autoApproveSession) {
                        this.isEditSessionAutoApproved = true;
                    }
                    const resolver = this.pendingEditResolvers.get(callId);
                    if (resolver) {
                        resolver(approved, !!autoApproveSession);
                        this.pendingEditResolvers.delete(callId);
                    }
                    return;
                }

                case 'stopGeneration': {
                    this.isTurnAbortedByUser = true;
                    if (this.currentAbortController) {
                        this.currentAbortController.abort();
                        this.currentAbortController = null;
                    }
                    // UI locally resets cleanly; do not emit redundant error chunks
                    return;
                }

                case 'sendChatStream': {
                    const { text, images, timestamp, thinkingBudget, architectMode } = message;

                    this.isTurnAbortedByUser = false;
                    // Fresh abort controller & tool buffer for this turn
                    this.currentAbortController = new AbortController();
                    this.currentTurnToolCalls = [];
                    await this.handleChatMessageStream(message);
                    return;
                }
            }

            await MessageDispatcher.dispatch(message, dispatchCtx);
        });
    }

    public updateWorkspaceRoot(newWorkspaceRoot: string, ragEngine?: any) {
        this._workspaceRoot = newWorkspaceRoot;
        this.ragEngine = ragEngine;
        if (newWorkspaceRoot) {
            ensureAgentConfig(newWorkspaceRoot);
        }
        if (this._view) {
            const config = getAgentConfig(newWorkspaceRoot);
            this.postMessageToWebview({
                command: 'workspaceChanged',
                workspaceRoot: newWorkspaceRoot,
                config: config
            });
        }
    }

    public getAiMetaDir(workspaceRoot: string): string {
        const dir = path.join(workspaceRoot, '.ultra-light-ai');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    private async handleRequestWorkspaceFiles(query: string = ''): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) return;
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const searchPattern = query ? `**/*${query}*` : '**/*';
            const userIgnoreFolders = vscode.workspace.getConfiguration('ultraLightAI').get<string[]>('ignoreFolders') || [];
            const combinedIgnores = Array.from(new Set([...userIgnoreFolders, 'node_modules', '.git', 'dist', 'out', 'build', '.next', '.vscode', '.venv', 'venv', 'coverage', '__pycache__', '.ultra-light-ai']));
            const excludePattern = `{${combinedIgnores.map(f => `**/${f}/**`).join(',')},**/*.lock}`;
            const files = await vscode.workspace.findFiles(searchPattern, excludePattern, 25);
            const relativeFiles = files.map(f => path.relative(workspaceRoot, f.fsPath)).sort((a, b) => a.length - b.length);
            this.postMessageToWebview({
                command: 'provideWorkspaceFiles',
                files: relativeFiles.slice(0, 15)
            });
        } catch (e) {
            console.error("Failed to query workspace files", e);
        }
    }

    public async handleRunInTerminal(command: string, workspaceRoot?: string) {
        const dangerousPatterns = [/rm\s+-r/i, /del\s+\/f/i, /format\s+/i, /diskpart/i, /rmdir\s+\/s/i, /mkfs/i, /shutdown/i];
        if (dangerousPatterns.some(pattern => pattern.test(command))) {
            vscode.window.showErrorMessage('🛡️ Sandbox Blocked: Potentially dangerous command.');
            return;
        }

        const safeCwd = (workspaceRoot && workspaceRoot.trim().length > 0)
            ? workspaceRoot
            : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || this._workspaceRoot);

        let terminal = vscode.window.terminals.find(t => t.name === 'Vakra AI');
        if (!terminal) {
            terminal = vscode.window.createTerminal({
                name: 'Vakra AI',
                cwd: safeCwd
            });
        }
        terminal.show(false); // Pop up the visible terminal tab
        const clean = command.trim();
        terminal.sendText(clean, true);
    }

    private async handleChatMessageStream(message: any): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const workspaceRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : this._workspaceRoot;
            const keys = getGeminiApiKeys(workspaceRoot);
            const model = getGeminiModel(workspaceRoot);
            const timeout = getGeminiTimeout(workspaceRoot);
            const config = getAgentConfig(workspaceRoot);

            const maxOutputTokens = config?.contextLimits?.maxOutputTokens || 8192;
            const maxContextTokens = config?.contextLimits?.maxContextTokens || 40000;
            const maxToolSteps = config?.maxAutonomousToolSteps || 40;

            const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');
            let mainClient;

            const mainBrain = config?.mainBrain;
            const providerType = mainBrain?.providerType || 'cloud';
            const customEndpoint = mainBrain?.endpoint?.trim();
            const keyStr = mainBrain?.apiKey?.trim() || keys[0]?.trim() || '';

            if (providerType === 'apinex') {
                const ep = customEndpoint || 'https://api.apinex.bond/v1';
                mainClient = new LocalOllamaClient(mainBrain?.model || 'free/gpt-5.6-luna', ep, keyStr);
            } else if (providerType === 'openai') {
                const ep = customEndpoint || 'https://api.openai.com/v1';
                mainClient = new LocalOllamaClient(mainBrain?.model || 'gpt-4o', ep, keyStr);
            } else if (customEndpoint && customEndpoint !== 'http://127.0.0.1:11434' && customEndpoint !== 'http://localhost:11434') {
                mainClient = new LocalOllamaClient(mainBrain?.model || model || 'deepseek-chat', customEndpoint, keyStr);
            } else if (providerType === 'local') {
                mainClient = new LocalOllamaClient(mainBrain?.model || 'llama3', mainBrain?.endpoint || 'http://127.0.0.1:11434', keyStr);
            } else {
                if (keyStr.startsWith('sk-apx')) mainClient = new LocalOllamaClient(mainBrain?.model || 'free/gpt-5.6-luna', 'https://api.apinex.bond/v1', keyStr);
                else if (keyStr.startsWith('gsk_')) mainClient = new LocalOllamaClient(model, 'https://api.groq.com/openai', keyStr);
                else if (keyStr.startsWith('sk-or-')) mainClient = new LocalOllamaClient(model, 'https://openrouter.ai/api', keyStr);
                else if (keyStr.startsWith('sk-')) mainClient = new LocalOllamaClient(model, 'https://api.openai.com', keyStr);
                else mainClient = new GeminiCloudClient(keys, model, timeout, maxOutputTokens);
            }

            if (mainClient) {
                mainClient.maxToolIterations = maxToolSteps;
            }

            const promptCategory = PromptClassifier.classifyPrompt(message.text);
            const repoMap = workspaceRoot ? await generateStructuralRepoMap(workspaceRoot, 25) : '';
            let systemInstruction = PromptBuilder.buildSystemInstruction(config, workspaceRoot, false, !!message.architectMode, promptCategory, repoMap, message.thinkingBudget, message.text);

            if (workspaceRoot) {
                try {
                    const matchedSkills = SkillsManager.getMatchingSkills(message.text, workspaceRoot);
                    if (matchedSkills.length > 0) {
                        const firstSkill = matchedSkills[0];
                        const isCustom = !!firstSkill.filePath;
                        let sourcePath = 'Built-in System Skill';
                        if (firstSkill.filePath) {
                            try {
                                sourcePath = path.relative(workspaceRoot, firstSkill.filePath).replace(/\\/g, '/');
                            } catch {
                                sourcePath = firstSkill.filePath;
                            }
                        }

                        this.postMessageToWebview({
                            command: 'activeSkillNotice',
                            skillName: firstSkill.name,
                            isCustom,
                            source: sourcePath,
                            description: firstSkill.description || ''
                        });
                    }
                } catch {}
            }

            this.taskPlanner.syncWithDisk(workspaceRoot);
            this.currentTaskState = PromptBuilder.startTask(workspaceRoot, message.text);
            this.currentTaskState.plan = this.taskPlanner.getPromptPlanSteps();

            let finalPrompt = await this.buildPrompt(message.text, workspaceRoot);

            const turnUserTimestamp = message.timestamp || Date.now();
            this.conversationHistory.addMessage('user', message.text, undefined, turnUserTimestamp);

            const historyLimit = config?.contextLimits?.historyLength || 10;
            const historyTokenLimit = Math.min(12000, maxContextTokens * 0.4);
            const history = this.conversationHistory.getHistoryForLLM(historyLimit, historyTokenLimit);
            const historyWithoutLast = history.slice(0, -1);

            if (!this.currentAbortController) {
                this.currentAbortController = new AbortController();
            }

            const tools = [
                {
                    functionDeclarations: [
                        {
                            name: "read_multiple_files",
                            description: "Reads workspace files with optional line range slicing. Max 3 files at once.",
                            parameters: { 
                                type: "object", 
                                properties: { 
                                    filepaths: { type: "array", items: { type: "string" }, description: "Array of file paths to inspect" },
                                    start_line: { type: "number", description: "Optional starting line number (1-based)" },
                                    end_line: { type: "number", description: "Optional ending line number (1-based)" }
                                }, 
                                required: ["filepaths"] 
                            }
                        },
                        {
                            name: "search_codebase",
                            description: "Performs semantic/textual search across the workspace codebase to find symbols, classes, functions, or keywords.",
                            parameters: {
                                type: "object",
                                properties: {
                                    query: { type: "string", description: "Symbol name, keyword, or query string to search for" }
                                },
                                required: ["query"]
                            }
                        },
                        {
                            name: "search_web",
                            description: "Searches the live web for quick answers, sports scores, documentation snippets, and real-time facts.",
                            parameters: {
                                type: "object",
                                properties: {
                                    query: { type: "string", description: "Search query" }
                                },
                                required: ["query"]
                            }
                        },
                        {
                            name: "create_skill",
                            description: "Creates and registers a reusable workspace skill. Use this when instructed to create a skill or after analyzing samples (blogs, code patterns) to codify permanent rules.",
                            parameters: {
                                type: "object",
                                properties: {
                                    name: { type: "string", description: "Name of the skill (e.g. \"tech-blog-writer\", \"fastapi-crud\")" },
                                    description: { type: "string", description: "What this skill does" },
                                    trigger_rules: { type: "array", items: { type: "string" }, description: "Keywords or phrases that trigger this skill automatically" },
                                    instructions: { type: "string", description: "Detailed step-by-step rules, patterns, tone guidelines, and execution protocols for this skill" }
                                },
                                required: ["name", "instructions"]
                            }
                        },
                        {
                            name: "read_skill",
                            description: "Reads the full instructions and execution protocol of a specific workspace skill.",
                            parameters: {
                                type: "object",
                                properties: {
                                    skill_name: { type: "string", description: "Name of the skill to read (e.g. 'code-reviewer', 'django-fullstack')" }
                                },
                                required: ["skill_name"]
                            }
                        },
                        {
                            name: 'finish',
                            description: 'Concludes the task. Call this when all checklist items and verifications pass.',
                            parameters: {
                                type: 'object',
                                properties: {
                                    summary: { type: 'string', description: 'Concise 2-3 sentence overview of changes made and verification results. No code blocks.' }
                                },
                                required: ['summary']
                            }
                        },
                        {
                            name: "write_file",
                            description: "Writes full file content to disk. Used to create files.",
                            parameters: { type: "object", properties: { filepath: { type: "string" }, content: { type: "string" } }, required: ["filepath", "content"] }
                        },
                        {
                            name: "edit_file",
                            description: "Replaces exact old_text snippet with new_text in an existing file.",
                            parameters: { type: "object", properties: { filepath: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["filepath", "old_text", "new_text"] }
                        },
                        {
                            name: "execute_terminal_command",
                            description: "Executes a shell command in the integrated terminal.",
                            parameters: { type: "object", properties: { command: { type: "string" }, explanation: { type: "string" } }, required: ["command"] }
                        },
                        {
                            name: "list_directory_tree",
                            description: "Explores the workspace directory structure.",
                            parameters: { type: "object", properties: { dir: { type: "string" }, depth: { type: "number" } } }
                        },
                        {
                            name: "research_web_docs",
                            description: "Researches official online web docs, package APIs, and technical guides from top authoritative websites. Supports offset pagination to stream and read long documentation without truncation.",
                            parameters: { 
                                type: "object", 
                                properties: { 
                                    query: { type: "string", description: "Topic, library, or error to research" }, 
                                    urls: { type: "array", items: { type: "string" }, description: "Optional specific URLs to consult (max 2 authoritative sources)" },
                                    offset: { type: "number", description: "Character offset to read the next chunk of long documentation (default 0)" }
                                }, 
                                required: ["query"] 
                            }
                        }
                    ]
                }
            ];

            const turnExecutedToolCards: Array<{ tool: string; title: string; data: any }> = [];

            let isInsideThink = false;
            let currentTurnBuffer = '';
            const detectedToolCalls: any[] = [];

            const onToolCall = async (functionCall: any) => {
                detectedToolCalls.push(functionCall);

                // Immediate live status update for the activity bar
                let toolStatus = `⚡ Running: ${functionCall.name}...`;
                const toolArgs = functionCall.args || functionCall.arguments || {};
                if (functionCall.name === 'read_multiple_files') {
                    const files = toolArgs.filepaths || [];
                    toolStatus = `📖 Reading: ${Array.isArray(files) ? files.map((f: string) => path.basename(f)).join(', ') : files}`;
                } else if (functionCall.name === 'write_file') {
                    toolStatus = `✏️ Writing: ${path.basename(toolArgs.filepath || 'file')}`;
                } else if (functionCall.name === 'edit_file') {
                    toolStatus = `⚡ Editing: ${path.basename(toolArgs.filepath || 'file')}`;
                } else if (functionCall.name === 'search_codebase') {
                    toolStatus = `🔍 Searching: "${toolArgs.query || ''}"`;
                } else if (functionCall.name === 'search_web' || functionCall.name === 'research_web_docs') {
                    toolStatus = `🌐 Searching web: "${toolArgs.query || ''}"`;
                } else if (functionCall.name === 'run_in_terminal') {
                    toolStatus = `💻 Running: ${toolArgs.command || ''}`;
                }
                this.postMessageToWebview({
                    command: 'statusUpdate',
                    text: toolStatus
                });

                return await ToolDispatcher.dispatch(functionCall, {
                    workspaceRoot: workspaceRoot || '',
                    postMessage: (msg) => {
                        if (msg.command === 'toolCallEvent') {
                            this.currentTurnToolCalls.push({
                                tool: msg.tool,
                                title: msg.title || '',
                                data: msg.data || {}
                            });
                            turnExecutedToolCards.push({ tool: msg.tool, title: msg.title, data: msg.data });
                        }
                        this.postMessageToWebview(msg);
                    },
                    signal: this.currentAbortController?.signal,
                    isEditSessionAutoApproved: this.isEditSessionAutoApproved,
                    isTerminalSessionAutoApproved: this.isTerminalSessionAutoApproved,
                    pendingTerminalResolvers: this.pendingTerminalResolvers,
                    pendingEditResolvers: this.pendingEditResolvers,
                    taskPlanner: this.taskPlanner,
                    currentTaskState: this.currentTaskState,
                    ragEngine: this.ragEngine,
                    recordFileBackup: (filepath: string, oldContent: string | null) => {
                        this.conversationHistory.addFileBackup(turnUserTimestamp, filepath, oldContent);
                    }
                });
            };

            const result = await mainClient.completeWithHistory({
                prompt: finalPrompt,
                images: message.images || [],
                signal: this.currentAbortController?.signal,
                history: historyWithoutLast,
                systemInstruction: systemInstruction,
                stream: true,
                onChunk: (chunk: any) => {
                    if (this.currentAbortController?.signal?.aborted) return;

                    if (chunk.text) {
                        currentTurnBuffer += chunk.text;
                        const text = chunk.text;
                        if (text.includes('<think>')) isInsideThink = true;

                        if (isInsideThink) {
                            this.postMessageToWebview({
                                command: 'thinkingChunk',
                                text: text.replace(/<\/?think>/g, '')
                            });
                            if (text.includes('</think>')) isInsideThink = false;
                        } else {
                            if (chunk.isThinking) {
                                this.postMessageToWebview({
                                    command: 'thinkingChunk',
                                    text: text
                                });
                            } else {
                                this.postMessageToWebview({
                                    command: 'streamChunk',
                                    text: text,
                                    done: false
                                });
                            }
                        }
                    }
                    if (chunk.tool_calls && chunk.tool_calls.length > 0) {
                        detectedToolCalls.push(...chunk.tool_calls);
                    }
                },
                tools,
                onToolCall
            });

            if (this.isTurnAbortedByUser) {
                this.currentAbortController = null;
                return;
            }

            this.currentAbortController = null;

            // TurnGate Resolution
            if (detectedToolCalls.length === 0) {
                // Fallback: check if tool call is wrapped inside markdown/json text
                const jsonMatch = currentTurnBuffer.match(/```json\s*([\s\S]*?)\s*```/) || currentTurnBuffer.match(/(\{[\s\S]*"name"\s*:\s*".*?"[\s\S]*\})/);
                if (jsonMatch) {
                    try {
                        const parsed = JSON.parse(jsonMatch[1]);
                        if (parsed.name) detectedToolCalls.push(parsed);
                    } catch {}
                }
            }

            // If finish tool called or pure conversational response
            const finishCall = detectedToolCalls.find(t => t.name === 'finish');
            if (finishCall) {
                const summary = finishCall.args?.summary || finishCall.arguments?.summary || 'Task completed successfully.';
                // Sanitize any remaining code fences from summary
                const cleanSummary = summary.replace(/```[\s\S]*?(```|$)/g, '[Code changes applied to workspace files]');
                this.postMessageToWebview({
                    command: 'streamChunk',
                    text: cleanSummary,
                    done: true,
                    usage: result?.usage
                });
                const summaryWithRecap = this.formatTurnExecutionRecap(cleanSummary, this.currentTurnToolCalls);
                this.conversationHistory.addMessage(
                    'model',
                    summaryWithRecap,
                    result?.usage,
                    [...this.currentTurnToolCalls]
                );
                this.currentTurnToolCalls = [];
                this.currentAbortController = null;
                return;
            }

            // TurnGate Resolution: Always ensure stream terminates cleanly
            const totalToolCallsInTurn = this.currentTurnToolCalls.length + detectedToolCalls.length;
            const rawContent = (result?.text || currentTurnBuffer || '');
            let clean = rawContent
                .replace(/<think>[\s\S]*?<\/think>/gi, '')
                .replace(/<think>[\s\S]*$/i, '')
                .replace(/<\/think>/gi, '')
                .trim();
            if (!clean && rawContent) {
                clean = rawContent.replace(/<[^>]+>/g, '').trim();
            }

            this.postMessageToWebview({
                command: 'streamChunk',
                text: clean || (totalToolCallsInTurn > 0 ? '' : 'Done.'),
                done: true,
                usage: result?.usage
            });

            if (result?.usage) {
                this.postMessageToWebview({
                    command: 'tokenUsage',
                    usage: result.usage
                });
            }

            const messageWithRecap = this.formatTurnExecutionRecap(clean || 'Done.', this.currentTurnToolCalls);
            this.conversationHistory.addMessage(
                'model',
                messageWithRecap,
                result?.usage,
                [...this.currentTurnToolCalls]
            );
            this.currentTurnToolCalls = [];
        } catch (error: any) {
            if (this.isTurnAbortedByUser || error?.name === 'AbortError' || this.currentAbortController?.signal?.aborted || error?.message?.includes('aborted') || error?.message?.includes('stopped')) {
                // User aborted cleanly - suppress error banner
                return;
            }
            this.postMessageToWebview({
                command: 'streamChunk',
                text: `\n\n**Error:** ${error.message || 'Execution error'}`,
                done: true
            });
        } finally {
            this.currentAbortController = null;
            this.currentTurnToolCalls = [];
            this.isTurnAbortedByUser = false;
        }
    }

    private async buildPrompt(text: string, workspaceRoot?: string): Promise<string> {
        let finalPrompt = text;
        let contextSources: ContextSource[] = [];

        if (workspaceRoot) {
            try {
                const activeSkill = SkillsManager.getMatchingSkillInstructions(text, workspaceRoot);
                if (activeSkill) {
                    contextSources.push({
                        name: 'Mandatory Active Skill Protocol',
                        content: activeSkill,
                        priority: 10
                    });
                }
            } catch (err) {
                console.error('[buildPrompt] Error fetching active skill:', err);
            }

            const errorContexts = ErrorDiagnoser.extractErrors(finalPrompt + '\n' + TerminalCapture.getLastOutput(), workspaceRoot);
            if (errorContexts.length > 0) {
                let diagStr = '### ERROR DIAGNOSTICS ###\n' + errorContexts.map(c => c.codeSnippet).join('\n');
                contextSources.push({ name: 'Error Diagnostics', content: diagStr, priority: 9 });
            }
        }

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const doc = editor.document;
            const content = doc.getText();
            contextSources.push({
                name: `Active file: ${path.basename(doc.fileName)}`,
                content: `\`\`\`${doc.languageId}\n${estimateTokens(content) > 1500 ? truncateToTokens(content, 1500) : content}\n\`\`\``,
                priority: 5
            });
        }

        if (contextSources.length > 0) {
            const allocated = allocateBudget(5000, contextSources);
            const contextStr = allocated.map(a => `--- ${a.name} ---\n${a.content}`).join('\n\n');
            finalPrompt = `--- Context ---\n${contextStr}\n\n--- User Request ---\n${finalPrompt}`;
        }

        return finalPrompt;
    }

    public postMessageToWebview(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    public clearChat(): void {
        this.conversationHistory.clear();
        this.taskPlanner.clear();
        this.postMessageToWebview({ command: 'chatCleared' });
    }

    private formatTurnExecutionRecap(baseText: string, toolCalls: Array<{ tool: string; title: string; data: any }>): string {
        if (!toolCalls || toolCalls.length === 0) return baseText;
        const readFiles = new Set<string>();
        const writtenFiles = new Set<string>();
        const editedFiles = new Set<string>();
        const commandsRun: string[] = [];
        const errorsEncountered: string[] = [];

        for (const tc of toolCalls) {
            const tool = tc.tool;
            const d = tc.data || {};
            if (tool === 'read_multiple_files') {
                if (d.files) d.files.split(',').forEach((f: string) => readFiles.add(f.trim()));
            } else if (tool === 'write_file') {
                if (d.filepath) writtenFiles.add(d.filepath);
            } else if (tool === 'edit_file') {
                if (d.filepath) editedFiles.add(d.filepath);
            } else if (tool === 'execute_terminal_command') {
                if (d.command) commandsRun.push(d.command);
                if (d.error || (d.output && /fatal|error|exception|traceback|syntaxerror/i.test(d.output))) {
                    const errSnippet = (d.output || '').split('\n').filter((l: string) => /fatal|error|exception|traceback/i.test(l)).slice(0, 2).join('; ');
                    if (errSnippet) errorsEncountered.push(`${d.command}: ${errSnippet.slice(0, 160)}`);
                }
            }
        }

        const recapLines: string[] = ['[PREVIOUS TURN EXECUTION RECORD]'];
        if (readFiles.size > 0) recapLines.push(`- Files Inspected: ${Array.from(readFiles).join(', ')}`);
        if (writtenFiles.size > 0) recapLines.push(`- Files Created: ${Array.from(writtenFiles).join(', ')}`);
        if (editedFiles.size > 0) recapLines.push(`- Files Edited: ${Array.from(editedFiles).join(', ')}`);
        if (commandsRun.length > 0) recapLines.push(`- Terminal Commands: ${commandsRun.slice(-4).join(' | ')}`);
        if (errorsEncountered.length > 0) recapLines.push(`- Errors Encountered: ${errorsEncountered.slice(-3).join(' || ')}`);

        if (recapLines.length === 1) return baseText;
        const recap = recapLines.join('\n');
        return baseText ? `${recap}\n\n${baseText}` : recap;
    }
}
