import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GeminiCloudClient } from '../router/realClients';
import { applyDiffToActiveFile, applyRobustSearchReplace, resolveSafeWorkspacePath } from '../operations/diffPatcher';
import { getGeminiApiKeys, getGeminiModel, getGeminiTimeout, getAgentConfig, ensureAgentConfig, AgentConfig } from '../config';
import { ConversationHistory } from '../state/conversationHistory';
import { allocateBudget, ContextSource, estimateTokens, truncateToTokens, TokenAccountant } from '../utils/tokenBudget';
import { skeletonizeFile, generateStructuralRepoMap } from '../utils/astSkeletonizer';
import { extractBrandDNA, orchestrateAssets, DesignSemantics } from '../utils/designBrain';
import { generateCacheKey, checkCache, saveCache } from '../utils/queryCache';
import { ContextSelector } from '../utils/contextSelector';
import { DependencyGraph } from '../utils/dependencyGraph';
import { SettingsHandler } from './settingsHandler';
import { PromptBuilder } from './promptBuilder';
import { PromptClassifier } from '../utils/promptClassifier';
import { DiffValidator } from '../operations/diffValidator';
import { ProjectScanner } from '../indexer/projectScanner';
import { TaskPlanner } from '../state/taskPlanner';
import { FileVersioning } from '../operations/fileVersioning';
import { TerminalCapture } from '../tools/terminalCapture';
import { ErrorDiagnoser } from '../utils/errorDiagnoser';
import { SessionMemory } from '../state/sessionMemory';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private conversationHistory: ConversationHistory;
    private currentStreamAbortController: AbortController | null = null;
    private currentSeqOp: any = null; // Store reference to cancel Architect queue
    private _onStartCb?: any;
    private _onResetCb?: any;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private _workspaceRoot: string,
        private ragEngine?: any
    ) {
        const config = require('../config').getAgentConfig(this._workspaceRoot);
        const historyLimit = config?.contextLimits?.historyLength || 10;
        this.conversationHistory = new ConversationHistory(historyLimit * 2, this._workspaceRoot);
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

            // Inject local Tailwind CSS URI
            const tailwindUri = webviewView.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'dist', 'tailwind.css')
            );
            htmlContent = htmlContent.replace('{{TAILWIND_CSS_URI}}', tailwindUri.toString());
            
            // Inject local marked.js
            const markedUri = webviewView.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'marked', 'marked.min.js')
            );
            htmlContent = htmlContent.replace('{{MARKED_URI}}', markedUri.toString());

            // Inject local highlight.js
            const highlightJsUri = webviewView.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@highlightjs', 'cdn-assets', 'highlight.min.js')
            );
            htmlContent = htmlContent.replace('{{HIGHLIGHT_JS_URI}}', highlightJsUri.toString());

            // Inject local highlight.css
            const highlightCssUri = webviewView.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@highlightjs', 'cdn-assets', 'styles', 'atom-one-dark.min.css')
            );
            htmlContent = htmlContent.replace('{{HIGHLIGHT_CSS_URI}}', highlightCssUri.toString());

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
                        maxContextTokens: config?.contextLimits?.maxContextTokens || 7000,
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
                
                // NEW: Trigger Cold Start Onboarding for new projects
                if (workspaceRoot) {
                    this.checkAndRunOnboarding(workspaceRoot);
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
                    const activeEditor = vscode.window.activeTextEditor;
                    if (activeEditor) {
                        const fullPath = activeEditor.document.uri.fsPath;
                        this.conversationHistory.addFileBackupToLatestMessage(fullPath, activeEditor.document.getText());
                    }
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
                        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        
                        const fileToOldestContent = new Map<string, string | null>();
                        
                        // 1. Collect oldest file backups from the messages being rolled back
                        for (const msg of msgsToRevert) {
                            if ((msg as any).fileBackups) {
                                for (const backup of (msg as any).fileBackups) {
                                    if (!fileToOldestContent.has(backup.filepath)) {
                                        fileToOldestContent.set(backup.filepath, backup.content);
                                    }
                                }
                            }
                        }

                        // 2. Fallback: Detect files mentioned in modified blocks that might lack explicit backup
                        if (workspaceRoot) {
                            for (const msg of msgsToRevert) {
                                const fileMatches = (msg.text || '').matchAll(/\*\*\`([^\`]+)\`\*\*/g);
                                for (const m of fileMatches) {
                                    const candidateRel = m[1];
                                    const fullPath = path.isAbsolute(candidateRel) ? candidateRel : path.join(workspaceRoot, candidateRel);
                                    if (!fileToOldestContent.has(fullPath)) {
                                        const snap = FileVersioning.getLatestSnapshot(workspaceRoot, fullPath);
                                        if (snap !== null) {
                                            fileToOldestContent.set(fullPath, snap);
                                        }
                                    }
                                }
                            }
                        }

                        // 3. Revert both disk and VS Code Buffers
                        for (const [filepath, content] of fileToOldestContent.entries()) {
                            const fileUri = vscode.Uri.file(filepath);
                            if (content === null) {
                                // Newly created file in this session -> Delete from disk and workspace!
                                if (fs.existsSync(filepath)) {
                                    try {
                                        fs.unlinkSync(filepath);
                                    } catch (e) {
                                        console.error("Failed to delete file on rollback", filepath, e);
                                    }
                                }
                                revertEdit.deleteFile(fileUri, { ignoreIfNotExists: true });
                                hasEdits = true;
                                revertedCount++;
                            } else {
                                // Modified file -> Restore exact original state to disk & buffer
                                try {
                                    fs.writeFileSync(filepath, content, 'utf8');
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
                                    }
                                    revertedCount++;
                                } catch (e) {
                                    console.error("Failed to restore file on rollback", filepath, e);
                                }
                            }
                        }

                        if (hasEdits) {
                            await vscode.workspace.applyEdit(revertEdit);
                            // Save any open documents to ensure zero unsaved dirty mismatch
                            for (const filepath of fileToOldestContent.keys()) {
                                const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filepath);
                                if (doc && doc.isDirty) {
                                    await doc.save();
                                }
                            }
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
                        this.postMessageToWebview({
                            command: 'statusUpdate',
                            text: `⏪ Rollback complete: Reverted ${revertedCount} file(s) and restored prompt.`
                        });
                        vscode.window.showInformationMessage(`⏪ Chat rolled back. Reverted ${revertedCount} file(s) automatically.`);
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
            } else if (message.command === 'clearCache') {
                this.handleClearCache();
            } else if (message.command === 'rollbackFile') {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (workspaceRoot && message.filepath) {
                    const fullPath = path.isAbsolute(message.filepath) ? message.filepath : path.join(workspaceRoot, message.filepath);
                    const content = FileVersioning.getLatestSnapshot(workspaceRoot, fullPath);
                    if (content !== null) {
                        fs.writeFileSync(fullPath, content, 'utf8');
                        const fileUri = vscode.Uri.file(fullPath);
                        let doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === fullPath);
                        if (doc) {
                            const edit = new vscode.WorkspaceEdit();
                            const fullRange = new vscode.Range(
                                doc.positionAt(0),
                                doc.positionAt(doc.getText().length)
                            );
                            edit.replace(fileUri, fullRange, content);
                            await vscode.workspace.applyEdit(edit);
                            await doc.save();
                        }
                        vscode.window.showInformationMessage(`✅ Rolled back ${path.basename(fullPath)} to previous snapshot.`);
                    } else {
                        vscode.window.showErrorMessage(`❌ No snapshots found for ${path.basename(fullPath)}`);
                    }
                }
            } else if (message.command === 'runAndCapture') {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
                if (workspaceRoot && message.cmd) {
                    vscode.window.showInformationMessage(`Running: ${message.cmd}`);
                    TerminalCapture.runAndCapture(message.cmd, workspaceRoot).then(output => {
                        this.postMessageToWebview({
                            command: 'statusUpdate',
                            text: `Terminal Execution Complete. AI has read the output.`
                        });
                        this.postMessageToWebview({
                            command: 'injectChatAndSend',
                            text: `I executed \`${message.cmd}\`. Please analyze the output and fix any errors.`
                        });
                    });
                }
            }
        });
    }

    /**
     * Dynamic Multi-Root / Workspace Switch Update
     */
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

    /**
     * Returns the path to the dedicated AI metadata directory for the workspace, creating it if it doesn't exist.
     * @param workspaceRoot The root path of the current workspace.
     */
    private getAiMetaDir(workspaceRoot: string): string {
        const dir = path.join(workspaceRoot, '.ultra-light-ai');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }
    /**
     * Detects if a project is new (No ARCHITECTURE.md and > 1 file)
     * Runs a silent background scan to build context without blocking the UI.
     */
    private async checkAndRunOnboarding(workspaceRoot: string): Promise<void> {
        try {
            await ProjectScanner.scanProject(workspaceRoot);

            const archPath = path.join(workspaceRoot, 'ARCHITECTURE.md');
            const newArchPath = path.join(this.getAiMetaDir(workspaceRoot), 'ARCHITECTURE.md');
            if (fs.existsSync(archPath) || fs.existsSync(newArchPath)) return; // Already onboarded!
            // Check if folder actually has files (ignoring hidden files and node_modules)
            const userIgnoreFolders = vscode.workspace.getConfiguration('ultraLightAI').get<string[]>('ignoreFolders') || [];
            const combinedIgnores = Array.from(new Set([...userIgnoreFolders, 'node_modules', '.git', 'dist', 'out', 'build', '.next', '.vscode', '.venv', 'venv', 'coverage', '__pycache__']));
            
            const filesInRoot = fs.readdirSync(workspaceRoot).filter(f => !f.startsWith('.') && !combinedIgnores.includes(f));
            if (filesInRoot.length <= 1) return; // Too small or empty, skip onboarding

            // 1. Show Loading UI
            this.postMessageToWebview({ command: 'showOnboarding' });

            // 2. Fetch lightweight file tree to save tokens (DO NOT read full files here)
            const excludePattern = `{${combinedIgnores.map(f => `**/${f}/**`).join(',')},**/*.lock}`;
            const vscodeFiles = await vscode.workspace.findFiles('**/*', excludePattern, 30);
            const fileList = vscodeFiles.map(f => path.relative(workspaceRoot, f.fsPath));
            
            if (fileList.length === 0) {
                this.postMessageToWebview({ command: 'onboardingFailed' });
                return;
            }

            // 3. Use the Support Brain (Scout) to generate the file silently
            const config = getAgentConfig(workspaceRoot);
            const brain = config?.supportBrain?.model ? config.supportBrain : config?.mainBrain;
            if (!brain || !brain.model) return;

            const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');
            let client;
            if (brain.providerType === 'local') {
                client = new LocalOllamaClient(brain.model, brain.endpoint || 'http://127.0.0.1:11434', brain.apiKey);
            } else {
                client = new GeminiCloudClient([brain.apiKey?.trim() || ''], brain.model, 60);
            }

            const prompt = `You are a project analyzer. I am passing a list of files from a new project. Generate a very brief 'ARCHITECTURE.md' file explaining the probable Tech Stack, Entry Points, and Structure based strictly on these file names.\nReturn ONLY the markdown content. No conversational text.\n\nFiles:\n${fileList.join('\n')}`;
            
            const res = await client.complete(prompt);
            const cleanArch = res.text.replace(/```markdown/gi, '').replace(/```/g, '').trim();
            
            fs.writeFileSync(newArchPath, cleanArch, 'utf8');
            this.postMessageToWebview({ command: 'onboardingComplete' });
        } catch (error) {
            this.postMessageToWebview({ command: 'onboardingFailed' });
        }
    }

    private async handleRequestWorkspaceFiles(query: string = ''): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) return;
            
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            // Use vscode findFiles to get max 20 files matching the query (if provided) or recent files
            const searchPattern = query ? `**/*${query}*` : '**/*';
            const userIgnoreFolders = vscode.workspace.getConfiguration('ultraLightAI').get<string[]>('ignoreFolders') || [];
            const combinedIgnores = Array.from(new Set([...userIgnoreFolders, 'node_modules', '.git', 'dist', 'out', 'build', '.next', '.vscode', '.venv', 'venv', 'coverage', '__pycache__']));
            const excludePattern = `{${combinedIgnores.map(f => `**/${f}/**`).join(',')},**/*.lock}`;
            
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
    private async applyPatchWithTiers(fileText: string, searchStr: string, replaceStr: string, filepath: string, isPreview: boolean = false): Promise<{ success: boolean, text: string, error?: string }> {
        // BUG FIX: Prevent Markdown backtick corruption if LLM hallucinates them inside SEARCH/REPLACE blocks
        if (!filepath.toLowerCase().endsWith('.md')) {
            // Strip leading ```lang and trailing ``` from both search and replace blocks
            searchStr = searchStr.replace(/^\s*```[a-zA-Z]*\r?\n/g, '').replace(/\r?\n```\s*$/g, '');
            replaceStr = replaceStr.replace(/^\s*```[a-zA-Z]*\r?\n/g, '').replace(/\r?\n```\s*$/g, '');
        }

        // Validate replacement content first - abort if lazy placeholders or accidental wipes are found
        const val = DiffValidator.validateReplacementContent(replaceStr);
        if (!val.valid) {
            return { success: false, text: fileText, error: val.reason };
        }

        const patchResult = applyRobustSearchReplace(fileText, searchStr, replaceStr);
        
        // Tier 1: Exact Match / DiffPatcher
        if (patchResult.success) {
            return { success: true, text: patchResult.result || (patchResult as any).patched || fileText };
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
                    fileLines.splice(startIdx, endIdx - startIdx + 1, ...replaceStr.split('\n'));
                    return { success: true, text: fileLines.join('\n') };
                }
            }
        }

        // Job 1: SEARCH Block Healer (Micro-Task)
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                const config = require('../config').getAgentConfig(workspaceFolders[0].uri.fsPath);
                if (config?.supportBrain?.model) {
                    const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');
                    let scoutClient;
                    if (config.supportBrain.providerType === 'local') {
                        scoutClient = new LocalOllamaClient(config.supportBrain.model || 'llama-3.1-8b-instant', config.supportBrain.endpoint || 'http://127.0.0.1:11434', config.supportBrain.apiKey);
                    } else {
                        const keyStr = config.supportBrain.apiKey?.trim() || '';
                        if (keyStr.startsWith('gsk_')) scoutClient = new LocalOllamaClient(config.supportBrain.model, 'https://api.groq.com/openai', keyStr);
                        else if (keyStr.startsWith('sk-') || keyStr.startsWith('sk-proj-')) scoutClient = new LocalOllamaClient(config.supportBrain.model, 'https://api.openai.com', keyStr);
                        else scoutClient = new GeminiCloudClient([keyStr], config.supportBrain.model || 'gemini-1.5-flash', 60);
                    }
                    
                    this.postMessageToWebview({ command: 'statusUpdate', text: `🩺 Scout Healer: Attempting to fix broken SEARCH block in ${path.basename(filepath)}...` });
                    
                    const healerPrompt = `The AI generated a SEARCH block to edit a file, but it doesn't match the file exactly.\n\nBroken SEARCH block:\n\`\`\`\n${searchStr}\n\`\`\`\n\nActual file content (first 200 lines):\n\`\`\`\n${fileText.split('\n').slice(0, 200).join('\n')}\n\`\`\`\n\nReturn ONLY the corrected SEARCH block that perfectly matches the actual file content. Do NOT include markdown fences, just the exact raw text lines that need to be replaced. Do not explain.`;
                    
                    const healerResponse = await scoutClient.complete(healerPrompt);
                    const healedSearchStr = healerResponse.text.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '').trim();
                    
                    const healedPatchResult = applyRobustSearchReplace(fileText, healedSearchStr, replaceStr);
                    if (healedPatchResult.success) {
                        return { success: true, text: healedPatchResult.result || (healedPatchResult as any).patched || fileText };
                    }
                }
            }
        } catch (e) {
            console.error("Scout SEARCH Healer failed", e);
        }

        // Tier 4: AST Symbol Fallback (if targeting a function, class, or method)
        try {
            const symbolRegex = /(?:function|class|interface|type|const|let|var|def|async\s+function)\s+([a-zA-Z0-9_$]+)/;
            const symMatch = searchStr.match(symbolRegex);
            if (symMatch && symMatch[1]) {
                const targetSymbolName = symMatch[1];
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    const workspaceRoot = workspaceFolders[0].uri.fsPath;
                    const safeCheck = resolveSafeWorkspacePath(filepath, workspaceRoot, false);
                    if (safeCheck.safe && fs.existsSync(safeCheck.resolvedPath)) {
                        const uri = vscode.Uri.file(safeCheck.resolvedPath);
                        const symbols: vscode.DocumentSymbol[] | undefined = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
                        if (symbols && symbols.length > 0) {
                            const findSymbol = (syms: vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
                                for (const s of syms) {
                                    if (s.name === targetSymbolName) return s;
                                    if (s.children) { const c = findSymbol(s.children); if (c) return c; }
                                }
                            };
                            const target = findSymbol(symbols);
                            if (target) {
                                const fileLines = fileText.split('\n');
                                const startLine = target.range.start.line;
                                const endLine = target.range.end.line;
                                if (startLine >= 0 && endLine < fileLines.length) {
                                    fileLines.splice(startLine, endLine - startLine + 1, ...replaceStr.split('\n'));
                                    return { success: true, text: fileLines.join('\n') };
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("AST Symbol Fallback failed", e);
        }

        // Tier 5: Diff Validator Guard - Never silently append code to prevent file corruption
        const validation = DiffValidator.validatePatch(fileText, searchStr);
        const errorMsg = patchResult.error || validation.reason || `Search block could not be matched safely in ${path.basename(filepath)}. No changes were applied to prevent file corruption.`;
        if (isPreview) {
            return { success: false, text: `/* 🚫 BLOCKED: ${errorMsg} */\n` + fileText, error: errorMsg };
        } else {
            return { success: false, text: fileText, error: errorMsg };
        }
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
                
                // Removed old Scout Regex Fallback -> Replaced by Job 1 SEARCH Healer above
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
            const maxContextTokens = config?.contextLimits?.maxContextTokens || 7000;

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
            const category = PromptClassifier.classifyPrompt(text);
            const repoMap = workspaceRoot ? await generateStructuralRepoMap(workspaceRoot, 25) : '';
            const systemInstruction = PromptBuilder.buildSystemInstruction(config, workspaceRoot, false, false, category, repoMap);
            TokenAccountant.measureSystemPrompt(systemInstruction);
            let finalPrompt = await this.buildPrompt(text, includeActiveFile, false, false, workspaceRoot);

            // Add ONLY the user's raw message to history (BUG-03 FIX)
            this.conversationHistory.addMessage('user', text);

            const historyLimit = config?.contextLimits?.historyLength || 10;
            const historyTokenLimit = Math.min(12000, maxContextTokens * 0.4);

            // Check if we need to summarize due to length or token budget BEFORE blind trimming
            if ((this.conversationHistory.length / 2 > historyLimit || this.conversationHistory.estimateTokens() > historyTokenLimit) 
                && this.conversationHistory.length >= 6) {
                this.postMessageToWebview({
                    command: 'statusUpdate',
                    text: `🧠 Memory optimizing: Compressing older context to save tokens (Zero API cost)...`
                });
                try {
                    // Local compression without API call. Keep slightly less than the limit to free space.
                    const keepRecent = Math.max(2, Math.floor(historyLimit * 0.5));
                    this.conversationHistory.localCompress(keepRecent);
                    this.postMessageToWebview({ command: 'statusUpdate', text: `✅ Context compressed locally (kept ${keepRecent} recent turns).` });
                } catch (err) { console.error('Compression failed', err); }
            }

            // Trim history token budget as a failsafe
            this.conversationHistory.trimToTokenBudget(historyTokenLimit);

            // Use multi-turn API
            const history = this.conversationHistory.getHistory(
                historyLimit
            );

            // Remove the last user message from history since we pass it separately
            const historyWithoutLast = history.slice(0, -1);
            
            const cacheKey = workspaceRoot ? generateCacheKey(systemInstruction, historyWithoutLast, finalPrompt) : null;
            if (cacheKey && workspaceRoot) {
                const cachedResponse = checkCache(workspaceRoot, cacheKey);
                if (cachedResponse) {
                    this.postMessageToWebview({
                        command: 'statusUpdate',
                        text: `⚡ Cache Hit: Zero-cost instant response loaded!`
                    });
                    const cleanResponseText = cachedResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/<\/think>/gi, '');
                    this.conversationHistory.addMessage('model', cleanResponseText);
                    this.postMessageToWebview({
                        command: 'receiveChat',
                        text: cachedResponse
                    });
                    return;
                }
            }

            this.postMessageToWebview({
                command: 'statusUpdate',
                text: `📚 Context Window: Sending previous ${historyWithoutLast.length} messages...`
            });

            const reply = await client.completeWithHistory(
                systemInstruction,
                historyWithoutLast,
                finalPrompt
            );

            if (cacheKey && workspaceRoot && reply.text) {
                saveCache(workspaceRoot, cacheKey, reply.text);
            }

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
            const maxContextTokens = config?.contextLimits?.maxContextTokens || 7000;

            const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');

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
                        const activeKeys = keyStr ? [keyStr] : keys;
                        mainClient = new GeminiCloudClient(activeKeys, mainBrain.model || 'gemini-1.5-pro', timeout, maxOutputTokens);
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
                    else mainClient = new GeminiCloudClient(keys, model, timeout, maxOutputTokens);
                }
            }
            
            const client = mainClient;

            // Auto-inject ARCHITECTURE.md ALWAYS
            let architectureContext = '';
            if (workspaceRoot) {
                const archPath = path.join(this.getAiMetaDir(workspaceRoot), 'ARCHITECTURE.md');
                if (fs.existsSync(archPath)) {
                    architectureContext = `\n<project_architecture>\n${fs.readFileSync(archPath, 'utf8')}\n</project_architecture>\n`;
                }
            }

            // Build system instruction
            const promptCategory = PromptClassifier.classifyPrompt(message.text);
            const repoMap = workspaceRoot ? await generateStructuralRepoMap(workspaceRoot, 25) : '';
            let systemInstruction = PromptBuilder.buildSystemInstruction(config, workspaceRoot, false, !!message.architectMode, promptCategory, repoMap);
            
            // Task Planner Injection
            if (workspaceRoot) {
                // In Architect Mode, EVERY request is considered complex to enforce plan-first workflow
                const isComplex = message.architectMode || TaskPlanner.isComplexRequest(message.text);
                const planState = TaskPlanner.readPlan(workspaceRoot);
                
                if (isComplex && !planState.isActive) {
                    systemInstruction += `\n\n[TASK PLANNER ACTIVE]\nThe user's request is complex. DO NOT write any actual code yet. You MUST first generate a detailed step-by-step plan using a markdown file. Write your plan to **\`.ultra-light-ai/PLAN.md\`** using the SEARCH/REPLACE format. Number the steps 1, 2, 3...`;
                } else if (planState.isActive) {
                    systemInstruction += `\n\n[TASK PLANNER ACTIVE]\nAn active plan exists:\n${planState.planContent}\n\nReview the plan. Complete the next step. If a step is done, mark it as [x] in the PLAN.md file. Only focus on one step at a time!`;
                }
            }
            
            TokenAccountant.measureSystemPrompt(systemInstruction);
            let finalPrompt = await this.buildPrompt(message.text, false, false /* Disable hardcoded search */, false, workspaceRoot);
            

            
            if (architectureContext) {
                finalPrompt = architectureContext + '\n' + finalPrompt;
            }

            // Add ONLY the user's raw message to history to prevent infinite context scaling
            this.conversationHistory.addMessage('user', message.text, undefined, message.timestamp);
            
            const historyLimit = config?.contextLimits?.historyLength || 10;
            const historyTokenLimit = Math.min(12000, maxContextTokens * 0.4);

            // SMART SUMMARIZER: Safely compress history if it exceeds user's limit OR token limit
            if ((this.conversationHistory.length / 2 > historyLimit || this.conversationHistory.estimateTokens() > historyTokenLimit) 
                && this.conversationHistory.length >= 6) {
                this.postMessageToWebview({
                    command: 'statusUpdate',
                    text: `🧠 Memory optimizing: Compressing older context to save tokens (Zero API cost)...`
                });
                try {
                    // Local compression without API call. Keep slightly less than the limit to free space.
                    const keepRecent = Math.max(2, Math.floor(historyLimit * 0.5));
                    this.conversationHistory.localCompress(keepRecent);
                    this.postMessageToWebview({
                        command: 'statusUpdate',
                        text: `✅ Context compressed locally (kept ${keepRecent} recent turns).`
                    });
                } catch (err) {
                    console.error('Local compression failed', err);
                }
            }
            
            // Trim token budget as a failsafe
            this.conversationHistory.trimToTokenBudget(historyTokenLimit);

            let history = this.conversationHistory.getHistory(
                historyLimit
            );

            const historyWithoutLast = history.slice(0, -1);
            
            const cacheKey = workspaceRoot ? generateCacheKey(systemInstruction, historyWithoutLast, finalPrompt) : null;
            if (cacheKey && workspaceRoot) {
                const cachedResponse = checkCache(workspaceRoot, cacheKey);
                if (cachedResponse) {
                    this.postMessageToWebview({
                        command: 'statusUpdate',
                        text: `⚡ Cache Hit: Zero-cost instant response loaded!`
                    });
                    this.postMessageToWebview({
                        command: 'streamChunk',
                        text: cachedResponse,
                        done: true
                    });
                    const cleanResponseText = cachedResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/<\/think>/gi, '');
                    this.conversationHistory.addMessage('model', cleanResponseText);
                    return;
                }
            }

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
                            description: "Updates or creates ARCHITECTURE.md with the latest project context, architecture, and recent changes. ONLY use this AFTER you have successfully added a feature or modified files. DO NOT hallucinate details for an empty/new project.",
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
                        },
                        {
                            name: "generate_ui_blueprint",
                            description: "Generates a deterministic Brand DNA (Colors, Fonts, Inline SVG, Image URLs) for UI/UX tasks. Use this BEFORE writing frontend code for a new website/component.",
                            parameters: {
                                type: "object",
                                properties: {
                                    industry: { type: "string", description: "e.g., fitness, fintech, healthcare, saas, ecommerce, default" },
                                    audience: { type: "string" },
                                    emotion: { type: "string" },
                                    palette_mood: { type: "string", enum: ["dark", "light"] },
                                    sections: { type: "array", items: { type: "string" }, description: "List of sections needed, e.g., ['hero', 'features', 'testimonials']" },
                                    layout: { type: "string", description: "e.g., full-width landing, dashboard" },
                                    typography_feel: { type: "string", description: "e.g., bold, elegant, modern, friendly" },
                                    corner_style: { type: "string", enum: ["sharp", "rounded", "pill"], description: "OPTIONAL: The corner style for buttons and cards. Defaults to 'rounded'." },
                                    custom_colors: { type: "object", properties: { primary: { type: "string" }, accent: { type: "string" }, surface: { type: "string" } }, description: "OPTIONAL: Use ONLY if the user explicitly requested specific colors (e.g. Neon Pink, Hacker Green). Otherwise leave blank." },
                                    custom_font: { type: "string", description: "OPTIONAL: Use ONLY if the user explicitly requested a specific font family. Otherwise leave blank." }
                                },
                                required: ["industry", "audience", "emotion", "palette_mood", "sections", "layout", "typography_feel"]
                            }
                        }
                    ]
                }
            ];

            // Add Terminal Command execution tool
            const executeTerminalTool: any = {
                name: "execute_terminal_command",
                description: "Requests execution of a terminal shell command (e.g. npm test, npm install, build scripts). The command will be displayed transparently in the UI for user review and approval before running in the Integrated Terminal.",
                parameters: {
                    type: "object",
                    properties: {
                        command: { type: "string", description: "The exact terminal command to execute." },
                        explanation: { type: "string", description: "A brief reason why this command needs to be executed." }
                    },
                    required: ["command"]
                }
            };
            tools[0].functionDeclarations.push(executeTerminalTool);

            if (message.includeWebSearch) {
                const searchWebTool: any = {
                    name: "search_web",
                    description: "Searches the internet for information, documentation, or code examples when you do not know the answer. ONLY use this when you explicitly need external information.",
                    parameters: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"] }
                };
                tools[0].functionDeclarations.push(searchWebTool);
            }

            const filteredTools = PromptClassifier.filterTools(promptCategory, tools);

            let consecutiveReadCount = 0;
            const readFilesThisTurn = new Set<string>();

            const onToolCall = async (functionCall: any) => {
                if (functionCall.name === 'read_multiple_files') {
                    // Maximum of 3 consecutive read actions before forcing a synthesis or plan turn
                    if (consecutiveReadCount >= 3) {
                        return "Throttling Limit: You have reached the limit of 3 consecutive file read operations. You must now synthesize your findings, present a concrete plan, or output your code changes before requesting further file reads.";
                    }
                    consecutiveReadCount++;

                    const filepaths = functionCall.args?.filepaths;
                    if (!filepaths || !Array.isArray(filepaths) || !workspaceRoot) return "Error: No filepaths array or workspace.";
                    
                    this.postMessageToWebview({
                        command: 'toolCallEvent',
                        tool: 'read_multiple_files',
                        title: 'Inspecting Files',
                        data: { count: filepaths.length, files: filepaths.slice(0, 3).map(f => path.basename(f)).join(', ') }
                    });
                    
                    let combinedResult = '';
                    for (const filepath of filepaths) {
                        const normalizedKey = filepath.trim().replace(/\\/g, '/');
                        if (readFilesThisTurn.has(normalizedKey)) {
                            combinedResult += `\n--- File: ${filepath} [CACHED / ALREADY INSPECTED] ---\n(File content was already provided earlier in this turn. Please use the previously retrieved context.)\n`;
                            continue;
                        }
                        readFilesThisTurn.add(normalizedKey);

                        const safeCheck = resolveSafeWorkspacePath(filepath, workspaceRoot, false);
                        if (!safeCheck.safe) {
                            combinedResult += `\n--- File: ${filepath} (Blocked: Path resolves outside workspace) ---\n`;
                            continue;
                        }
                        const fullPath = safeCheck.resolvedPath;

                        if (fs.existsSync(fullPath)) {
                            let content = fs.readFileSync(fullPath, 'utf8');
                            if (estimateTokens(content) > 3000) {
                                content = truncateToTokens(content, 3000) + '\n\n... (File truncated to stay within limits. Use search_codebase to find specific functions.)';
                            }
                            combinedResult += `\n--- File: ${filepath} ---\n${content}\n`;
                            
                            // Step 3: Inject dependencies to give inter-file context
                            if (content.trim().length > 0) {
                                const skeletons = await DependencyGraph.getImportSkeletons(fullPath, content, workspaceRoot);
                                if (skeletons) {
                                    combinedResult += skeletons;
                                }
                            }
                        } else if (filepath.includes('ARCHITECTURE')) {
                            const ruleFiles = ['ARCHITECTURE.md', 'AI_RULES.md', '.cursorrules', '.agent-rules.md'];
                            let found = false;
                            for (const ruleFile of ruleFiles) {
                                const rulePath = ruleFile === 'ARCHITECTURE.md' ? path.join(this.getAiMetaDir(workspaceRoot), ruleFile) : path.join(workspaceRoot, ruleFile);
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
                } else {
                    consecutiveReadCount = 0;
                }

                if (functionCall.name === 'update_architecture_context') {
                    if (!workspaceRoot) return "Error: No workspace.";
                    const content = functionCall.args?.content || '';
                    const archPath = path.join(this.getAiMetaDir(workspaceRoot), 'ARCHITECTURE.md');
                    fs.writeFileSync(archPath, content, 'utf8');
                    this.postMessageToWebview({
                        command: 'statusUpdate',
                        text: `📝 AI updated ARCHITECTURE.md to save context.`
                    });
                    return "Successfully updated ARCHITECTURE.md. Memory saved.";
                } else if (functionCall.name === 'search_codebase') {
                    if (!this.ragEngine) return "Search engine not initialized.";
                    const query = functionCall.args?.query || '';
                    this.postMessageToWebview({
                        command: 'toolCallEvent',
                        tool: 'search_codebase',
                        title: 'Searching Codebase',
                        data: { query: query }
                    });
                    
                    let results;
                    const ragCacheKey = workspaceRoot ? generateCacheKey('rag_search_tool', [], query) : null;
                    const rawCache = ragCacheKey ? checkCache(workspaceRoot!, ragCacheKey) : null;
                    
                    if (rawCache) {
                        try { results = JSON.parse(rawCache); } catch(e) {}
                    }
                    
                    if (results) {
                        this.postMessageToWebview({ command: 'statusUpdate', text: `⚡ RAG Cache Hit for tool search!` });
                    } else {
                        results = await this.ragEngine.search(query, 3);
                        if (ragCacheKey && results && results.length > 0) {
                            saveCache(workspaceRoot!, ragCacheKey, JSON.stringify(results));
                        }
                    }

                    if (!results || results.length === 0) return "No matches found.";
                    return results.map((r: any) => `File: ${r.filepath}\n\n${r.content}`).join('\n\n---\n\n');
                } else if (functionCall.name === 'find_references') {
                    if (!workspaceRoot) return "Error: No workspace.";
                    const sym = functionCall.args?.symbolName;
                    try {
                                const symbols: vscode.SymbolInformation[] | undefined = await Promise.race([
                                    Promise.resolve(vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', sym)),
                                    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2000))
                                ]);
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
                    
                    const safeCheck = resolveSafeWorkspacePath(filepath, workspaceRoot, false);
                    if (!safeCheck.safe) return safeCheck.error || `Invalid path: ${filepath}`;
                    const fullPath = safeCheck.resolvedPath;
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
                } else if (functionCall.name === 'generate_ui_blueprint') {
                    this.postMessageToWebview({ command: 'statusUpdate', text: `🎨 Generating Brand DNA & UI Blueprint...` });
                    try {
                        const args = functionCall.args as DesignSemantics;
                        const dna = extractBrandDNA(args);
                        const assets = orchestrateAssets(args);
                        
                        const result = `
### BRAND DNA EXTRACTED LOCALLY
Use these exact variables, colors, fonts, and assets in your code. DO NOT invent new colors or use broken image links.

**CSS Variables (Inject into your styles):**
${dna.cssVars}

**Inline Logo SVG:**
${dna.logoSVG}

**Pre-Orchestrated Assets (Use these exact URLs in your <img> tags):**
${JSON.stringify(assets, null, 2)}

**Spacing Strategy:** ${dna.spacing},
**Border Radius:** ${dna.borderRadius}
`;
                        return result;
                    } catch (e: any) { return `Blueprint Generation Error: ${e.message}`; }
                } else if (functionCall.name === 'search_web') {
                    const query = functionCall.args?.query;
                    if (!query) return "Error: No query provided.";
                    this.postMessageToWebview({ command: 'statusUpdate', text: `🌐 AI Web Search: ${query}` });
                    try {
                        const { searchWeb } = require('../tools/scraper');
                        const results = await searchWeb(query);
                        const urls: string[] = [];
                        const urlMatches = results.matchAll(/\[Source \d+\] (http[^\n]+)/g);
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
                        return results;
                    } catch (e: any) {
                        return `Web Search Error: ${e.message}`;
                    }

                } else if (functionCall.name === 'execute_terminal_command') {
                    const cmd = functionCall.args?.command;
                    const explanation = functionCall.args?.explanation || 'AI requested terminal execution';
                    this.postMessageToWebview({
                        command: 'toolCallEvent',
                        tool: 'execute_terminal_command',
                        title: 'Terminal Command Requested',
                        data: { command: cmd, explanation: explanation }
                    });
                    return `Command '${cmd}' has been displayed to the user in the UI for review and execution.`;
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
                    this.currentStreamAbortController?.signal,
                    filteredTools,
                    onToolCall
                );
            }

            this.currentStreamAbortController = null;

            if (!result) return; // Guard for clients not implementing completeWithHistory completely


            // Strip <think> tags robustly before saving to history to prevent context pollution
            const cleanResponseText = result.text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/<\/think>/gi, '');
            this.conversationHistory.addMessage('model', cleanResponseText, result.usage);

            // Job 2: Session Summarizer (Micro-Task)
            if (message.advancedMode && workspaceRoot) {
                const config = getAgentConfig(workspaceRoot);
                const supportBrain = config?.supportBrain;
                if (supportBrain && supportBrain.model) {
                    (async () => {
                        try {
                            const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');
                            let scoutClient;
                            if (supportBrain.providerType === 'local') {
                                scoutClient = new LocalOllamaClient(supportBrain.model || 'llama-3.1-8b-instant', supportBrain.endpoint || 'http://127.0.0.1:11434', supportBrain.apiKey);
                            } else {
                                const keyStr = supportBrain.apiKey?.trim() || '';
                                if (keyStr.startsWith('gsk_')) scoutClient = new LocalOllamaClient(supportBrain.model, 'https://api.groq.com/openai', keyStr);
                                else if (keyStr.startsWith('sk-') || keyStr.startsWith('sk-proj-')) scoutClient = new LocalOllamaClient(supportBrain.model, 'https://api.openai.com', keyStr);
                                else scoutClient = new GeminiCloudClient([keyStr], supportBrain.model || 'gemini-1.5-flash', 60);
                            }
                            const summaryPrompt = `Summarize this AI coding response in exactly 1 sentence (max 20 words). Focus on: what file was changed, what was added/fixed.\n\nResponse:\n${cleanResponseText.substring(0, 1000)}`;
                            const summaryResult = await scoutClient.complete(summaryPrompt);
                            SessionMemory.recordDecision(workspaceRoot, summaryResult.text.trim());
                        } catch (e) {
                            console.error("Scout Summarizer failed", e);
                        }
                    })();
                }
            }

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
     * Builds the final user prompt with context injection (@search, @file, @workspace, active file).
     */
    private async buildPrompt(text: string, includeActiveFile: boolean, includeWebSearch: boolean, includeWorkspace: boolean, workspaceRoot?: string): Promise<string> {
        let finalPrompt = text;
        let contextSources: ContextSource[] = [];

        // Error Diagnosis Engine
        if (workspaceRoot) {
            const errorTextToAnalyze = finalPrompt + '\n' + TerminalCapture.getLastOutput();
            const errorContexts = ErrorDiagnoser.extractErrors(errorTextToAnalyze, workspaceRoot);
            
            if (errorContexts.length > 0) {
                let diagStr = '### ERROR DIAGNOSTICS (Source Snippets) ###\n';
                for (const ctx of errorContexts) {
                    diagStr += `\n${ctx.codeSnippet}\n`;
                }
                contextSources.push({ name: 'Error Diagnostics', content: diagStr, priority: 9 });
                
                this.postMessageToWebview({
                    command: 'statusUpdate',
                    text: `🐛 Error Diagnoser: Auto-extracted ${errorContexts.length} source file context(s).`
                });
            }
        }

        // Handle @terminal mention — inject last captured terminal output
        if (text.toLowerCase().includes('@terminal')) {
            const termOutput = TerminalCapture.getLastOutput();
            if (termOutput) {
                contextSources.push({ name: 'Last Terminal Output', content: termOutput, priority: 8 });
                this.postMessageToWebview({ command: 'statusUpdate', text: `🖥️ Injected @terminal output.` });
            } else {
                this.postMessageToWebview({ command: 'statusUpdate', text: `🖥️ @terminal requested, but no active terminal output recorded yet.` });
            }
            finalPrompt = finalPrompt.replace(/@terminal/gi, '').trim();
        }

        // Handle @git mention — inject uncommitted git diffs
        if (text.toLowerCase().includes('@git') && workspaceRoot) {
            try {
                const { execSync } = require('child_process');
                const gitDiff = execSync('git diff HEAD', { cwd: workspaceRoot, encoding: 'utf8', timeout: 5000 });
                if (gitDiff && gitDiff.trim()) {
                    contextSources.push({ name: 'Uncommitted Git Diff', content: `\`\`\`diff\n${gitDiff.slice(0, 4000)}\n\`\`\``, priority: 8 });
                    this.postMessageToWebview({ command: 'statusUpdate', text: `🌿 Injected @git diff context.` });
                } else {
                    this.postMessageToWebview({ command: 'statusUpdate', text: `🌿 @git: Workspace clean, no uncommitted diffs found.` });
                }
            } catch (e) {
                this.postMessageToWebview({ command: 'statusUpdate', text: `🌿 @git: Unable to run git diff or git not initialized.` });
            }
            finalPrompt = finalPrompt.replace(/@git/gi, '').trim();
        }

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
                
                if (!fs.existsSync(resolvedPath)) continue;

                const content = fs.readFileSync(resolvedPath, 'utf8');
                const ext = path.extname(resolvedPath).slice(1) || 'text';
                let fileContentForContext = content;
                const tokenCount = estimateTokens(content);

                if (tokenCount > 1500) { // Skeletonize large files
                    this.postMessageToWebview({ command: 'statusUpdate', text: `🦴 Skeletonizing ${filePath}...` });
                    try {
                        fileContentForContext = await skeletonizeFile(vscode.Uri.file(resolvedPath));
                    } catch (e) {
                        console.error(`Skeletonization failed for ${filePath}`, e);
                        fileContentForContext = truncateToTokens(content, 1500);
                    }
                }

                contextSources.push({ name: `File: ${filePath}`, content: `\`\`\`${ext}\n${fileContentForContext}\n\`\`\``, priority: 10 });
                this.postMessageToWebview({ command: 'statusUpdate', text: `📄 Loaded file: ${filePath}` });

            } catch (e) { console.error(`Error processing @file ${filePath}:`, e); }
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
                    const userIgnoreFolders = vscode.workspace.getConfiguration('ultraLightAI').get<string[]>('ignoreFolders') || [];
                    const combinedIgnores = Array.from(new Set([...userIgnoreFolders, 'node_modules', '.git', 'dist', 'out', 'build', '.next', '.vscode', '.venv', 'venv', 'coverage', '__pycache__']));
                    const excludePattern = `{${combinedIgnores.map(f => `**/${f}/**`).join(',')},**/*.lock}`;
                    const files = await vscode.workspace.findFiles(
                        '**/*',
                        excludePattern
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

        // Auto-RAG Trigger: Always inject top 2-3 snippets if it's a substantive query, unless heavily explicit context is already given
        const isExplicitRag = text.toLowerCase().includes('@rag') || text.toLowerCase().includes('@smart');
        const wantsRag = isExplicitRag || (!hasFileMatch && !wantsWorkspace && text.length > 15 && this.ragEngine);
        
        if (wantsRag && this.ragEngine) {
            try {
                if (isExplicitRag) {
                    this.postMessageToWebview({
                        command: 'statusUpdate',
                        text: `🧠 Semantic Search: Analyzing codebase...`
                    });
                }
                
                let ragResults;
                const ragCacheKey = workspaceRoot ? generateCacheKey('rag_search_manual', [], text) : null;
                const rawCache = ragCacheKey ? checkCache(workspaceRoot!, ragCacheKey) : null;
                
                if (rawCache) {
                    try { ragResults = JSON.parse(rawCache); } catch(e) {}
                }
                
                if (ragResults && isExplicitRag) {
                    this.postMessageToWebview({ command: 'statusUpdate', text: `⚡ RAG Cache Hit: Instant offline search!` });
                } else if (!ragResults) {
                    ragResults = await this.ragEngine.search(text, isExplicitRag ? 3 : 2);
                    if (ragCacheKey && ragResults && ragResults.length > 0) {
                        saveCache(workspaceRoot!, ragCacheKey, JSON.stringify(ragResults));
                    }
                }

                if (ragResults && ragResults.length > 0) {
                    contextSources.push({ name: 'Semantic Codebase Context (Auto-RAG)', content: ragResults.map((r: any) => `File: ${r.filepath}\n\`\`\`\n${r.content}\n\`\`\``).join('\n\n'), priority: 7 });
                    if (isExplicitRag) {
                        this.postMessageToWebview({
                            command: 'statusUpdate',
                            text: `🧠 Semantic Search: Loaded ${ragResults.length} relevant files.`
                        });
                    } else {
                        // Silent or subtle status for auto-RAG
                        this.postMessageToWebview({
                            command: 'statusUpdate',
                            text: `🧠 Auto-RAG injected ${ragResults.length} background context snippets.`
                        });
                    }
                }
            } catch (err: any) {
                console.error("RAG search failed", err);
            }
            finalPrompt = finalPrompt.replace(/@rag|@smart/gi, '').trim();
        }

        // LSP Symbol Resolution for True Codebase Context
        if (workspaceRoot && text.length > 5) {
            try {
                // Use ContextSelector to only resolve symbols that are explicitly mentioned
                const mentions = ContextSelector.extractExplicitMentions(text);
                const potentialSymbols = mentions.symbols;

                if (potentialSymbols.length > 0) {
                    for (const sym of potentialSymbols) {
                        try {
                                    // Wrap in a strict 2-second timeout to prevent Extension Host lockups on large repos
                                    const symbols: vscode.SymbolInformation[] | undefined = await Promise.race([
                                        Promise.resolve(vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', sym)),
                                        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2000))
                                    ]);
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

        // Active file context injection using ContextSelector
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const doc = editor.document;
            const fileName = path.basename(doc.fileName);
            const langId = doc.languageId;
            const fileContent = doc.getText();
            
            // BUG-14 FIX: Skip non-code files to avoid wasting token budget
            const skipLanguages = ['plaintext', 'log', 'binary', 'json', 'xml', 'csv', 'svg', 'markdown'];
            const skipExtensions = ['.lock', '.min.js', '.min.css', '.map', '.env'];
            const ext = path.extname(doc.fileName).toLowerCase();
            const isCodeFile = !skipLanguages.includes(langId) && !skipExtensions.some(e => ext === e);
            
            if (isCodeFile && ContextSelector.shouldInjectActiveFile(text, fileName, fileContent)) {
                const selection = editor.selection;
                
                if (!selection.isEmpty) {
                    // Include just the selection
                    const selectedText = doc.getText(selection);
                    contextSources.push({ name: `Selected code from ${fileName}`, content: `\`\`\`${langId}\n${selectedText}\n\`\`\``, priority: 9 });
                } else {
                    // Include the full file (truncated if too large)
                    let fileContentForContext = fileContent;
                    const tokenCount = estimateTokens(fileContentForContext);
                    if (tokenCount > 1500) {
                        this.postMessageToWebview({ command: 'statusUpdate', text: `🦴 Skeletonizing active file...` });
                        try {
                            fileContentForContext = await skeletonizeFile(doc.uri);
                        } catch (e) {
                            console.error(`Skeletonization failed for active file`, e);
                            fileContentForContext = truncateToTokens(fileContentForContext, 1500);
                        }
                    }
                    contextSources.push({ name: `Active file context: ${fileName}`, content: `\`\`\`${langId}\n${fileContentForContext}\n\`\`\``, priority: 5 });
                }
            }
            finalPrompt = finalPrompt.replace(/@active|@current/gi, '').trim();
        }
        const promptConfig = getAgentConfig(workspaceRoot);
        const maxContextTokens = promptConfig?.contextLimits?.maxContextTokens || 7000;
        
        // Assemble final prompt with context
        // Optimization for smaller models: Place Context BEFORE the User Request
        // Smaller models (3B-7B) suffer from 'lost in the middle' and attend strongest to the end of the prompt.
        if (contextSources.length > 0) {
            const userPromptTokens = estimateTokens(finalPrompt);
            // Dynamic token accounting
            const availableContextTokens = TokenAccountant.getRemainingBudget(
                maxContextTokens,
                this.conversationHistory.estimateTokens(),
                userPromptTokens
            );
            
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
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No active workspace folder to save configuration.');
            this.postMessageToWebview({
                command: 'settingsSaved',
                success: false,
                error: 'No active workspace folder'
            });
            return;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        
        await SettingsHandler.handleSaveSettings(
            message,
            workspaceRoot,
            (root) => this.getAiMetaDir(root),
            (msg) => this.postMessageToWebview(msg)
        );
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
                const safeCheck = resolveSafeWorkspacePath(filepath, workspaceRoot, true);
                if (!safeCheck.safe) {
                    throw new Error(safeCheck.error || `Security / Guard violation: '${filepath}' is outside workspace boundary.`);
                }
                const fullPath = safeCheck.resolvedPath;
                const fileUri = vscode.Uri.file(fullPath);

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
                                throw new Error(patchResult.error || `Could not find the specified search block in ${filepath}. Ensure the code exactly matches the file context.`);
                            }
                        }
                        // Removed old Scout Regex Fallback -> Replaced by Job 1 SEARCH Healer
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
                        
                        // FIX: Remove markdown wrapping for full file overwrites so actual files aren't corrupted
                        let cleanContent = content.trim();
                        const blockMatch = cleanContent.match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```$/);
                        if (blockMatch && blockMatch[1]) {
                            cleanContent = blockMatch[1].trim();
                        }
                        const val = DiffValidator.validateReplacementContent(cleanContent);
                        if (!val.valid) {
                            throw new Error(`Validation failed for ${filepath}: ${val.reason}`);
                        }
                        fileText = cleanContent;
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
            
            // Save snapshots for all modified files before applying the atomic edit
            for (const filepath of Object.keys(fileGroups)) {
                const safeCheck = resolveSafeWorkspacePath(filepath, workspaceRoot, false);
                const fullPath = safeCheck.safe ? safeCheck.resolvedPath : path.join(workspaceRoot, filepath);
                if (fs.existsSync(fullPath)) {
                    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
                    FileVersioning.saveSnapshot(workspaceRoot, fullPath, document.getText());
                }
            }
            
            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                throw new Error("VS Code failed to apply the workspace edits.");
            }

            // Patch Integrity Validator
            const profile = ProjectScanner.getProfile(workspaceRoot);
            if (profile && (profile.buildCommand || profile.testCommand)) {
                const cmdToRun = profile.testCommand || profile.buildCommand;
                if (cmdToRun) {
                    this.postMessageToWebview({
                        command: 'statusUpdate',
                        text: `🔍 Validating patch integrity: Running \`${cmdToRun}\`...`
                    });

                    try {
                        const output = await TerminalCapture.runAndCapture(cmdToRun, workspaceRoot);
                        if (output.includes('Exit Code:') && !output.includes('Exit Code: 0')) {
                            // Build failed! Auto-Rollback
                            vscode.window.showErrorMessage(`Build failed after patch. Rolling back and notifying AI.`);
                            
                            for (const filepath of Object.keys(fileGroups)) {
                                const fullPath = path.join(workspaceRoot, filepath);
                                const content = FileVersioning.getLatestSnapshot(workspaceRoot, fullPath);
                                if (content) {
                                    fs.writeFileSync(fullPath, content, 'utf8');
                                }
                            }

                            this.postMessageToWebview({
                                command: 'injectChatAndSend',
                                text: `The code you applied broke the build/tests. I have automatically rolled it back. Here is the error:\n<terminal_output>\n${output}\n</terminal_output>\nPlease fix the issue.`
                            });
                            return; // Halt further processing
                        } else {
                            vscode.window.showInformationMessage(`✅ Build/Tests passed after patch!`);
                        }
                    } catch (e) {
                        console.error('Integrity check failed', e);
                    }
                }
            }
            
            // Auto-update Session Memory for every applied file (fixes long-chat amnesia)
            for (const filepath of createdFiles) {
                const fullPath = path.join(workspaceRoot, filepath);
                if (fs.existsSync(fullPath)) {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    SessionMemory.recordFileApplied(workspaceRoot, filepath, content);
                }
            }

            // Auto-update Architecture.md (backend-driven, no AI needed)
            const archPath = path.join(workspaceRoot, '.ultra-light-ai', 'ARCHITECTURE.md');
            const archLines: string[] = [];
            for (const filepath of createdFiles) {
                const fullPath = path.join(workspaceRoot, filepath);
                const lineCount = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8').split('\n').length : 0;
                const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
                archLines.push(`- \`${filepath}\` — ${lineCount} lines (applied: ${ts})`);
            }
            if (archLines.length > 0) {
                const entry = `\n## Applied ${new Date().toLocaleDateString()}\n${archLines.join('\n')}\n`;
                fs.appendFileSync(archPath, entry, 'utf8');
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
            // Open Global Config
            const os = require('os');
            const globalConfigPath = path.join(os.homedir(), '.ultra-light-ai', 'config.json');
            if (fs.existsSync(globalConfigPath)) {
                vscode.workspace.openTextDocument(globalConfigPath).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
            } else {
                vscode.window.showErrorMessage('Global Agent configuration file does not exist yet. Please save settings from the UI first.');
            }
        }
    }

    /**
     * Clear local cache
     */
    private handleClearCache(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const aiMetaDir = this.getAiMetaDir(workspaceRoot);
            const cachePath = path.join(aiMetaDir, 'cache.json');
            const ragCachePath = path.join(aiMetaDir, 'rag-index.json');
            
            if (fs.existsSync(ragCachePath)) {
                try { fs.unlinkSync(ragCachePath); } catch (e) { /* ignore */ }
            }
            
            if (fs.existsSync(cachePath)) { // Check for new path
                try {
                    fs.unlinkSync(cachePath);
                    vscode.window.showInformationMessage('🗑️ Cache cleared successfully!');
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to clear cache: ${e.message}`);
                }
            } else {
                // Also check for old path and clear it
                const oldCachePath = path.join(workspaceRoot, '.vscode', 'ultra-light-ai-cache.json');
                if (fs.existsSync(oldCachePath)) {
                    try {
                        fs.unlinkSync(oldCachePath);
                        vscode.window.showInformationMessage('🗑️ Cache cleared successfully!');
                        return;
                    } catch (e) { /* ignore */ }
                }
                vscode.window.showInformationMessage('Cache is already empty.');
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

        const scaffoldPatterns = [
            /npx\s+create-/i, /npm\s+init/i, /yarn\s+create/i, /pnpm\s+create/i,
            /django-admin\s+startproject/i, /vue\s+create/i, /ng\s+new/i, /composer\s+create-project/i,
            /rails\s+new/i, /cargo\s+new/i, /dotnet\s+new/i, /npx\s+vite/i
        ];
        
        const isScaffold = scaffoldPatterns.some(pattern => pattern.test(command));

        if (isScaffold) {
            this.postMessageToWebview({
                command: 'streamChunk',
                text: `\n\n> 🏗️ **PROJECT SCAFFOLD DETECTED**\n> The AI has prepared a setup command:\n> \`\`\`bash\n> ${command}\n> \`\`\`\n> *⚠️ Command placed in terminal. Press Enter in terminal to execute it. Once it finishes, reply "done" to let the AI continue coding.*`,
                done: false
            });
            vscode.window.showWarningMessage('🏗️ Scaffold Command Detected. Please run it in the terminal, wait for it to finish, and then reply to AI.');
        } else {
            // Action Block UI Interceptor added
            this.postMessageToWebview({
                command: 'streamChunk',
                text: `\n\n> 🤖 **AI Wants to Execute:**\n> \`\`\`bash\n> ${command}\n> \`\`\`\n> *Command placed in terminal. Review and press Enter to execute.*`,
                done: false
            });
        }
        
        let terminal = vscode.window.terminals.find(t => t.name === 'Ultra Light AI');
        if (!terminal) {
            terminal = vscode.window.createTerminal('Ultra Light AI');
        }
        terminal.show();
        // Set addNewLine to false so the user can edit the command before hitting enter
        // BUG FIX: Join multiline commands with '&&' so they don't break when stripped of newlines
        const safeCommand = command.trim().split(/\r?\n/).filter(line => line.trim().length > 0).join(' && ');
        terminal.sendText(safeCommand, false);
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
