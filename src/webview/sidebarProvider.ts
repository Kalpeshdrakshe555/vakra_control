import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GeminiCloudClient } from '../router/realClients';
import { applyDiffToActiveFile, applyRobustSearchReplace } from '../operations/diffPatcher';
import { getGeminiApiKeys, getGeminiModel, getGeminiTimeout, getAgentConfig, AgentConfig } from '../config';
import { ConversationHistory } from '../state/conversationHistory';
import { allocateBudget, ContextSource, estimateTokens, truncateToTokens } from '../utils/tokenBudget';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private conversationHistory: ConversationHistory;
    private currentStreamAbortController: AbortController | null = null;
    private currentSeqOp: any = null; // Store reference to cancel Architect queue

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _workspaceRoot: string,
        private readonly ragEngine?: any
    ) {
        this.conversationHistory = new ConversationHistory(20, this._workspaceRoot);
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
                        mainBrain: config?.mainBrain,
                        supportBrain: config?.supportBrain,
                        providers: config?.providers,
                        activeProvider: config?.activeProvider,
                        timeoutSeconds: config?.providers?.cloud?.timeoutSeconds || 60,
                        systemInstructions: config?.systemInstructions || 'You are an AI coding agent. Always wrap your code solutions in standard markdown code blocks. Provide the complete code file content so it can be directly applied.',
                        maxOutputTokens: config?.contextLimits?.maxOutputTokens || config?.contextLimits?.maxTokens || 8192,
                        maxContextTokens: config?.contextLimits?.maxContextTokens || 32000,
                        historyLength: config?.contextLimits?.historyLength || 10,
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
                this.conversationHistory.clear();
                if (this._onResetCb) {
                    this._onResetCb();
                }
                this.postMessageToWebview({ command: 'chatCleared' });
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
                    const messages = this.conversationHistory.getAllMessages();
                    const targetIdx = messages.findIndex((m: any) => m.timestamp === message.timestamp);
                    let revertedCount = 0;
                    
                    if (targetIdx !== -1) {
                        const msgsToRevert = messages.slice(targetIdx);
                        const revertEdit = new vscode.WorkspaceEdit();
                        let hasEdits = false;
                        
                        const fileToOldestContent = new Map<string, string | null>();
                        
                        // Find the oldest backup state for each file within the deleted messages range
                        for (const msg of msgsToRevert) {
                            if ((msg as any).fileBackups) {
                                for (const backup of (msg as any).fileBackups) {
                                    if (!fileToOldestContent.has(backup.filepath)) {
                                        fileToOldestContent.set(backup.filepath, backup.content);
                                    }
                                }
                            }
                        }

                        // Apply the exact old state directly to VS Code Buffers
                        for (const [filepath, content] of fileToOldestContent.entries()) {
                            const fileUri = vscode.Uri.file(filepath);
                            if (content === null) {
                                revertEdit.deleteFile(fileUri, { ignoreIfNotExists: true });
                                hasEdits = true;
                                revertedCount++;
                            } else {
                                try {
                                    let doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filepath);
                                    if (!doc && fs.existsSync(filepath)) {
                                        doc = await vscode.workspace.openTextDocument(fileUri);
                                    }
                                    if (doc) {
                                        const fullRange = new vscode.Range(
                                            doc.positionAt(0),
                                            doc.positionAt(doc.getText().length)
                                        );
                                        revertEdit.replace(fileUri, fullRange, content);
                                        hasEdits = true;
                                        revertedCount++;
                                    } else if (!fs.existsSync(filepath)) {
                                        revertEdit.createFile(fileUri, { ignoreIfExists: true });
                                        revertEdit.insert(fileUri, new vscode.Position(0, 0), content);
                                        hasEdits = true;
                                        revertedCount++;
                                    }
                                } catch (e) {
                                    console.error("Failed to prepare revert for", filepath, e);
                                }
                            }
                        }

                        if (hasEdits) {
                            await vscode.workspace.applyEdit(revertEdit);
                        }

                        // Restore the user's prompt directly into the chat input box!
                        const userMsg = messages[targetIdx];
                        if (userMsg && userMsg.role === 'user') {
                            this.postMessageToWebview({
                                command: 'injectChat',
                                text: userMsg.text
                            });
                        }
                    }

                    const success = this.conversationHistory.rollbackToTimestamp(message.timestamp);
                    if (success) {
                        this.postMessageToWebview({
                            command: 'restoreHistory',
                            messages: this.conversationHistory.getAllMessages()
                        });
                        vscode.window.showInformationMessage(`⏪ Chat rolled back. Reverted ${revertedCount} file modifications automatically.`);
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
                // BUG-17 FIX: Route through the safe handleRunInTerminal which has sandboxing + confirmation modal
                this.handleRunInTerminal(message.cmd);
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
            } else if (message.command === 'requestWorkspaceFiles') {
                await this.handleRequestWorkspaceFiles(message.query);
            }
        });
    }

    private async handleRequestWorkspaceFiles(query: string = ''): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) return;
            
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            // Use vscode findFiles to get max 20 files matching the query (if provided) or recent files
            const searchPattern = query ? `**/*${query}*` : '**/*';
            const excludePattern = '{**/node_modules/**,**/dist/**,**/.git/**,**/out/**,**/*.lock}';
            
            const files = await vscode.workspace.findFiles(searchPattern, excludePattern, 25);
            
            // Map to relative paths
            const relativeFiles = files.map(f => path.relative(workspaceRoot, f.fsPath));
            
            // Sort by shortest path/name matching query (primitive ranking)
            relativeFiles.sort((a, b) => a.length - b.length);
            
            this.postMessageToWebview({
                command: 'provideWorkspaceFiles',
                files: relativeFiles.slice(0, 15) // send top 15 results
            });
        } catch (e) {
            console.error("Failed to query workspace files for mention popup", e);
        }
    }

    /**
     * Applies 4-Tier matching logic to gracefully handle Search/Replace blocks
     * Tier 1: Exact Match, Tier 2: Normalized Match, Tier 3: Line-Anchor, Tier 4: Best-Effort UI
     */
    private async applyPatchWithTiers(fileText: string, searchStr: string, replaceStr: string, filepath: string, isPreview: boolean = false): Promise<{ success: boolean, text: string }> {
        const patchResult = applyRobustSearchReplace(fileText, searchStr, replaceStr);
        
        // Tier 1: Exact Match / DiffPatcher
        if (patchResult.success) {
            return { success: true, text: patchResult.result || patchResult.patched || fileText };
        }

        // Tier 2: Normalized Match
        const escapeRegex = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const relaxedRegex = new RegExp(escapeRegex(searchStr).replace(/\s+/g, '\\s+'), 'g');
        if (relaxedRegex.test(fileText)) {
            return { success: true, text: fileText.replace(relaxedRegex, replaceStr) };
        }

        // Tier 3: Line-Anchor Match
        const searchLines = searchStr.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (searchLines.length >= 2) {
            const firstLine = searchLines[0];
            const lastLine = searchLines[searchLines.length - 1];
            const fileLines = fileText.split('\n');
            
            const startIdx = fileLines.findIndex(l => l.includes(firstLine));
            if (startIdx !== -1) {
                const endIdx = fileLines.findIndex((l, idx) => idx > startIdx && l.includes(lastLine));
                if (endIdx !== -1) {
                    fileLines.splice(startIdx, endIdx - startIdx + 1, replaceStr);
                    return { success: true, text: fileLines.join('\n') };
                }
            }
        }

        // Tier 4: Best-Effort + User Confirmation
        if (isPreview) {
            return { success: true, text: fileText + `\n\n/* ⚠️ AI APPENDED (Best Effort: Exact match failed) */\n${replaceStr}\n` };
        } else {
            const userChoice = await vscode.window.showWarningMessage(
                `Could not find exact match in ${path.basename(filepath)}. Apply best-effort patch (append to file)?`,
                'Accept', 'Reject'
            );
            
            if (userChoice === 'Accept') {
                return { success: true, text: fileText + `\n\n/* ⚠️ AI APPENDED (Best Effort: Exact match failed) */\n${replaceStr}\n` };
            }
        }

        return { success: false, text: fileText };
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
                    const patchResult = await this.applyPatchWithTiers(newContent, searchStr, replaceStr, fileInfo.filepath, true);
                    if (patchResult.success) {
                        newContent = patchResult.text;
                    }
                }
                
                // Scout Regex Fallback for Preview
                if (!blocksFound && (fileInfo.content.includes('<<<<<<<') || fileInfo.content.includes('======='))) {
                    const config = require('../config').getAgentConfig(workspaceRoot);
                    if (config?.advancedModeEnabled && config?.supportBrain?.model) {
                        try {
                            const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');
                            let scoutClient;
                            if (config.supportBrain.providerType === 'local') {
                                scoutClient = new LocalOllamaClient(config.supportBrain.model || 'llama-3.1-8b-instant', config.supportBrain.endpoint || 'http://127.0.0.1:11434', config.supportBrain.apiKey);
                            } else {
                                scoutClient = new GeminiCloudClient([config.supportBrain.apiKey?.trim() || ''], config.supportBrain.model || 'gemini-1.5-flash', 60);
                            }
                            const fixPrompt = `Extract SEARCH and REPLACE blocks. Return JSON array: [{"search":"...", "replace":"..."}].\n\n${fileInfo.content}`;
                            const fixResponse = await scoutClient.complete(fixPrompt);
                            const jsonStr = fixResponse.text.replace(/```json/gi, '').replace(/```/g, '').trim();
                            const parsedBlocks = JSON.parse(jsonStr);
                            
                            for (const b of parsedBlocks) {
                                blocksFound = true;
                                const patchResult = await this.applyPatchWithTiers(newContent, b.search, b.replace, fileInfo.filepath, true);
                                if (patchResult.success) newContent = patchResult.text;
                            }
                        } catch (e) {
                            console.error("Scout Preview fix failed", e);
                        }
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
            
            const maxOutputTokens = config?.contextLimits?.maxOutputTokens || config?.contextLimits?.maxTokens || 8192;
            const maxContextTokens = config?.contextLimits?.maxContextTokens || 32000;

            let client;
            const keyStr = keys[0]?.trim() || '';
            if (config?.activeProvider === 'local') {
                const { LocalOllamaClient } = require('../router/realClients');
                const endpoint = config.providers?.local?.endpoint || 'http://127.0.0.1:11434';
                const localModel = config.providers?.local?.model || 'llama3';
                client = new LocalOllamaClient(localModel, endpoint, keyStr);
            } else {
                const { LocalOllamaClient } = require('../router/realClients');
                if (keyStr.startsWith('gsk_')) {
                    client = new LocalOllamaClient(model, 'https://api.groq.com/openai', keyStr);
                } else if (keyStr.startsWith('sk-or-')) {
                    client = new LocalOllamaClient(model, 'https://openrouter.ai/api', keyStr);
                } else if (keyStr.startsWith('sk-') || keyStr.startsWith('sk-proj-')) {
                    client = new LocalOllamaClient(model, 'https://api.openai.com', keyStr);
                } else {
                    client = new GeminiCloudClient(keys, model, timeout, maxOutputTokens);
                }
            }
            
            // Note: message isn't passed here as this method is called via fallback, but let's assume agentMode is false for now
            // if we need it we can update the signature later.
            const systemInstruction = this.buildSystemInstruction(config, workspaceRoot, false);
            let finalPrompt = await this.buildPrompt(text, includeActiveFile, false, false, workspaceRoot);

            // Add ONLY the user's raw message to history (BUG-03 FIX)
            this.conversationHistory.addMessage('user', text);

            const historyLimit = config?.contextLimits?.historyLength || 10;
            const historyTokenLimit = Math.min(12000, maxContextTokens * 0.4);

            // Check if we need to summarize due to length or token budget BEFORE blind trimming
            if ((this.conversationHistory.length / 2 > historyLimit || this.conversationHistory.estimateTokens() > historyTokenLimit) 
                && client && typeof client.complete === 'function' && this.conversationHistory.length >= 6) {
                this.postMessageToWebview({
                    command: 'statusUpdate',
                    text: `🧠 Memory optimizing: Summarizing older context to save tokens...`
                });
                try {
                    const rawHistory = this.conversationHistory.getHistory(this.conversationHistory.length / 2);
                    const olderMessages = rawHistory.slice(0, rawHistory.length - 4);
                    
                    const summaryPrompt = `Summarize the following chat history concisely. Focus on the main technical context, architectural decisions, and the user's ultimate goal. Return ONLY the summary.\n\n${JSON.stringify(olderMessages)}`;
                    const summaryResult = await client.complete(summaryPrompt);
                    
                    if (summaryResult && summaryResult.text) {
                        this.conversationHistory.compressHistoryWithSummary(summaryResult.text, 2);
                        this.postMessageToWebview({ command: 'statusUpdate', text: `✅ Context summarized safely.` });
                    }
                } catch (err) { console.error('Summarization failed', err); }
            }

            // Trim history token budget as a failsafe
            this.conversationHistory.trimToTokenBudget(historyTokenLimit);

            // Use multi-turn API
            const history = this.conversationHistory.getHistory(
                historyLimit
            );

            // Remove the last user message from history since we pass it separately
            const historyWithoutLast = history.slice(0, -1);
            
            this.postMessageToWebview({
                command: 'statusUpdate',
                text: `📚 Context Window: Sending previous ${historyWithoutLast.length} messages...`
            });

            const reply = await client.completeWithHistory(
                systemInstruction,
                historyWithoutLast,
                finalPrompt
            );

            // Strip <think> tags before saving to history
            const cleanResponseText = reply.text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/<\/think>/gi, '');
            this.conversationHistory.addMessage('model', cleanResponseText, reply.usage);

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

            let mainClient;
            let supportClient = null;
            
            const maxOutputTokens = config?.contextLimits?.maxOutputTokens || config?.contextLimits?.maxTokens || 8192;
            const maxContextTokens = config?.contextLimits?.maxContextTokens || 32000;

            const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');
            const { DualEngineRouter } = require('../router/dualEngineRouter');

            // Initialize Main Brain
            const mainBrain = config?.mainBrain;
            if (mainBrain) {
                if (mainBrain.providerType === 'local') {
                    mainClient = new LocalOllamaClient(mainBrain.model || 'llama3', mainBrain.endpoint || 'http://127.0.0.1:11434', mainBrain.apiKey);
                } else {
                    const keyStr = mainBrain.apiKey?.trim() || '';
                    if (keyStr.startsWith('gsk_')) {
                        mainClient = new LocalOllamaClient(mainBrain.model, 'https://api.groq.com/openai', keyStr);
                    } else if (keyStr.startsWith('sk-or-')) {
                        mainClient = new LocalOllamaClient(mainBrain.model, 'https://openrouter.ai/api', keyStr);
                    } else if (keyStr.startsWith('sk-') || keyStr.startsWith('sk-proj-')) {
                        mainClient = new LocalOllamaClient(mainBrain.model, 'https://api.openai.com', keyStr);
                    } else {
                        mainClient = new GeminiCloudClient([keyStr], mainBrain.model || 'gemini-1.5-pro', timeout);
                    }
                }
            } else {
                // Fallback to legacy config
                if (config?.activeProvider === 'local') {
                    mainClient = new LocalOllamaClient(config.providers?.local?.model || 'llama3', config.providers?.local?.endpoint || 'http://127.0.0.1:11434', keys[0]?.trim());
                } else {
                    const keyStr = keys[0]?.trim() || '';
                    if (keyStr.startsWith('gsk_')) mainClient = new LocalOllamaClient(model, 'https://api.groq.com/openai', keyStr);
                    else if (keyStr.startsWith('sk-or-')) mainClient = new LocalOllamaClient(model, 'https://openrouter.ai/api', keyStr);
                    else if (keyStr.startsWith('sk-') || keyStr.startsWith('sk-proj-')) mainClient = new LocalOllamaClient(model, 'https://api.openai.com', keyStr);
                    else mainClient = new GeminiCloudClient(keys, model, timeout);
                }
            }

            // Initialize Support Brain if Advanced Mode is enabled
            if (message.advancedMode && config?.supportBrain) {
                const supportBrain = config.supportBrain;
                if (supportBrain.providerType === 'local') {
                    supportClient = new LocalOllamaClient(supportBrain.model || 'llama-3.1-8b-instant', supportBrain.endpoint || 'http://127.0.0.1:11434', supportBrain.apiKey);
                } else {
                    const keyStr = supportBrain.apiKey?.trim() || '';
                    if (keyStr.startsWith('gsk_')) {
                        supportClient = new LocalOllamaClient(supportBrain.model, 'https://api.groq.com/openai', keyStr);
                    } else if (keyStr.startsWith('sk-') || keyStr.startsWith('sk-proj-')) {
                        supportClient = new LocalOllamaClient(supportBrain.model, 'https://api.openai.com', keyStr);
                    } else {
                        supportClient = new GeminiCloudClient([keyStr], supportBrain.model || 'gemini-1.5-flash', timeout);
                    }
                }
            }

            const client = new DualEngineRouter(mainClient, supportClient, !!message.advancedMode);
            
            // Auto-inject ARCHITECTURE.md if it exists (but NOT in Advanced Mode — Scout handles it)
            let architectureContext = '';
            if (workspaceRoot && !message.advancedMode) {
                const archPath = path.join(workspaceRoot, 'ARCHITECTURE.md');
                if (fs.existsSync(archPath)) {
                    architectureContext = `\n<project_architecture>\n${fs.readFileSync(archPath, 'utf8')}\n</project_architecture>\n`;
                }
            }

            // Build system instruction
            const systemInstruction = this.buildSystemInstruction(config, workspaceRoot, false, !!message.architectMode);
            let finalPrompt = await this.buildPrompt(message.text, false, message.includeWebSearch || false, false, workspaceRoot);
            
            if (architectureContext) {
                finalPrompt = architectureContext + '\n' + finalPrompt;
            }

            // Add ONLY the user's raw message to history to prevent infinite context scaling
            this.conversationHistory.addMessage('user', message.text, undefined, message.timestamp);
            
            const historyLimit = config?.contextLimits?.historyLength || 10;
            const historyTokenLimit = Math.min(12000, maxContextTokens * 0.4);

            // SMART SUMMARIZER: Safely compress history if it exceeds user's limit OR token limit
            if ((this.conversationHistory.length / 2 > historyLimit || this.conversationHistory.estimateTokens() > historyTokenLimit) 
                && mainClient && typeof mainClient.complete === 'function' && this.conversationHistory.length >= 6) {
                this.postMessageToWebview({
                    command: 'statusUpdate',
                    text: `🧠 Memory optimizing: Summarizing older context to save tokens...`
                });
                try {
                    const rawHistory = this.conversationHistory.getHistory(this.conversationHistory.length / 2);
                    const olderMessages = rawHistory.slice(0, rawHistory.length - 4); // Keep last 2 turns intact
                    
                    const summaryPrompt = `Summarize the following chat history concisely. Focus on the main technical context, architectural decisions, and the user's ultimate goal. Return ONLY the summary.\n\n${JSON.stringify(olderMessages)}`;
                    
                    const summaryResult = await mainClient.complete(summaryPrompt);
                    
                    if (summaryResult && summaryResult.text) {
                        this.conversationHistory.compressHistoryWithSummary(summaryResult.text, 2);
                        this.postMessageToWebview({
                            command: 'statusUpdate',
                            text: `✅ Context summarized safely.`
                        });
                    }
                } catch (err) {
                    console.error('Main Brain summarization failed', err);
                }
            }
            
            // Trim token budget as a failsafe
            this.conversationHistory.trimToTokenBudget(historyTokenLimit);

            let history = this.conversationHistory.getHistory(
                historyLimit
            );

            const historyWithoutLast = history.slice(0, -1);
            
            this.postMessageToWebview({
                command: 'statusUpdate',
                text: `📚 Context Window: Sending previous ${historyWithoutLast.length} messages...`
            });

            this.currentStreamAbortController = new AbortController();

            const tools = [
                {
                    functionDeclarations: [
                        {
                            name: "read_multiple_files",
                            description: "Reads multiple files from the workspace at once. Use this to read ARCHITECTURE.md and key files simultaneously to save time.",
                            parameters: { 
                                type: "object", 
                                properties: { 
                                    filepaths: { 
                                        type: "array", 
                                        items: { type: "string" },
                                        description: "Array of relative paths to the files you want to read." 
                                    } 
                                },
                                required: ["filepaths"]
                            }
                        },
                        {
                            name: "update_architecture_context",
                            description: "Updates or creates ARCHITECTURE.md with the latest project context, architecture, and recent changes. Use this to maintain your memory across sessions.",
                            parameters: { type: "object", properties: { content: { type: "string", description: "The full markdown content for the ARCHITECTURE.md file" } } }
                        },
                        {
                            name: "search_codebase",
                            description: "Performs a semantic BM25 search to find related code snippets when you are looking for a feature but don't know the file name.",
                            parameters: { type: "object", properties: { query: { type: "string", description: "Search query" } } }
                        },
                        {
                            name: "find_references",
                            description: "AST/LSP Tool: Uses VS Code's internal Language Server (F12) to find exact usages and references of a function or class.",
                            parameters: { type: "object", properties: { symbolName: { type: "string", description: "Name of the function or class to search for" } }, required: ["symbolName"] }
                        },
                        {
                            name: "replace_symbol",
                            description: "AST-Aware Patching: Completely replaces a function or class safely without regex matching. It uses the language server to find the exact symbol boundary.",
                            parameters: { type: "object", properties: { filepath: { type: "string" }, symbolName: { type: "string" }, newCode: { type: "string", description: "The new code to replace it with" } }, required: ["filepath", "symbolName", "newCode"] }
                        }
                    ]
                }
            ];

            const onToolCall = async (functionCall: any) => {
                if (functionCall.name === 'read_multiple_files') {
                    const filepaths = functionCall.args?.filepaths;
                    if (!filepaths || !Array.isArray(filepaths) || !workspaceRoot) return "Error: No filepaths array or workspace.";
                    
                    let combinedResult = '';
                    for (const filepath of filepaths) {
                        const fullPath = path.join(workspaceRoot, filepath);
                        if (fs.existsSync(fullPath)) {
                            let content = fs.readFileSync(fullPath, 'utf8');
                            // H1 FIX: Cap per-file size to prevent token explosion
                            if (estimateTokens(content) > 3000) {
                                content = truncateToTokens(content, 3000) + '\n\n... (File truncated to stay within limits. Use search_codebase to find specific functions.)';
                            }
                            combinedResult += `\n--- File: ${filepath} ---\n${content}\n`;
                        } else if (filepath.includes('ARCHITECTURE')) {
                            const ruleFiles = ['ARCHITECTURE.md', 'AI_RULES.md', '.cursorrules', '.agent-rules.md'];
                            let found = false;
                            for (const ruleFile of ruleFiles) {
                                const rulePath = path.join(workspaceRoot, ruleFile);
                                if (fs.existsSync(rulePath)) {
                                    combinedResult += `\n--- File: ${ruleFile} ---\n${fs.readFileSync(rulePath, 'utf8')}\n`;
                                    found = true;
                                    break;
                                }
                            }
                            if (!found) combinedResult += `\n--- File: ${filepath} (Not Found) ---\n`;
                        } else {
                            combinedResult += `\n--- File: ${filepath} (Not Found) ---\n`;
                        }
                    }
                    return combinedResult;
                } else if (functionCall.name === 'update_architecture_context') {
                    if (!workspaceRoot) return "Error: No workspace.";
                    const content = functionCall.args?.content || '';
                    const fullPath = path.join(workspaceRoot, 'ARCHITECTURE.md');
                    fs.writeFileSync(fullPath, content, 'utf8');
                    this.postMessageToWebview({
                        command: 'statusUpdate',
                        text: `📝 AI updated ARCHITECTURE.md to save context.`
                    });
                    return "Successfully updated ARCHITECTURE.md. Memory saved.";
                } else if (functionCall.name === 'search_codebase') {
                    if (!this.ragEngine) return "Search engine not initialized.";
                    const query = functionCall.args?.query || '';
                    const results = await this.ragEngine.search(query, 3);
                    if (results.length === 0) return "No matches found.";
                    return results.map((r: any) => `File: ${r.filepath}\n\n${r.content}`).join('\n\n---\n\n');
                } else if (functionCall.name === 'find_references') {
                    if (!workspaceRoot) return "Error: No workspace.";
                    const sym = functionCall.args?.symbolName;
                    try {
                        const symbols: vscode.SymbolInformation[] | undefined = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', sym);
                        if (!symbols || symbols.length === 0) return `Symbol ${sym} not found.`;
                        const target = symbols[0];
                        const refs: vscode.Location[] | undefined = await vscode.commands.executeCommand('vscode.executeReferenceProvider', target.location.uri, target.location.range.start);
                        if (!refs || refs.length === 0) return `No references found for ${sym}.`;
                        const summaries = refs.slice(0, 10).map(r => `File: ${path.relative(workspaceRoot, r.uri.fsPath)}, Line: ${r.range.start.line}`);
                        return `Found ${refs.length} references:\n` + summaries.join('\n');
                    } catch (e: any) { return `LSP Error: ${e.message}`; }
                } else if (functionCall.name === 'replace_symbol') {
                    if (!workspaceRoot) return "Error: No workspace.";
                    let { filepath, symbolName, newCode } = functionCall.args;
                    
                    // Bug Fix: Strip markdown backticks injected by LLM before replacing AST
                    newCode = newCode.replace(/^```[a-zA-Z]*\r?\n/, '').replace(/\r?\n```$/, '');
                    
                    const fullPath = path.join(workspaceRoot, filepath);
                    if (!fs.existsSync(fullPath)) return `File not found: ${filepath}`;
                    try {
                        const uri = vscode.Uri.file(fullPath);
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const symbols: vscode.DocumentSymbol[] | undefined = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
                        
                        const findSymbol = (syms: vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
                            for (const s of syms) {
                                if (s.name === symbolName) return s;
                                if (s.children) { const c = findSymbol(s.children); if (c) return c; }
                            }
                        };
                        const target = symbols ? findSymbol(symbols) : undefined;
                        if (!target) return `Symbol ${symbolName} not found in ${filepath}. Make sure you provide the exact function/class name.`;
                        
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(uri, target.range, newCode);
                        
                        this.conversationHistory.addFileBackupToLatestMessage(fullPath, doc.getText());
                        await vscode.workspace.applyEdit(edit);
                        return `Successfully replaced ${symbolName} in ${filepath} using AST boundaries.`;
                    } catch (e: any) { return `AST Patching Error: ${e.message}`; }
                }
                return `Unknown tool: ${functionCall.name}`;
            };

            // Stream response
            let result: any;
            if (typeof client.completeWithHistory === 'function') {
                result = await client.completeWithHistory(
                    systemInstruction,
                    historyWithoutLast,
                    finalPrompt,
                    true, // stream
                    (chunk: any) => {
                        this.postMessageToWebview({
                            command: 'streamChunk',
                            text: chunk.text,
                            done: chunk.done,
                            usage: chunk.usage
                        });
                    },
                    this.currentStreamAbortController.signal,
                    tools,
                    onToolCall
                );
            }

            this.currentStreamAbortController = null;

            if (!result) return; // Guard for clients not implementing completeWithHistory completely


            // Strip <think> tags robustly before saving to history to prevent context pollution
            const cleanResponseText = result.text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/<\/think>/gi, '');
            this.conversationHistory.addMessage('model', cleanResponseText, result.usage);

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

ANTI-ELISION RULE (CRITICAL):
NEVER use placeholders like "// rest of the code remains the same" or "// ...". You MUST write the complete, exact code in the SEARCH block and the complete updated code in the REPLACE block. If you use placeholders, the file parser will corrupt the user's files and delete their working code. DO NOT DELETE WORKING CODE.

You have the ability to suggest Terminal commands to test your code, debug, or install dependencies.
If you need to execute a command, provide it in a standard \`\`\`bash block.`;

            systemInstruction += `\nIf the user provides a short 2-3 line request for a new feature or project, first analyze the context, create a step-by-step plan, and then execute it. 
If the user provides a detailed plan with steps, acknowledge it and systematically execute their exact steps without deviating.
When suggesting terminal commands, ALWAYS wrap them in \`\`\`bash code blocks so the user can execute them.`;

        if (isArchitectMode) {
            systemInstruction += `\n\n[ARCHITECT MODE ACTIVE]: You are building a large project or feature. 
CRITICAL RULE 1: If the user asks you to build a NEW project using a framework (React, Next.js, Django, Vue, Vite, etc.), you MUST FIRST ONLY provide the exact CLI terminal commands to scaffold the project (e.g., \`django-admin startproject\`, \`npx create-next-app\`) using standard \`\`\`bash blocks. DO NOT provide ANY code files or file modifications in this first response.
CRITICAL RULE 2: STOP GENERATING immediately after providing the scaffolding commands. Wait for the user to run them and reply.
CRITICAL RULE 3: Once the scaffold is ready, carefully read the context. Do not make arbitrary changes. Break down your coding steps and provide ONLY 1 or 2 file modifications per response. Ask the user for confirmation to continue.
Do NOT attempt to write the entire codebase at once.`;
        }

        systemInstruction += `\n\nCRITICAL ARCHITECTURE & TOKEN RULES:
1. MODULARITY: NEVER write massive, monolithic files (like a huge views.py or thousands of lines in one component). Break down logic into small, modular, single-purpose files and functions.
2. PERSISTENT MEMORY: You MUST create and maintain an ARCHITECTURE.md file in the root directory. When starting a task, use the 'read_multiple_files' tool to read ['ARCHITECTURE.md'] so you know what files exist.
3. RAG/SEARCH FIRST: Do NOT randomly guess file names and try to read them. ALWAYS use the 'search_codebase' (RAG) tool first to search for keywords. Once you know the exact file paths from RAG, use 'read_multiple_files' to read them.
4. TOKEN EFFICIENCY: Read multiple files at once using the 'read_multiple_files' tool passing an array of paths (e.g. ['game/views.py', 'game/models.py']). This saves API requests. Read only the specific files relevant to the user's request.
5. DRY PRINCIPLE: Do not repeat code. Use imports and keep the codebase strictly organized.
6. AMBIGUITY RULE (CRITICAL): If the user says "fix error", "solve this bug", or "something is broken" WITHOUT providing the actual error message or traceback, you MUST STOP and ask: "Please paste the exact error message or traceback so I can fix it precisely." DO NOT start blindly reading files. Wait for the error details before calling any tools.
7. TOOL LOOP PREVENTION: Never call the same tool with the same arguments twice in a row. If a file read returned "not found", do not try again. If you've already explored the structure, stop and respond with your findings.
8. CONTEXT FALLBACK: A background Scout agent may provide initial context in <scout_context> tags. If this context is missing, insufficient, or incomplete, YOU MUST use the 'read_multiple_files' or 'search_codebase' tools yourself to fetch the missing code before generating your response.
9. ARCHITECTURE UPDATES: Whenever you solve a bug or make significant code changes, you MUST output an explicit SEARCH/REPLACE block to update the \`ARCHITECTURE.md\` file with notes about the bug fix and how the component's logic changed. Do not wait for the background indexer to do it.
10. NO PATH HALLUCINATION: NEVER guess or assume file paths (e.g., do not guess 'dashboard/ai/' if it's not in the context). ALWAYS verify paths using the workspace structure or tools before modifying them.
11. STEP-BY-STEP LIMIT: Provide a MAXIMUM of 3 file modifications per response. If a task requires more, do the first 3 and explicitly ask the user: "Please say 'continue' to proceed with the remaining files."
12. DEBUGGING & COMMANDS: When analyzing an error, do NOT hallucinate the cause. Output the necessary terminal command in a \`\`\`bash block and explicitly say: "Please run this command and provide the output so I can analyze the error."`;


        if (isAgentMode) {
            systemInstruction += `\n[AGENT MODE ACTIVE]: You can suggest bash commands to install packages or run tests. The user will review and run them. Provide step-by-step instructions.`;
        }
        
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
        let contextSources: ContextSource[] = [];

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
                contextSources.push({ name: 'Web Search Results', content: searchResults, priority: 8 });
                
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
                    contextSources.push({ name: `File: ${filePath}`, content: `\`\`\`${ext}\n${content}\n\`\`\``, priority: 10 });
                    this.postMessageToWebview({
                        command: 'statusUpdate',
                        text: `📄 Loaded file: ${filePath}`
                    });
                }
            } catch { /* skip unreadable files */ }
            finalPrompt = finalPrompt.replace(match[0], '').trim();
        }

        // Handle @workspace directive — include project structure + key files
        const wantsWorkspace = includeWorkspace || text.toLowerCase().includes('@workspace') || 
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
                    const fileList = files.map(f => path.relative(workspaceRoot, f.fsPath)).sort();
                    
                    contextSources.push({ name: 'Workspace Structure', content: fileList.join('\n'), priority: 4 });
                    this.postMessageToWebview({
                        command: 'statusUpdate',
                        text: `📂 Loaded workspace structure (${fileList.length} files)`
                    });
                } catch { /* skip */ }
            }
            finalPrompt = finalPrompt.replace(/@workspace/gi, '').trim();
        }

        // Manual RAG Trigger (Fallback for non-tool-calling local models)
        const wantsRag = text.toLowerCase().includes('@rag') || text.toLowerCase().includes('@smart');
        
        if (wantsRag && this.ragEngine) {
            try {
                this.postMessageToWebview({
                    command: 'statusUpdate',
                    text: `🧠 Semantic Search: Analyzing codebase...`
                });
                
                const ragResults = await this.ragEngine.search(text, 3);
                if (ragResults.length > 0) {
                    contextSources.push({ name: 'Semantic Codebase Context', content: ragResults.map((r: any) => `File: ${r.filepath}\n\`\`\`\n${r.content}\n\`\`\``).join('\n\n'), priority: 7 });
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
                                        if (!contextSources.some(p => p.name.includes(relPath))) {
                                            const content = fs.readFileSync(s.location.uri.fsPath, 'utf8');
                                            const lines = content.split('\n');
                                            const startLine = Math.max(0, s.location.range.start.line - 10);
                                            const endLine = Math.min(lines.length, s.location.range.end.line + 30);
                                            const snippet = lines.slice(startLine, endLine).join('\n');
                                            
                                            contextSources.push({ name: `AST Symbol Context for \`${sym}\` in ${relPath}`, content: `\`\`\`\n// ...\n${snippet}\n// ...\n\`\`\``, priority: 6 });
                                        }
                                    }
                                }
                            }
                        } catch { /* ignore LSP failures */ }
                    }
                }
            } catch { /* ignore regex errors */ }
        }

        // Always auto-include active file unless it's a simple greeting or explicitly told not to
        const isGreeting = /^(hi|hello|hey|yo|what's up|sup|morning|evening|afternoon)$/i.test(text.trim());
        let autoIncludeActive = true;
        if (isGreeting || text.toLowerCase().includes('ignore active file')) {
            autoIncludeActive = false;
        }

        // Include active file context if requested or auto-detected
        if (autoIncludeActive || text.toLowerCase().includes('@active') || text.toLowerCase().includes('@current')) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const doc = editor.document;
                const fileName = path.basename(doc.fileName);
                const langId = doc.languageId;
                
                // BUG-14 FIX: Skip non-code files to avoid wasting token budget
                const skipLanguages = ['plaintext', 'log', 'binary', 'json', 'xml', 'csv', 'svg', 'markdown'];
                const skipExtensions = ['.lock', '.min.js', '.min.css', '.map', '.env'];
                const ext = path.extname(doc.fileName).toLowerCase();
                const isCodeFile = !skipLanguages.includes(langId) && !skipExtensions.some(e => ext === e);
                
                if (isCodeFile) {
                    const selection = editor.selection;
                    
                    if (!selection.isEmpty) {
                        // Include just the selection
                        const selectedText = doc.getText(selection);
                        contextSources.push({ name: `Selected code from ${fileName}`, content: `\`\`\`${langId}\n${selectedText}\n\`\`\``, priority: 9 });
                    } else {
                        // Include the full file (truncated if too large)
                        contextSources.push({ name: `Active file context: ${fileName}`, content: `\`\`\`${langId}\n${doc.getText()}\n\`\`\``, priority: 5 });
                    }
                }
                finalPrompt = finalPrompt.replace(/@active|@current/gi, '').trim();
            }
        }
        const promptConfig = getAgentConfig(workspaceRoot);
        const maxTokens = promptConfig?.contextLimits?.maxTokens || 8192;
        
        // Assemble final prompt with context
        // Optimization for smaller models: Place Context BEFORE the User Request
        // Smaller models (3B-7B) suffer from 'lost in the middle' and attend strongest to the end of the prompt.
        if (contextSources.length > 0) {
            const userPromptTokens = estimateTokens(finalPrompt);
            // Reserve 2000 tokens for system prompt and chat history
            const availableContextTokens = Math.max(500, maxTokens - 2000 - userPromptTokens);
            
            const allocated = allocateBudget(availableContextTokens, contextSources);
            const totalUsed = allocated.reduce((sum, a) => sum + a.tokens, 0);
            
            // Real-time Token Warning Implementation
            if (totalUsed >= availableContextTokens * 0.9) {
                this.postMessageToWebview({
                    command: 'statusUpdate',
                    text: `🚨 Warning: Context window is at ${Math.round((totalUsed / availableContextTokens) * 100)}% capacity.`
                });
            }
            
            let contextString = allocated.map(a => `--- ${a.name} ---\n${a.content}`).join('\n\n');
            
            const contextSummary = `CURRENT CONTEXT AVAILABLE TO YOU:
- Sources loaded: ${allocated.length}
- Included data: ${allocated.map(a => a.name).join(' | ')}

RULES FOR USING CONTEXT:
1. When using Search/Replace blocks, copy the EXACT code from the context provided below. Do NOT guess or paraphrase code.
2. If you cannot see the required file content, ask the user to share it using @file "path/to/file" or use your read tools.
3. For large changes, break them into multiple Search/Replace blocks.
4. Always include the filepath header: **\`src/path/file.ext\`**\n\n`;

            finalPrompt = `--- Context ---\n${contextSummary}${contextString}\n\n--- User Request ---\n${finalPrompt}`;
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
            
            // Global Save logic: Save in user's home directory to share across projects and prevent GitHub leaks
            const os = require('os');
            const globalDir = path.join(os.homedir(), '.ultra-light-ai');
            if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });
            const configPath = path.join(globalDir, 'config.json');

            const isAdvancedMode = !!(message.config.mainBrain && message.config.supportBrain && message.config.supportBrain.model);

            const newConfig: AgentConfig = {
                // Preserve Legacy structure so older systems don't crash
                providers: {
                    cloud: {
                        model: message.config.mainBrain?.providerType === 'cloud' ? message.config.mainBrain.model : 'gemini-1.5-pro',
                        apiKey: message.config.mainBrain?.apiKey || '',
                        rpmLimit: 15,
                        timeoutSeconds: Number(message.config.timeoutSeconds)
                    },
                    local: {
                        model: message.config.mainBrain?.providerType === 'local' ? message.config.mainBrain.model : 'llama3',
                        endpoint: message.config.mainBrain?.endpoint || 'http://127.0.0.1:11434'
                    }
                },
                activeProvider: message.config.mainBrain?.providerType || 'cloud',

                // New Dual-Brain Config
                mainBrain: message.config.mainBrain,
                supportBrain: message.config.supportBrain,
                advancedModeEnabled: isAdvancedMode,

                contextLimits: {
                    maxOutputTokens: Number(message.config.maxOutputTokens || message.config.maxTokens || 8192),
                    maxContextTokens: Number(message.config.maxContextTokens || 32000),
                    historyLength: Number(message.config.historyLength || 10)
                },
                systemInstructions: message.config.systemInstructions
            };

            fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');
            
            // BUG FIX: Sync to local workspace config if it exists so it doesn't shadow the global save
            const localConfigPath = path.join(workspaceRoot, '.vscode', 'ultra-light-ai.json');
            const legacyConfigPath = path.join(workspaceRoot, '.agent-config.json');
            if (fs.existsSync(localConfigPath)) {
                fs.writeFileSync(localConfigPath, JSON.stringify(newConfig, null, 2), 'utf8');
            } else if (fs.existsSync(legacyConfigPath)) {
                fs.writeFileSync(legacyConfigPath, JSON.stringify(newConfig, null, 2), 'utf8');
            }

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
                        const blockRegex = /<<<<<<<\s*SEARCH\r?\n?([\s\S]*?)\r?\n?=======\r?\n?([\s\S]*?)\r?\n?>>>>>>>\s*REPLACE/g;
                        let match;
                        let blocksFound = false;
                        
                        while ((match = blockRegex.exec(content)) !== null) {
                            blocksFound = true;
                            const searchStr = match[1];
                            const replaceStr = match[2];
                            const patchResult = await this.applyPatchWithTiers(fileText, searchStr, replaceStr, filepath, false);
                            
                            if (patchResult.success) {
                                fileText = patchResult.text;
                            } else {
                                throw new Error(`Could not find the specified search block in ${filepath}. Ensure the code exactly matches the file context.`);
                            }
                        }
                        
                        // Regex Fallback to Scout Brain
                        if (!blocksFound && (content.includes('<<<<<<<') || content.includes('======='))) {
                            const config = getAgentConfig(workspaceRoot);
                            const isAdvanced = config?.advancedModeEnabled && config?.supportBrain?.model;
                            
                            if (isAdvanced) {
                                this.postMessageToWebview({
                                    command: 'statusUpdate',
                                    text: `🤖 Regex parsing failed. Scout Brain is recovering malformed blocks...`
                                });
                                try {
                                    const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');
                                    let scoutClient;
                                    const supportBrain = config.supportBrain;
                                    if (supportBrain.providerType === 'local') {
                                        scoutClient = new LocalOllamaClient(supportBrain.model || 'llama-3.1-8b-instant', supportBrain.endpoint || 'http://127.0.0.1:11434', supportBrain.apiKey);
                                    } else {
                                        scoutClient = new GeminiCloudClient([supportBrain.apiKey?.trim() || ''], supportBrain.model || 'gemini-1.5-flash', 60);
                                    }
                                    
                                    const fixPrompt = `Extract SEARCH and REPLACE blocks from this text. Return ONLY a valid JSON array of objects with "search" and "replace" keys. No markdown.\n\n${content}`;
                                    const fixResponse = await scoutClient.complete(fixPrompt);
                                    
                                    const jsonStr = fixResponse.text.replace(/```json/gi, '').replace(/```/g, '').trim();
                                    const parsedBlocks = JSON.parse(jsonStr);
                                    
                                    for (const b of parsedBlocks) {
                                        blocksFound = true;
                                        const patchResult = await this.applyPatchWithTiers(fileText, b.search, b.replace, filepath, false);
                                        if (patchResult.success) fileText = patchResult.text;
                                    }
                                } catch (err) {
                                    console.error("Scout recovery failed:", err);
                                }
                            }
                        }
                        
                        if (!blocksFound) {
                            throw new Error(`Malformed Search/Replace block in ${filepath}. Check if the block format is exactly <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE`);
                        }
                    } else {
                        // Full file replacement
                        if (fs.existsSync(fullPath) && fileText.trim().length > 0) {
                            // Safety Circuit Breaker: If AI forgets tags and outputs a small snippet, it might wipe the file.
                            if (content.length < fileText.length * 0.5) {
                                const userChoice = await vscode.window.showWarningMessage(
                                    `⚠️ DANGER: AI is trying to overwrite the ENTIRE file "${path.basename(filepath)}", but the new code is much shorter (>50% smaller). The AI likely forgot SEARCH/REPLACE tags. Proceed?`,
                                    { modal: true },
                                    'Overwrite File Anyway', 'Cancel'
                                );
                                if (userChoice !== 'Overwrite File Anyway') {
                                    throw new Error(`Aborted overwrite of ${filepath}. Ask the AI to use <<<<<<< SEARCH format for partial edits.`);
                                }
                            }
                        }
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
            this.postMessageToWebview({
                command: 'applyFailed',
                error: error?.message || 'Unknown error'
            });
        }
    }

    /**
     * Open the .agent-config.json file in the editor.
     */
    private handleOpenConfig(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            
            // Open Global Config
            const os = require('os');
            const globalConfigPath = path.join(os.homedir(), '.ultra-light-ai', 'config.json');
            const finalPath = fs.existsSync(globalConfigPath) ? globalConfigPath : null;
            
            if (finalPath && fs.existsSync(finalPath)) {
                vscode.workspace.openTextDocument(finalPath).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
            } else {
                vscode.window.showErrorMessage('Global Agent configuration file does not exist yet. Please save settings from the UI first.');
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

        // Action Block UI Interceptor added
        this.postMessageToWebview({
            command: 'streamChunk',
            text: `\n\n> 🤖 **AI Wants to Execute:**\n> \`\`\`bash\n> ${command}\n> \`\`\`\n> *Command placed in terminal. Review and press Enter to execute.*`,
            done: false
        });
        
        let terminal = vscode.window.terminals.find(t => t.name === 'Ultra Light AI');
        if (!terminal) {
            terminal = vscode.window.createTerminal('Ultra Light AI');
        }
        terminal.show();
        // Set addNewLine to false so the user can edit the command before hitting enter
        terminal.sendText(command, false);
        vscode.window.showInformationMessage('Command placed in terminal. Edit it if needed, then press Enter.');
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

    /**
     * Clears the current chat memory, creates a new session, and notifies the webview to reset the UI.
     */
    public clearChat(): void {
        this.conversationHistory.clear();
        if ((this as any)._onResetCb) {
            (this as any)._onResetCb();
        }
        this.postMessageToWebview({ command: 'chatCleared' });
    }
}
