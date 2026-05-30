import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GeminiCloudClient } from '../router/realClients';
import { applyDiffToActiveFile } from '../operations/diffPatcher';
import { getGeminiApiKeys, getGeminiModel, getGeminiTimeout, getAgentConfig, AgentConfig } from '../config';
import { ConversationHistory } from '../state/conversationHistory';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private conversationHistory: ConversationHistory;
    private currentStreamAbortController: AbortController | null = null;
    private currentSeqOp: any = null; // Store reference to cancel Architect queue

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _onStartCb: (config: any) => void,
        private readonly _onResetCb: () => void,
        private readonly ragEngine?: any
    ) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;
        this.conversationHistory = new ConversationHistory(20, workspaceRoot);
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
        const workspaceRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;
        const modelName = getGeminiModel(workspaceRoot);

        const htmlPath = path.join(this._extensionUri.fsPath, 'src', 'webview', 'ui.html');
        try {
            let htmlContent = fs.readFileSync(htmlPath, 'utf8');
            htmlContent = htmlContent.replace('gemma-4-31b-it', modelName);
            webviewView.webview.html = htmlContent;
        } catch (error) {
            console.error('Failed to load Webview HTML:', error);
            webviewView.webview.html = `<h3>Error loading webview template</h3><p>${error}</p>`;
        }

        // Handle message events from Webview UI
        webviewView.webview.onDidReceiveMessage(async message => {
            if (message.command === 'ready') {
                const config = getAgentConfig(workspaceRoot);
                const vsConfig = vscode.workspace.getConfiguration('ultraLightAI');
                this.postMessageToWebview({
                    command: 'loadSettings',
                    config: {
                        provider: config?.activeProvider || 'cloud',
                        model: (config?.activeProvider === 'local' ? config?.providers?.local?.model : config?.providers?.cloud?.model) || getGeminiModel(workspaceRoot),
                        apiKey: config?.providers?.cloud?.apiKey || '',
                        localEndpoint: config?.providers?.local?.endpoint || 'http://127.0.0.1:11434',
                        timeoutSeconds: config?.providers?.cloud?.timeoutSeconds || 60,
                        systemInstructions: config?.systemInstructions || 'You are an AI coding agent. Always wrap your code solutions in standard markdown code blocks. Provide the complete code file content so it can be directly applied.',
                        maxTokens: config?.contextLimits?.maxTokens || 8000,
                        historyLength: config?.contextLimits?.historyLength || 2,
                        enableInlineCompletions: vsConfig.get('enableInlineCompletions', false),
                        enableHoverExplanations: vsConfig.get('enableHoverExplanations', false)
                    }
                });

                // Restore chat history
                const messages = this.conversationHistory.getAllMessages();
                if (messages && messages.length > 0) {
                    this.postMessageToWebview({
                        command: 'restoreHistory',
                        messages: messages
                    });
                }
            } else if (message.command === 'start') {
                this._onStartCb(message.data);
            } else if (message.command === 'reset') {
                if (this._onResetCb) {
                    this._onResetCb();
                }
            } else if (message.command === 'sendChat') {
                await this.handleChatMessage(message.text, message.includeActiveFile);
            } else if (message.command === 'sendChatStream') {
                await this.handleChatMessageStream(message);
            } else if (message.command === 'applyDiff') {
                try {
                    await applyDiffToActiveFile(message.text);
                    vscode.window.showInformationMessage('✨ Code applied successfully!');
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to apply code: ${error?.message || error}`);
                }
            } else if (message.command === 'saveSettings') {
                await this.handleSaveSettings(message);
            } else if (message.command === 'applyWorkspaceEdits') {
                await this.handleApplyWorkspaceEdits(message);
            } else if (message.command === 'openConfig') {
                this.handleOpenConfig();
            } else if (message.command === 'newChat') {
                this.conversationHistory.clear();
                if (this._onResetCb) {
                    this._onResetCb();
                }
                this.postMessageToWebview({ command: 'chatCleared' });
            } else if (message.command === 'rollbackChat') {
                if (message.timestamp) {
                    const success = this.conversationHistory.rollbackToTimestamp(message.timestamp);
                    if (success) {
                        this.postMessageToWebview({
                            command: 'restoreHistory',
                            messages: this.conversationHistory.getAllMessages()
                        });
                        vscode.window.showInformationMessage('⏪ Chat rolled back. Press Ctrl+Z in the editor to undo code changes.');
                    }
                }
            } else if (message.command === 'getSessions') {
                this.postMessageToWebview({
                    command: 'showSessions',
                    sessions: this.conversationHistory.getAllSessionsSummary()
                });
            } else if (message.command === 'switchSession') {
                if (message.id) {
                    this.conversationHistory.switchSession(message.id);
                    this.postMessageToWebview({
                        command: 'restoreHistory',
                        messages: this.conversationHistory.getAllMessages()
                    });
                }
            } else if (message.command === 'deleteSession') {
                if (message.id) {
                    this.conversationHistory.deleteSession(message.id);
                    this.postMessageToWebview({
                        command: 'showSessions',
                        sessions: this.conversationHistory.getAllSessionsSummary()
                    });
                    this.postMessageToWebview({
                        command: 'restoreHistory',
                        messages: this.conversationHistory.getAllMessages()
                    });
                }
            } else if (message.command === 'executeCommand') {
                const { exec } = require('child_process');
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
                if (!workspaceRoot) {
                    vscode.window.showErrorMessage('No workspace open to run commands.');
                    return;
                }
                
                vscode.window.showInformationMessage(`Running: ${message.cmd}`);
                
                exec(message.cmd, { cwd: workspaceRoot, timeout: 30000 }, (error: any, stdout: string, stderr: string) => {
                    let output = '';
                    if (error) {
                        output += `Exit Code/Error: ${error.message}\n`;
                    }
                    if (stderr) {
                        output += `STDERR:\n${stderr}\n`;
                    }
                    if (stdout) {
                        output += `STDOUT:\n${stdout}\n`;
                    }
                    
                    if (!output.trim()) output = "Command executed successfully with no output.";
                    
                    if (output.length > 2500) {
                        output = output.substring(0, 2500) + '\n...[output truncated due to length]';
                    }

                    const autoReply = `[Terminal Output for \`${message.cmd}\`]\n\`\`\`\n${output}\n\`\`\`\nPlease review this output and continue your task.`;
                    
                    this.postMessageToWebview({
                        command: message.autoReply ? 'injectChatAndSend' : 'injectChat',
                        text: autoReply
                    });
                });
            } else if (message.command === 'deleteChat') {
                if (message.timestamp) {
                    const success = this.conversationHistory.deleteMessageByTimestamp(message.timestamp);
                    if (success) {
                        this.postMessageToWebview({
                            command: 'restoreHistory',
                            messages: this.conversationHistory.getAllMessages()
                        });
                    }
                }
            } else if (message.command === 'cancelChat') {
                if (this.currentStreamAbortController) {
                    this.currentStreamAbortController.abort();
                    this.currentStreamAbortController = null;
                }
                if (this.currentSeqOp) {
                    this.currentSeqOp.cancelQueue();
                    this.currentSeqOp = null;
                }
            } else if (message.command === 'runInTerminal') {
                this.handleRunInTerminal(message.text);
            } else if (message.command === 'insertToEditor') {
                await this.handleInsertToEditor(message.text);
            } else if (message.command === 'copyToClipboard') {
                await vscode.env.clipboard.writeText(message.text);
                vscode.window.showInformationMessage('📋 Copied to clipboard!');
            } else if (message.command === 'openFile') {
                await this.handleOpenFile(message.filepath);
            } else if (message.command === 'previewDiff') {
                await this.handlePreviewDiff(message.file);
            }
        });
    }

    private async handlePreviewDiff(fileInfo: any): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folder open.');
            }
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const fullPath = path.join(workspaceRoot, fileInfo.filepath);
            
            let originalContent = '';
            if (fs.existsSync(fullPath)) {
                originalContent = fs.readFileSync(fullPath, 'utf8');
            }

            let newContent = originalContent;
            
            // Check if the AI used Search/Replace blocks
            if (fileInfo.content.includes('<<<<<<< SEARCH') && fileInfo.content.includes('>>>>>>> REPLACE')) {
                const blockRegex = /<<<<<<<\s*SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>\s*REPLACE/g;
                let match;
                let blocksFound = false;
                
                while ((match = blockRegex.exec(fileInfo.content)) !== null) {
                    blocksFound = true;
                    const searchStr = match[1];
                    const replaceStr = match[2];
                    const { applyRobustSearchReplace } = require('../operations/diffPatcher');
                    const patchResult = applyRobustSearchReplace(newContent, searchStr, replaceStr);
                    if (patchResult.success) {
                        newContent = patchResult.patched;
                    }
                }
                
                if (!blocksFound) {
                    newContent = fileInfo.content;
                }
            } else {
                newContent = fileInfo.content;
            }

            // Create temporary files for diff
            const os = require('os');
            const tempDir = os.tmpdir();
            const originalFile = path.join(tempDir, `original_${path.basename(fileInfo.filepath)}`);
            const modifiedFile = path.join(tempDir, `modified_${path.basename(fileInfo.filepath)}`);
            
            fs.writeFileSync(originalFile, originalContent, 'utf8');
            fs.writeFileSync(modifiedFile, newContent, 'utf8');
            
            await vscode.commands.executeCommand('vscode.diff', 
                vscode.Uri.file(originalFile), 
                vscode.Uri.file(modifiedFile), 
                `Preview: ${fileInfo.filepath}`
            );
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to preview diff: ${e.message}`);
        }
    }

    /**
     * Handle chat message — non-streaming (fallback)
     */
    private async handleChatMessage(text: string, includeActiveFile: boolean = false): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const workspaceRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;
            const keys = getGeminiApiKeys(workspaceRoot);
            const model = getGeminiModel(workspaceRoot);
            const timeout = getGeminiTimeout(workspaceRoot);
            const config = getAgentConfig(workspaceRoot);
            const maxTokens = config?.contextLimits?.maxTokens || 8000;
            
            let client;
            if (config?.activeProvider === 'local') {
                const { LocalOllamaClient } = require('../router/realClients');
                const endpoint = config.providers?.local?.endpoint || 'http://127.0.0.1:11434';
                const localModel = config.providers?.local?.model || 'llama3';
                client = new LocalOllamaClient(localModel, endpoint);
            } else {
                client = new GeminiCloudClient(keys, model, timeout, maxTokens);
            }
            
            // Note: message isn't passed here as this method is called via fallback, but let's assume agentMode is false for now
            // if we need it we can update the signature later.
            const systemInstruction = this.buildSystemInstruction(config, workspaceRoot, false);
            let finalPrompt = await this.buildPrompt(text, includeActiveFile, false, workspaceRoot);

            // Add user message to history
            this.conversationHistory.addMessage('user', finalPrompt);

            // Trim history to fit token budget
            this.conversationHistory.trimToTokenBudget(maxTokens);

            // Use multi-turn API
            const history = this.conversationHistory.getHistory(
                config?.contextLimits?.historyLength || 20
            );

            // Remove the last user message from history since we pass it separately
            const historyWithoutLast = history.slice(0, -1);

            const reply = await client.completeWithHistory(
                systemInstruction,
                historyWithoutLast,
                finalPrompt
            );

            // Add AI response to history
            this.conversationHistory.addMessage('model', reply.text, reply.usage);

            this.postMessageToWebview({
                command: 'receiveChat',
                text: reply.text,
                usage: reply.usage
            });
        } catch (error: any) {
            this.postMessageToWebview({
                command: 'receiveChat',
                text: `Error: ${error?.message || error}`
            });
        }
    }

    /**
     * Handle chat message — streaming (preferred)
     */
    private async handleChatMessageStream(message: any): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const workspaceRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;
            const keys = getGeminiApiKeys(workspaceRoot);
            const model = getGeminiModel(workspaceRoot);
            const timeout = getGeminiTimeout(workspaceRoot);
            const config = getAgentConfig(workspaceRoot);

            let client;
            const maxTokens = config?.contextLimits?.maxTokens || 8000;
            if (config?.activeProvider === 'local') {
                const { LocalOllamaClient } = require('../router/realClients');
                const endpoint = config.providers?.local?.endpoint || 'http://127.0.0.1:11434';
                const localModel = config.providers?.local?.model || 'llama3';
                client = new LocalOllamaClient(localModel, endpoint);
            } else {
                client = new GeminiCloudClient(keys, model, timeout, maxTokens);
            }
            
            const systemInstruction = this.buildSystemInstruction(config, workspaceRoot, message.agentMode, message.architectMode);
            let finalPrompt = await this.buildPrompt(message.text, message.includeActiveFile, message.includeWebSearch, message.includeWorkspace, workspaceRoot);

            // Add user message to history
            this.conversationHistory.addMessage('user', finalPrompt, undefined, message.timestamp);
            this.conversationHistory.trimToTokenBudget(config?.contextLimits?.maxTokens || 8000);

            const history = this.conversationHistory.getHistory(
                config?.contextLimits?.historyLength || 20
            );
            const historyWithoutLast = history.slice(0, -1);

            this.currentStreamAbortController = new AbortController();

            // Stream response
            const result = await client.completeWithHistory(
                systemInstruction,
                historyWithoutLast,
                finalPrompt,
                true, // stream
                (chunk) => {
                    this.postMessageToWebview({
                        command: 'streamChunk',
                        text: chunk.text,
                        done: chunk.done,
                        usage: chunk.usage
                    });
                },
                this.currentStreamAbortController.signal
            );

            this.currentStreamAbortController = null;

            // Add AI response to history
            this.conversationHistory.addMessage('model', result.text, result.usage);

            // Removed complex JSON background queue. We now rely on conversational step-by-step.
            if (message.architectMode) {
                this.postMessageToWebview({
                    command: 'streamChunk',
                    text: `\n\n> 🏢 **Architect Mode:** Please review and click **Apply** on the files above. Reply with **"Next"** to continue building the project.`,
                    done: true
                });
            }

        } catch (error: any) {
            this.currentStreamAbortController = null;
            this.postMessageToWebview({
                command: 'streamChunk',
                text: `\n\nError: ${error?.message || error}`,
                done: true
            });
        }
    }

    /**
     * Builds the system instruction with multi-file and context directives.
     */
    private buildSystemInstruction(config: AgentConfig | null, workspaceRoot?: string, isAgentMode: boolean = false, isArchitectMode: boolean = false): string {
        let systemInstruction = config?.systemInstructions || 
            'You are an AI coding agent. Always wrap your code solutions in standard markdown code blocks.';
        
        systemInstruction = systemInstruction.replace(/Provide the complete code file content so it can be directly applied\.?/g, '').trim();
        
        systemInstruction += `
You are an expert debugger and 10x developer. Always think step-by-step before making changes.
When modifying existing code, DO NOT rewrite the entire file unless asked. Use Search and Replace blocks to patch specific lines or functions.
Format the blocks exactly like this:

**\`src/filepath.ext\`**
\`\`\`javascript
<<<<<<< SEARCH
exact code to be replaced
=======
new updated code
>>>>>>> REPLACE
\`\`\`

CRITICAL: The SEARCH block MUST perfectly match the existing code, including indentation.
You can include multiple Search/Replace blocks for the same file if needed.
If you MUST provide a complete file rewrite, format it like this without the search/replace markers:
**\`src/filepath.ext\`**
\`\`\`javascript
// full code here
\`\`\`

You have the ability to run Terminal commands to test your code, debug, or install dependencies.
If you need to execute a command, output ONLY ONE command inside a special block like this:

<run_command>
npm run test
</run_command>

IMPORTANT: Stop generating immediately after a <run_command>.`;

        if (isArchitectMode) {
            systemInstruction += `\n\n[ARCHITECT MODE ACTIVE]: You are building a large project or feature. 
CRITICAL RULE: If the user requests a framework that uses CLI tools (e.g., Django, React, Vue, Angular, Next.js), ALWAYS use <run_command> to generate the boilerplate scaffold FIRST. Do NOT write boilerplate files manually.
After running commands or if making custom files, DO NOT generate all files at once. Generate a MAXIMUM of 1 or 2 files per turn. Output their complete code in markdown blocks so the user can apply them. Then STOP and ask the user to reply "Next" to continue. Maintain perfect context of what you have generated.`;
        }

        if (isAgentMode) {
            systemInstruction += `\n[AGENT MODE ACTIVE]: The user has authorized you to run commands autonomously. The system will auto-execute your <run_command> blocks and immediately feed the output back to you. Use this to iteratively debug, run tests, and fix code without waiting for user approval.`;
        } else {
            systemInstruction += `\nIMPORTANT: The user must manually approve your command. You will receive the output in the next turn if they run it.`;
        }
        
        systemInstruction += `\nAlways provide clear, concise, and actionable responses.`;
        
        // Add Project-specific rules
        if (workspaceRoot) {
            const agentRulesPath = path.join(workspaceRoot, '.agentrules');
            const cursorRulesPath = path.join(workspaceRoot, '.cursorrules');
            
            if (fs.existsSync(agentRulesPath)) {
                systemInstruction += `\n\n### PROJECT RULES ###\nYou MUST strictly follow these project rules defined by the user:\n${fs.readFileSync(agentRulesPath, 'utf8')}\n`;
            } else if (fs.existsSync(cursorRulesPath)) {
                systemInstruction += `\n\n### PROJECT RULES ###\nYou MUST strictly follow these project rules defined by the user:\n${fs.readFileSync(cursorRulesPath, 'utf8')}\n`;
            }
        }

        return systemInstruction;
    }

    /**
     * Builds the final user prompt with context injection (@search, @file, @workspace, active file).
     */
    private async buildPrompt(text: string, includeActiveFile: boolean, includeWebSearch: boolean, includeWorkspace: boolean, workspaceRoot?: string): Promise<string> {
        let finalPrompt = text;
        let contextParts: string[] = [];

        // Handle @search directive or UI toggle
        if (includeWebSearch || text.toLowerCase().includes('@search')) {
            const { searchWeb } = require('../tools/scraper');
            
            let query = '';
            const searchMatch = text.match(/@search\s+(.+?)(?:\s*$|\s+@)/i);
            if (searchMatch && searchMatch[1]) {
                query = searchMatch[1].trim();
                finalPrompt = text.replace(/@search\s+.+?(?:\s*$|\s+@)/i, '').trim() || text;
            } else if (includeWebSearch) {
                // Heuristic for UI toggle
                query = text.length > 100 ? text.substring(0, 100) : text;
            }

            if (query) {
                this.postMessageToWebview({
                    command: 'statusUpdate',
                    text: `🔍 Web Search: ${query.substring(0, 30)}...`
                });
                
                let enhancedQuery = query;
                
                const searchResults = await searchWeb(enhancedQuery);
                contextParts.push(`--- Web Search Results ---\n${searchResults}`);
                
                // Prepend sources to the chat response so user can click them
                const urls: string[] = [];
                const urlMatches = searchResults.matchAll(/\[Source \d+\] (http[^\n]+)/g);
                for (const u of urlMatches) {
                    try { urls.push(`[Source: ${new URL(u[1]).hostname}](${u[1]})`); } catch { /* ignore */ }
                }
                
                if (urls.length > 0) {
                    this.postMessageToWebview({
                        command: 'streamChunk',
                        text: `*🌐 Web Sources:* ${urls.join(' | ')}\n\n---\n\n`,
                        done: false
                    });
                }
                
                this.postMessageToWebview({
                    command: 'statusUpdate',
                    text: `🌐 Web context injected.`
                });
            }
        }

        // Handle @file directive — include specific file contents (supports quoted paths)
        const fileMatches = text.matchAll(/@file\s+(?:"([^"]+)"|([^\s@]+))/gi);
        let hasFileMatch = false;
        for (const match of fileMatches) {
            hasFileMatch = true;
            const filePath = match[1] || match[2];
            try {
                const resolvedPath = workspaceRoot 
                    ? path.resolve(workspaceRoot, filePath)
                    : filePath;
                
                if (fs.existsSync(resolvedPath)) {
                    const content = fs.readFileSync(resolvedPath, 'utf8');
                    const ext = path.extname(resolvedPath).slice(1) || 'text';
                    contextParts.push(`File: ${filePath}\n\`\`\`${ext}\n${content}\n\`\`\``);
                    this.postMessageToWebview({
                        command: 'statusUpdate',
                        text: `📄 Loaded file: ${filePath}`
                    });
                }
            } catch { /* skip unreadable files */ }
            finalPrompt = finalPrompt.replace(match[0], '').trim();
        }

        // Handle @workspace directive — include project structure + key files
        const wantsWorkspace = text.toLowerCase().includes('@workspace') || 
                               text.toLowerCase().includes('bird eye view') || 
                               text.toLowerCase().includes("bird's eye view") ||
                               text.toLowerCase().includes('project structure');

        if (wantsWorkspace) {
            if (workspaceRoot) {
                try {
                    const files = await vscode.workspace.findFiles(
                        '**/*',
                        '{**/node_modules/**,**/dist/**,**/.git/**,**/out/**,**/*.lock}'
                    );
                    const fileList = files.map(f => {
                        const rel = path.relative(workspaceRoot, f.fsPath);
                        return rel;
                    }).sort();
                    
                    contextParts.push(`Workspace Structure (${fileList.length} files):\n${fileList.join('\n')}`);
                    this.postMessageToWebview({
                        command: 'statusUpdate',
                        text: `📂 Loaded workspace structure (${fileList.length} files)`
                    });
                } catch { /* skip */ }
            }
            finalPrompt = finalPrompt.replace(/@workspace/gi, '').trim();
        }

        // Handle RAG Semantic Search (@rag, UI toggle, or implicit)
        const wantsRag = includeWorkspace || text.toLowerCase().includes('@rag') || text.toLowerCase().includes('@smart');
        
        if (wantsRag && this.ragEngine) {
            try {
                this.postMessageToWebview({
                    command: 'statusUpdate',
                    text: `🧠 Semantic Search: Analyzing codebase...`
                });
                
                const ragResults = await this.ragEngine.search(text, 5);
                if (ragResults.length > 0) {
                    contextParts.push(`--- Relevant Semantic Codebase Context ---\n${ragResults.map((r: any) => `File: ${r.filepath}\n\`\`\`\n${r.content}\n\`\`\``).join('\n\n')}`);
                    this.postMessageToWebview({
                        command: 'statusUpdate',
                        text: `🧠 Semantic Search: Loaded ${ragResults.length} relevant files.`
                    });
                }
            } catch (err: any) {
                console.error("RAG search failed", err);
            }
            finalPrompt = finalPrompt.replace(/@rag|@smart/gi, '').trim();
        }

        // LSP Symbol Resolution for True Codebase Context
        if (workspaceRoot && text.length > 5) {
            try {
                // Extract potential PascalCase, camelCase, or snake_case symbols
                const symbolRegex = /[A-Z][a-z0-9]+[A-Z][a-z0-9]+|[A-Z][a-z0-9]+|[a-z0-9]+_[a-z0-9_]+/g;
                const matches = text.match(symbolRegex) || [];
                const potentialSymbols = Array.from(new Set(matches))
                    .filter(s => s.length > 4 && !['javascript', 'typescript', 'python', 'java'].includes(s.toLowerCase()));

                if (potentialSymbols.length > 0) {
                    for (const sym of potentialSymbols) {
                        try {
                            const symbols: vscode.SymbolInformation[] | undefined = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', sym);
                            if (symbols && symbols.length > 0) {
                                const topSymbols = symbols.slice(0, 2);
                                for (const s of topSymbols) {
                                    if (s.location.uri.fsPath.startsWith(workspaceRoot)) {
                                        const relPath = path.relative(workspaceRoot, s.location.uri.fsPath);
                                        if (!contextParts.some(p => p.includes(relPath))) {
                                            const content = fs.readFileSync(s.location.uri.fsPath, 'utf8');
                                            const lines = content.split('\n');
                                            const startLine = Math.max(0, s.location.range.start.line - 10);
                                            const endLine = Math.min(lines.length, s.location.range.end.line + 30);
                                            const snippet = lines.slice(startLine, endLine).join('\n');
                                            
                                            contextParts.push(`AST Symbol Context for \`${sym}\` in ${relPath}:\n\`\`\`\n// ...\n${snippet}\n// ...\n\`\`\``);
                                        }
                                    }
                                }
                            }
                        } catch { /* ignore LSP failures */ }
                    }
                }
            } catch { /* ignore regex errors */ }
        }

        // Auto-include active file if no context is provided
        let autoIncludeActive = includeActiveFile;
        if (!hasFileMatch && !wantsWorkspace && !wantsRag && !text.toLowerCase().includes('@active') && !text.toLowerCase().includes('@current')) {
            autoIncludeActive = true;
        }

        // Include active file context if requested or auto-detected
        if (autoIncludeActive || text.toLowerCase().includes('@active') || text.toLowerCase().includes('@current')) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const doc = editor.document;
                const fileName = path.basename(doc.fileName);
                const selection = editor.selection;
                
                if (!selection.isEmpty) {
                    // Include just the selection
                    const selectedText = doc.getText(selection);
                    contextParts.push(`Selected code from ${fileName} (${doc.languageId}):\n\`\`\`${doc.languageId}\n${selectedText}\n\`\`\``);
                } else {
                    // Include the full file (truncated if too large)
                    let content = doc.getText();
                    if (content.length > 15000) {
                        content = content.substring(0, 15000) + '\n\n... (truncated)';
                    }
                    contextParts.push(`Active file context: ${fileName} (${doc.languageId}):\n\`\`\`${doc.languageId}\n${content}\n\`\`\``);
                }
                finalPrompt = finalPrompt.replace(/@active|@current/gi, '').trim();
            }
        }

        // Assemble final prompt with context
        if (contextParts.length > 0) {
            finalPrompt = `${finalPrompt}\n\n--- Context ---\n${contextParts.join('\n\n')}`;
        }

        const config = getAgentConfig(workspaceRoot);
        const maxTokens = config?.contextLimits?.maxTokens || 8000;
        const maxChars = maxTokens * 3;
        
        if (finalPrompt.length > maxChars) {
            finalPrompt = finalPrompt.substring(0, maxChars) + "\n\n... (context truncated due to token limits)";
            this.postMessageToWebview({
                command: 'statusUpdate',
                text: `⚠️ Context truncated to stay under ${maxTokens} tokens limit.`
            });
        }

        return finalPrompt;
    }

    /**
     * Save settings to .agent-config.json
     */
    private async handleSaveSettings(message: any): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No active workspace folder to save configuration.');
            }
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const configPath = path.join(workspaceRoot, '.agent-config.json');

            const newConfig: AgentConfig = {
                providers: {
                    cloud: {
                        model: message.config.provider === 'cloud' ? message.config.model : (configPath && fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')).providers?.cloud?.model : 'gemma-4-31b-it'),
                        apiKey: message.config.apiKey,
                        rpmLimit: 15,
                        timeoutSeconds: Number(message.config.timeoutSeconds)
                    },
                    local: {
                        model: message.config.provider === 'local' ? message.config.model : 'llama3',
                        endpoint: message.config.localEndpoint || 'http://127.0.0.1:11434'
                    }
                },
                activeProvider: message.config.provider || 'cloud',
                contextLimits: {
                    maxTokens: Number(message.config.maxTokens),
                    historyLength: Number(message.config.historyLength)
                },
                systemInstructions: message.config.systemInstructions
            };

            fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');
            
            // Save VS Code extension settings
            if (message.config.enableInlineCompletions !== undefined || message.config.enableHoverExplanations !== undefined) {
                const vsConfig = vscode.workspace.getConfiguration('ultraLightAI');
                if (message.config.enableInlineCompletions !== undefined) {
                    await vsConfig.update('enableInlineCompletions', message.config.enableInlineCompletions, vscode.ConfigurationTarget.Global);
                }
                if (message.config.enableHoverExplanations !== undefined) {
                    await vsConfig.update('enableHoverExplanations', message.config.enableHoverExplanations, vscode.ConfigurationTarget.Global);
                }
            }

            vscode.window.showInformationMessage('✨ Configuration saved successfully!');
            
            this.postMessageToWebview({
                command: 'settingsSaved',
                success: true,
                model: message.config.model
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to save settings: ${error?.message || error}`);
            this.postMessageToWebview({
                command: 'settingsSaved',
                success: false,
                error: error?.message || error
            });
        }
    }

    /**
     * Apply workspace edits — write multiple files to the workspace.
     */
    private async handleApplyWorkspaceEdits(message: any): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folder open. Open a folder first to apply edits.');
            }
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            
            const edit = new vscode.WorkspaceEdit();
            const createdFiles: string[] = [];

            // Group files by filepath to handle multiple code blocks for the same file
            const fileGroups: { [key: string]: string[] } = {};
            for (const file of message.files) {
                if (!fileGroups[file.filepath]) fileGroups[file.filepath] = [];
                fileGroups[file.filepath].push(file.content);
            }

            for (const [filepath, contents] of Object.entries(fileGroups)) {
                const fullPath = path.join(workspaceRoot, filepath);
                const fileUri = vscode.Uri.file(fullPath);
                
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                let fileText = '';
                if (fs.existsSync(fullPath)) {
                    const document = await vscode.workspace.openTextDocument(fileUri);
                    fileText = document.getText();
                    this.conversationHistory.addFileBackupToLatestMessage(fullPath, fileText);
                } else {
                    this.conversationHistory.addFileBackupToLatestMessage(fullPath, null);
                    edit.createFile(fileUri, { ignoreIfExists: true });
                }
                
                for (const content of contents) {
                    // Check if the AI used Search/Replace blocks
                    if (content.includes('<<<<<<< SEARCH') && content.includes('>>>>>>> REPLACE')) {
                        const blockRegex = /<<<<<<<\s*SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>\s*REPLACE/g;
                        let match;
                        let blocksFound = false;
                        
                        while ((match = blockRegex.exec(content)) !== null) {
                            blocksFound = true;
                            const searchStr = match[1];
                            const replaceStr = match[2];
                            const { applyRobustSearchReplace } = require('../operations/diffPatcher');
                            const patchResult = applyRobustSearchReplace(fileText, searchStr, replaceStr);
                            
                            if (patchResult.success) {
                                fileText = patchResult.result;
                            } else {
                                throw new Error(`Could not find the specified search block in ${filepath}. Ensure the code exactly matches the file context.`);
                            }
                        }
                        if (!blocksFound) {
                            throw new Error(`Malformed Search/Replace block in ${filepath}. Check if the block format is exactly <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE`);
                        }
                    } else {
                        // Full file replacement
                        fileText = content;
                    }
                }

                if (fs.existsSync(fullPath)) {
                    const document = await vscode.workspace.openTextDocument(fileUri);
                    const fullRange = new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length)
                    );
                    edit.replace(fileUri, fullRange, fileText);
                } else {
                    edit.insert(fileUri, new vscode.Position(0, 0), fileText);
                }
                createdFiles.push(filepath);
            }
            
            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                throw new Error("VS Code failed to apply the workspace edits.");
            }
            
            // Save files automatically to prevent dirty state if needed, or let user decide.
            vscode.window.showInformationMessage(`✨ Applied changes to ${message.files.length} files! (Use Ctrl+Z to undo)`);
            
            if (createdFiles.length > 0) {
                const firstFile = path.join(workspaceRoot, createdFiles[0]);
                const doc = await vscode.workspace.openTextDocument(firstFile);
                await vscode.window.showTextDocument(doc);
            }

            this.postMessageToWebview({
                command: 'statusUpdate',
                text: `✅ Created ${createdFiles.length} files: ${createdFiles.join(', ')}`
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to apply workspace edits: ${error?.message || error}`);
        }
    }

    /**
     * Open the .agent-config.json file in the editor.
     */
    private handleOpenConfig(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const configPath = path.join(workspaceRoot, '.agent-config.json');
            if (fs.existsSync(configPath)) {
                vscode.workspace.openTextDocument(configPath).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
            } else {
                vscode.window.showErrorMessage('Agent configuration file (.agent-config.json) does not exist.');
            }
        }
    }

    /**
     * Executes a command in the VS Code terminal with basic sandbox restrictions.
     */
    private async handleRunInTerminal(command: string) {
        // Enhanced Sandboxing: Prevent destructive OS commands
        const dangerousPatterns = [
            /rm\s+-r/i, /del\s+\/f/i, /format\s+/i, /diskpart/i, 
            /rmdir\s+\/s/i, /mkfs/i, /dd\s+if=/i, /shutdown/i, 
            /C:\\Windows/i, /C:\\\\/i, /Remove-Item\s+-Recurse/i, /cmd\s+\/c\s+del/i,
            /del\s+\*\.\*/i
        ];
        
        const isDangerous = dangerousPatterns.some(pattern => pattern.test(command));

        if (isDangerous) {
            vscode.window.showErrorMessage('🛡️ Sandbox Blocked: This command contains potentially dangerous OS operations or accesses restricted paths.');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Do you want to run this command in the terminal?\n\n${command}`,
            { modal: true },
            'Run Command'
        );

        if (confirm !== 'Run Command') {
            return;
        }

        let terminal = vscode.window.terminals.find(t => t.name === 'Ultra Light AI');
        if (!terminal) {
            terminal = vscode.window.createTerminal('Ultra Light AI');
        }
        terminal.show();
        terminal.sendText(command);
    }

    /**
     * Insert text at cursor position in the active editor.
     */
    private async handleInsertToEditor(text: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor. Open a file first.');
            return;
        }
        await editor.edit(editBuilder => {
            editBuilder.insert(editor.selection.active, text);
        });
        vscode.window.showInformationMessage('📝 Code inserted at cursor!');
    }

    /**
     * Open a file in the editor
     */
    private async handleOpenFile(filepath: string): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) { return; }
        
        const fullPath = path.resolve(workspaceRoot, filepath);
        if (fs.existsSync(fullPath)) {
            const doc = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(doc);
        } else {
            vscode.window.showErrorMessage(`File not found: ${filepath}`);
        }
    }

    /**
     * Send status update to Webview
     */
    public postMessageToWebview(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }
}
