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

// Global reference for the RAG engine
export let globalRagEngine: RagEngine | null = null;

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

    // Instantiate Dummy/Mock API Client
    const dummyCloud = new DummyCloudClient();

    // Instantiate default fallback engine router & operator
    const defaultRouter = new EngineRouter([geminiClient], stateMachine);
    const defaultOperator = new SequentialOperator(stateMachine, defaultRouter);

    // Initialize RAG Engine
    globalRagEngine = new RagEngine(workspaceRoot);
    globalRagEngine.buildIndex();

    // Setup file watcher for RAG
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,js,py,java,go,rs,tsx,jsx,css,json,html,md}');
    watcher.onDidChange(uri => globalRagEngine?.updateFile(uri.fsPath));
    watcher.onDidCreate(uri => globalRagEngine?.updateFile(uri.fsPath));
    watcher.onDidDelete(uri => globalRagEngine?.updateFile(uri.fsPath));

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
    const sidebarProvider = new SidebarProvider(context.extensionUri, async (config) => {
        outputChannel.appendLine(`Start requested from Webview UI: ${JSON.stringify(config)}`);

        sidebarProvider.postMessageToWebview({
            command: 'statusUpdate',
            text: 'PROCESSING...'
        });

        let activeEngines: IEngine[] = [];
        if (config.model === 'demo-cascade') {
            activeEngines = [dummyCloud];
        } else {
            const currentKeys = getGeminiApiKeys(workspaceRoot, context.extensionUri.fsPath);
            const currentModel = getGeminiModel(workspaceRoot);
            const currentTimeout = getGeminiTimeout(workspaceRoot);
            activeEngines = [new GeminiCloudClient(currentKeys, currentModel, currentTimeout)];
        }

        const activeRouter = new EngineRouter(activeEngines, stateMachine);
        const activeOperator = new SequentialOperator(stateMachine, activeRouter, globalRagEngine);

        try {
            const state = stateMachine.readState();
            if (config.mode === 'single-file-edit') {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) {
                    throw new Error('No active file open in the editor. Open a file first.');
                }
                state.fileQueue = [activeEditor.document.uri.fsPath];
                state.currentFileIndex = 0;
                stateMachine.writeState(state);
                outputChannel.appendLine(`Single File Edit Mode: Added ${activeEditor.document.uri.fsPath} to queue.`);
            } else {
                if (!state.fileQueue || state.fileQueue.length === 0 || state.currentFileIndex >= state.fileQueue.length) {
                    outputChannel.appendLine('Scanning workspace for files to add to the queue...');
                    const files = await vscode.workspace.findFiles(
                        '**/*',
                        '{**/node_modules/**,**/dist/**,**/.git/**,**/.vscode/**,**/.ai_state.json,**/package-lock.json,**/package.json,**/tsconfig.json,**/esbuild.js,**/out/**}'
                    );
                    
                    if (files.length === 0) {
                        throw new Error('No files found in the workspace to process.');
                    }
                    
                    state.fileQueue = files.map(f => f.fsPath);
                    state.currentFileIndex = 0;
                    stateMachine.writeState(state);
                    outputChannel.appendLine(`Populated file queue with ${files.length} files.`);
                }
            }

            await activeOperator.runQueue(workspaceRoot, config.searchMode, (file, usage) => {
                const fileName = path.basename(file);
                outputChannel.appendLine(`Refactored ${fileName}. Tokens: prompt=${usage?.promptTokens || 0}, completion=${usage?.completionTokens || 0}, total=${usage?.totalTokens || 0}`);
                sidebarProvider.postMessageToWebview({
                    command: 'tokenUsage',
                    file: fileName,
                    usage: usage
                });
            });
            
            sidebarProvider.postMessageToWebview({
                command: 'statusUpdate',
                text: 'IDLE - Processing completed successfully.'
            });
            statusBarItem.text = '$(sparkle) Ultra Light AI';
            vscode.window.showInformationMessage('Ultra Light AI processing completed successfully.');
        } catch (error: any) {
            outputChannel.appendLine(`Queue processing failed: ${error?.message || error}`);
            
            sidebarProvider.postMessageToWebview({
                command: 'statusUpdate',
                text: `ERROR: ${error?.message || error}`
            });
            statusBarItem.text = '$(error) Ultra Light AI';
            vscode.window.showErrorMessage(`Ultra Light AI processing failed: ${error?.message || error}`);
        }
    }, async () => {
        // Reset action callback
        try {
            const state = stateMachine.readState();
            state.currentFileIndex = 0;
            state.fileQueue = [];
            state.status = 'IDLE';
            state.activeEngine = '';
            state.circuitBreakers = {};
            stateMachine.writeState(state);

            outputChannel.appendLine('State machine and circuit breakers reset.');
            sidebarProvider.postMessageToWebview({
                command: 'statusUpdate',
                text: 'IDLE - State reset successfully.'
            });
            statusBarItem.text = '$(sparkle) Ultra Light AI';
            vscode.window.showInformationMessage('Ultra Light AI state and circuit breakers reset.');
        } catch (error: any) {
            outputChannel.appendLine(`Failed to reset state: ${error?.message || error}`);
        }
    }, globalRagEngine);

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
    
    // Command: Start Processing (file queue)
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.startProcessing', async () => {
            outputChannel.appendLine('Command "ultra-light-ai.startProcessing" executed from Command Palette.');
            try {
                sidebarProvider.postMessageToWebview({
                    command: 'statusUpdate',
                    text: 'PROCESSING...'
                });
                statusBarItem.text = '$(loading~spin) Processing...';

                const state = stateMachine.readState();
                if (!state.fileQueue || state.fileQueue.length === 0 || state.currentFileIndex >= state.fileQueue.length) {
                    const files = await vscode.workspace.findFiles(
                        '**/*',
                        '**/node_modules/**,**/dist/**,**/.git/**,**/.vscode/**,**/.ai_state.json,**/package-lock.json,**/package.json,**/tsconfig.json,**/esbuild.js,**/out/**'
                    );
                    if (files.length > 0) {
                        state.fileQueue = files.map(f => f.fsPath);
                        state.currentFileIndex = 0;
                        stateMachine.writeState(state);
                    } else {
                        throw new Error('No files found in the workspace to process.');
                    }
                }

                const currentKeys = getGeminiApiKeys(workspaceRoot, context.extensionUri.fsPath);
                const currentModel = getGeminiModel(workspaceRoot);
                const currentTimeout = getGeminiTimeout(workspaceRoot);
                const activeGeminiClient = new GeminiCloudClient(currentKeys, currentModel, currentTimeout);
                const cmdRouter = new EngineRouter([activeGeminiClient], stateMachine);
                const cmdOperator = new SequentialOperator(stateMachine, cmdRouter);

                await cmdOperator.runQueue(workspaceRoot, undefined, (file, usage) => {
                    const fileName = path.basename(file);
                    outputChannel.appendLine(`Refactored ${fileName}. Tokens: prompt=${usage?.promptTokens || 0}, completion=${usage?.completionTokens || 0}, total=${usage?.totalTokens || 0}`);
                    sidebarProvider.postMessageToWebview({
                        command: 'tokenUsage',
                        file: fileName,
                        usage: usage
                    });
                });
                
                sidebarProvider.postMessageToWebview({
                    command: 'statusUpdate',
                    text: 'IDLE - Processing completed successfully.'
                });
                statusBarItem.text = '$(sparkle) Ultra Light AI';
                vscode.window.showInformationMessage('Ultra Light AI processing completed successfully.');
            } catch (error: any) {
                outputChannel.appendLine(`Queue processing failed: ${error?.message || error}`);
                sidebarProvider.postMessageToWebview({
                    command: 'statusUpdate',
                    text: `ERROR: ${error?.message || error}`
                });
                statusBarItem.text = '$(error) Ultra Light AI';
                vscode.window.showErrorMessage(`Ultra Light AI processing failed: ${error?.message || error}`);
            }
        })
    );

    // Command: Open Sidebar
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.openSidebar', async () => {
            await vscode.commands.executeCommand('ultra-light-ai-sidebar.focus');
        })
    );

    // Command: New Chat
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.newChat', async () => {
            sidebarProvider.postMessageToWebview({ command: 'chatCleared' });
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
