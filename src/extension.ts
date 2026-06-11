import * as vscode from 'vscode';
import * as path from 'path';
import { StateMachine } from './state/stateMachine';
import { EngineRouter } from './router/engineRouter';
import { SequentialOperator } from './operations/sequentialLoop';
import { GeminiCloudClient } from './router/realClients';
import { CloudClient as DummyCloudClient } from './router/dummyClients';
import { SidebarProvider } from './webview/sidebarProvider';
import { IEngine } from './router/IEngine';
import { InlineCompletionProvider } from './providers/inlineCompletionProvider';
import { AiCodeActionProvider, registerCodeActionCommands } from './providers/codeActionProvider';
import { AiHoverProvider } from './providers/hoverProvider';
import { ensureAgentConfig, getGeminiApiKeys, getGeminiModel, getGeminiTimeout } from './config';
import { RagEngine } from './rag/ragEngine';
import { BackgroundIndexer } from './indexer/backgroundIndexer';

// Global reference for the RAG engine
export let globalRagEngine: RagEngine | null = null;
export let globalBackgroundIndexer: BackgroundIndexer | null = null;

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Ultra Light AI');
    outputChannel.appendLine('Activating "ultra-light-ai" extension...');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        outputChannel.appendLine('Error: No active workspace folder open. Extension activation aborted.');
        return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    // Generate `.agent-config.json` template if it doesn't exist
    ensureAgentConfig(workspaceRoot);

    // Instantiate State Machine
    const stateMachine = new StateMachine(workspaceRoot);

    const keys = getGeminiApiKeys(workspaceRoot, context.extensionUri.fsPath);
    const model = getGeminiModel(workspaceRoot);
    const timeout = getGeminiTimeout(workspaceRoot);

    // Instantiate Real API Client
    const geminiClient = new GeminiCloudClient(keys, model, timeout);

    // Instantiate default fallback engine router
    const defaultRouter = new EngineRouter([geminiClient], stateMachine);

    // Initialize RAG Engine
    globalRagEngine = new RagEngine(workspaceRoot);
    
    // BUG FIX: Run in background with a slight delay to prevent Extension Host from hanging on large projects
    setTimeout(() => {
        globalRagEngine?.buildIndex().catch(err => outputChannel.appendLine(`RAG Indexing Error: ${err}`));
    }, 5000); 

    // Setup file watcher for RAG
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,js,py,java,go,rs,tsx,jsx,css,json,html,md}');
    watcher.onDidChange(uri => globalRagEngine?.updateFile(uri.fsPath));
    watcher.onDidCreate(uri => globalRagEngine?.updateFile(uri.fsPath));
    watcher.onDidDelete(uri => globalRagEngine?.updateFile(uri.fsPath));

    // Initialize Background AST Indexer
    globalBackgroundIndexer = new BackgroundIndexer(workspaceRoot);
    globalBackgroundIndexer.initialize();
    
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.uri.scheme === 'file') {
                globalBackgroundIndexer?.onFileChanged(document.uri.fsPath);
            }
        })
    );

    // ──────────────────────────────────────────────────────────────────────
    // STATUS BAR ITEM
    // ──────────────────────────────────────────────────────────────────────
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(sparkle) Ultra Light AI';
    statusBarItem.tooltip = `Active Model: ${model}`;
    statusBarItem.command = 'ultra-light-ai.openSidebar';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // ──────────────────────────────────────────────────────────────────────
    // SIDEBAR PROVIDER
    // ──────────────────────────────────────────────────────────────────────
    const sidebarProvider = new SidebarProvider(context.extensionUri, workspaceRoot, globalRagEngine);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ultra-light-ai-sidebar', sidebarProvider)
    );

    // ──────────────────────────────────────────────────────────────────────
    // INLINE COMPLETION PROVIDER (Copilot-style ghost text)
    // ──────────────────────────────────────────────────────────────────────
    const inlineProvider = new InlineCompletionProvider(outputChannel);
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },
            inlineProvider
        )
    );
    outputChannel.appendLine('Registered InlineCompletionItemProvider for all file types.');

    // ──────────────────────────────────────────────────────────────────────
    // CODE ACTION PROVIDER (AI Quick Fix, Refactor, Explain, Docs)
    // ──────────────────────────────────────────────────────────────────────
    const codeActionProvider = new AiCodeActionProvider(outputChannel);
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { pattern: '**' },
            codeActionProvider,
            { providedCodeActionKinds: AiCodeActionProvider.providedCodeActionKinds }
        )
    );
    registerCodeActionCommands(context, outputChannel, (msg) => {
        sidebarProvider.postMessageToWebview(msg);
    });
    outputChannel.appendLine('Registered CodeActionProvider with AI Quick Fix, Refactor, Explain, and Docs commands.');

    // ──────────────────────────────────────────────────────────────────────
    // HOVER PROVIDER (AI explanations on hover)
    // ──────────────────────────────────────────────────────────────────────
    const hoverProvider = new AiHoverProvider(outputChannel);
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { pattern: '**' },
            hoverProvider
        )
    );
    outputChannel.appendLine('Registered HoverProvider for AI explanations.');

    // ──────────────────────────────────────────────────────────────────────
    // COMMANDS
    // ──────────────────────────────────────────────────────────────────────
    
    // Command: Start Processing (file queue) removed as part of cleanup

    // Command: Open Sidebar
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.openSidebar', async () => {
            await vscode.commands.executeCommand('ultra-light-ai-sidebar.focus');
        })
    );

    // Command: New Chat
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.newChat', async () => {
            sidebarProvider.clearChat();
        })
    );

    // Command: Quick Model Switch
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.switchModel', async () => {
            const models = [
                { label: 'gemma-4-31b-it', description: 'Open model (Default)' },
                { label: 'gemini-2.5-pro', description: 'Most capable' },
                { label: 'gemini-2.0-flash', description: 'Balanced speed' },
                { label: 'gemini-1.5-pro', description: 'Legacy capable' },
            ];
            const selected = await vscode.window.showQuickPick(models, {
                placeHolder: 'Select AI Model',
                title: 'Ultra Light AI — Switch Model'
            });
            if (selected) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    const workspaceRoot = workspaceFolders[0].uri.fsPath;
                    const configPath = path.join(workspaceRoot, '.agent-config.json');
                    if (fs.existsSync(configPath)) {
                        try {
                            const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                            if (configData.providers?.cloud) {
                                configData.providers.cloud.model = selected.label;
                                fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');
                            }
                        } catch (err) {
                            console.error('Failed to update config file', err);
                        }
                    }
                }
                sidebarProvider.postMessageToWebview({
                    command: 'modelSwitched',
                    model: selected.label
                });
                statusBarItem.tooltip = `Active Model: ${selected.label}`;
                vscode.window.showInformationMessage(`Model switched to ${selected.label}`);
            }
        })
    );

    // Command: Ctrl+K Inline Edit
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.inlineEdit', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage("Open a file to use Inline Edit.");
                return;
            }

            const selection = editor.selection;
            if (selection.isEmpty) {
                vscode.window.showInformationMessage("Please select the code you want to edit first.");
                return;
            }

            const prompt = await vscode.window.showInputBox({
                placeHolder: 'e.g. "make this async", "refactor to use map"',
                prompt: 'Ultra Light AI: Inline Edit (Ctrl+K)'
            });

            if (!prompt) return;
            
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Ultra Light AI",
                cancellable: false
            }, async (progress) => {
                progress.report({ message: "Generating inline edit..." });
                
                try {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    const wsRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;
                    
                    const currentKeys = getGeminiApiKeys(wsRoot, context.extensionUri.fsPath);
                    const currentModel = getGeminiModel(wsRoot);
                    const currentTimeout = getGeminiTimeout(wsRoot);
                    const activeGeminiClient = new GeminiCloudClient(currentKeys, currentModel, currentTimeout);
                    
                    const selectedText = editor.document.getText(selection);
                    
                    const fullPrompt = `You are a strict inline code editor. The user wants to apply the following edit instruction to the provided code block.
Instruction: ${prompt}

Code Block:
\`\`\`
${selectedText}
\`\`\`

IMPORTANT: Return ONLY the raw modified code block. Do not include markdown code block syntax (like \`\`\`), do not include explanations, do not include before/after text. Just the exact replacement code that can be dropped directly over the selected text. Preserve relative indentation.`;

                    const response = await activeGeminiClient.complete(fullPrompt);
                    let replacementText = response.text.trim();
                    
                    if (replacementText.startsWith('\`\`\`')) {
                        const lines = replacementText.split('\n');
                        if (lines.length >= 2) {
                            lines.shift(); 
                            if (lines[lines.length - 1].startsWith('\`\`\`')) {
                                lines.pop(); 
                            }
                            replacementText = lines.join('\n');
                        }
                    }
                    
                    const success = await editor.edit(editBuilder => {
                        editBuilder.replace(selection, replacementText);
                    });
                    
                    if (success) {
                        vscode.window.showInformationMessage('✨ Inline edit applied. (Press Ctrl+Z to undo if incorrect).');
                    } else {
                        vscode.window.showErrorMessage('Failed to apply inline edit.');
                    }
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Inline edit failed: ${err.message || err}`);
                }
            });
        })
    );

    // Command: Inline Chat (explain selection in notification)
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.inlineChat', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty) {
                vscode.window.showWarningMessage('Select some code first, then run Ultra Light AI: Inline Chat.');
                return;
            }
            
            const selectedText = editor.document.getText(editor.selection);
            const lang = editor.document.languageId;
            
            // Focus the sidebar and inject the prompt
            await vscode.commands.executeCommand('ultra-light-ai-sidebar.focus');
            sidebarProvider.postMessageToWebview({
                command: 'injectChat',
                text: `Explain this ${lang} code:\n\`\`\`${lang}\n${selectedText}\n\`\`\``
            });
        })
    );

    // Command: Add Active File to Context
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.addFileContext', async () => {
            await vscode.commands.executeCommand('ultra-light-ai-sidebar.focus');
            sidebarProvider.postMessageToWebview({
                command: 'toggleFileContext',
                active: true,
                fileName: vscode.window.activeTextEditor 
                    ? path.basename(vscode.window.activeTextEditor.document.fileName)
                    : 'none'
            });
        })
    );

    // Command: Fix Terminal Error
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.fixTerminalError', async () => {
            const terminal = vscode.window.activeTerminal;
            if (!terminal) {
                vscode.window.showErrorMessage('No active terminal found.');
                return;
            }
            
            try {
                // Hack to copy terminal content natively
                await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
                await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
                await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
                
                // Small delay to let the async clipboard write happen
                await new Promise(resolve => setTimeout(resolve, 300));
                
                const clipboardText = await vscode.env.clipboard.readText();
                if (clipboardText) {
                    await vscode.commands.executeCommand('ultra-light-ai-sidebar.focus');
                    
                    const lines = clipboardText.split('\n');
                    const lastLines = lines.slice(-60).join('\n').trim();
                    
                    const prompt = `I got an error in my terminal. Please help me fix it:\n\n\`\`\`\n${lastLines}\n\`\`\``;
                    
                    sidebarProvider.postMessageToWebview({
                        command: 'injectChatAndSend',
                        text: prompt
                    });
                } else {
                    vscode.window.showErrorMessage('Could not read terminal output.');
                }
            } catch (err) {
                vscode.window.showErrorMessage('Failed to capture terminal output.');
            }
        })
    );

    outputChannel.appendLine('"ultra-light-ai" extension activated successfully with all Copilot features.');
}

export function deactivate() {}
