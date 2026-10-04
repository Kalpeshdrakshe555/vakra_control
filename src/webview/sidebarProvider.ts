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
import { autonomousPreFlightScout } from '../tools/scraper';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private conversationHistory: ConversationHistory;
    private taskPlanner: InMemoryTaskPlanner;
    private currentAbortController: AbortController | null = null;
    private isTerminalSessionAutoApproved: boolean = false;
    private isEditSessionAutoApproved: boolean = false;
    private pendingTerminalResolvers: Map<string, (result: string) => void> = new Map();
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
            const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline' https://fonts.googleapis.com; font-src ${cspSource} https://fonts.gstatic.com; script-src ${cspSource} 'unsafe-inline';">`;
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
            getAiMetaDir: (root) => this.getAiMetaDir(root),
            abortCurrentStream: () => {
                if (this.currentAbortController) {
                    this.currentAbortController.abort();
                    this.currentAbortController = null;
                }
            }
        };

        webviewView.webview.onDidReceiveMessage(async (message) => {
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

    private async handleRunInTerminal(command: string) {
        const dangerousPatterns = [/rm\s+-r/i, /del\s+\/f/i, /format\s+/i, /diskpart/i, /rmdir\s+\/s/i, /mkfs/i, /shutdown/i];
        if (dangerousPatterns.some(pattern => pattern.test(command))) {
            vscode.window.showErrorMessage('🛡️ Sandbox Blocked: Potentially dangerous command.');
            return;
        }

        let terminal = vscode.window.terminals.find(t => t.name === 'Ultra Light AI') || vscode.window.createTerminal('Ultra Light AI');
        terminal.show();
        const safeCommand = command.trim().split(/\r?\n/).filter(line => line.trim().length > 0).join(' && ');
        terminal.sendText(safeCommand, true);
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
            const maxContextTokens = config?.contextLimits?.maxContextTokens || 7000;
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

            this.taskPlanner.syncWithDisk(workspaceRoot);
            this.currentTaskState = PromptBuilder.startTask(workspaceRoot, message.text);
            this.currentTaskState.plan = this.taskPlanner.getPromptPlanSteps();

            let finalPrompt = await this.buildPrompt(message.text, workspaceRoot);

            try {
                const liveDocs = await autonomousPreFlightScout(message.text);
                if (liveDocs) finalPrompt = `${liveDocs}\n\n${finalPrompt}`;
            } catch {}

            this.conversationHistory.addMessage('user', message.text, undefined, message.timestamp);

            const historyLimit = config?.contextLimits?.historyLength || 10;
            const historyTokenLimit = Math.min(12000, maxContextTokens * 0.4);
            const history = this.conversationHistory.getHistoryForLLM(historyLimit, historyTokenLimit);
            const historyWithoutLast = history.slice(0, -1);

            this.currentAbortController = new AbortController();

            const tools = [
                {
                    functionDeclarations: [
                        {
                            name: "read_multiple_files",
                            description: "Reads workspace files. Max 3 at once.",
                            parameters: { type: "object", properties: { filepaths: { type: "array", items: { type: "string" } } }, required: ["filepaths"] }
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
                            description: "Researches official online web docs, package APIs, and library guides.",
                            parameters: { type: "object", properties: { query: { type: "string" }, urls: { type: "array", items: { type: "string" } } }, required: ["query"] }
                        }
                    ]
                }
            ];

            const turnExecutedToolCards: Array<{ tool: string; title: string; data: any }> = [];

            const onToolCall = async (functionCall: any) => {
                return await ToolDispatcher.dispatch(functionCall, {
                    workspaceRoot: workspaceRoot || '',
                    postMessage: (msg) => {
                        if (msg.command === 'toolCallEvent') {
                            turnExecutedToolCards.push({ tool: msg.tool, title: msg.title, data: msg.data });
                        }
                        this.postMessageToWebview(msg);
                    },
                    signal: this.currentAbortController?.signal,
                    isEditSessionAutoApproved: this.isEditSessionAutoApproved,
                    isTerminalSessionAutoApproved: this.isTerminalSessionAutoApproved,
                    pendingTerminalResolvers: this.pendingTerminalResolvers,
                    taskPlanner: this.taskPlanner,
                    currentTaskState: this.currentTaskState,
                    ragEngine: this.ragEngine
                });
            };

            let currentTurnBuffer = '';
            const detectedToolCalls: any[] = [];

            const result = await mainClient.completeWithHistory(
                systemInstruction,
                historyWithoutLast,
                finalPrompt,
                true,
                (chunk: any) => {
                    if (this.currentAbortController?.signal?.aborted) return;

                    if (chunk.text) {
                        currentTurnBuffer += chunk.text;
                        // Forward thinking/reasoning text to UI
                        this.postMessageToWebview({
                            command: 'thinkingChunk',
                            text: chunk.text
                        });
                    }
                    if (chunk.tool_calls && chunk.tool_calls.length > 0) {
                        detectedToolCalls.push(...chunk.tool_calls);
                    }
                },
                this.currentAbortController?.signal,
                tools,
                onToolCall
            );

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
                this.conversationHistory.addMessage('model', cleanSummary, result?.usage, turnExecutedToolCards);
                this.currentAbortController = null;
                return;
            }

            // TurnGate Resolution: Always ensure stream terminates cleanly
            if (detectedToolCalls.length === 0) {
                // If model just spoke text (even if it contains backticks or <think> tags)
                // strip reasoning tags and deliver message
                const cleanedText = currentTurnBuffer
                    .replace(/<think>[\s\S]*?<\/think>/gi, '')
                    .trim();

                this.postMessageToWebview({
                    command: 'streamChunk',
                    text: cleanedText || 'Done.',
                    done: true,
                    usage: result?.usage
                });
                this.conversationHistory.addMessage('model', cleanedText || 'Done.', result?.usage, turnExecutedToolCards);
                this.currentAbortController = null;
                return;
            }

            if (result?.text) {
                let clean = result.text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/<\/think>/gi, '').trim();
                if (!clean && result.text) {
                    clean = result.text.replace(/<[^>]+>/g, '').trim();
                }
                this.postMessageToWebview({
                    command: 'streamChunk',
                    text: clean || 'Done.',
                    done: true,
                    usage: result.usage
                });
                this.conversationHistory.addMessage('model', clean || 'Done.', result.usage, turnExecutedToolCards);
            }
        } catch (error: any) {
            const wasAborted = this.currentAbortController?.signal?.aborted || error?.message?.includes('aborted');
            this.currentAbortController = null;
            if (!wasAborted) {
                this.postMessageToWebview({
                    command: 'streamChunk',
                    text: `\n\nError: ${error?.message || error}`,
                    done: true
                });
            }
        }
    }

    private async buildPrompt(text: string, workspaceRoot?: string): Promise<string> {
        let finalPrompt = text;
        let contextSources: ContextSource[] = [];

        if (workspaceRoot) {
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
}
