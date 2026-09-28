import * as vscode from 'vscode';
import { getAgentConfig } from '../config';
import { getGeminiApiKeys, getGeminiModel, getGeminiTimeout } from '../config';

export class SkeletonExpander {
    public static activate(context: vscode.ExtensionContext) {
        context.subscriptions.push(
            vscode.commands.registerCommand('ultra-light-ai.skeletonExpand', async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showInformationMessage('No active editor.');
                    return;
                }

                const document = editor.document;
                const selection = editor.selection;

                // If nothing is selected, we try to expand the current line, or the surrounding block
                let rangeToExpand: vscode.Range = selection;
                if (selection.isEmpty) {
                    // Try to find the start and end of the block based on indentation
                    const curLine = document.lineAt(selection.active.line);
                    rangeToExpand = new vscode.Range(curLine.range.start, curLine.range.end);
                }

                const codeToExpand = document.getText(rangeToExpand).trim();
                if (!codeToExpand) return;

                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspaceRoot) return;

                const config = getAgentConfig(workspaceRoot);
                const keys = getGeminiApiKeys(workspaceRoot, context.extensionUri.fsPath);
                const model = getGeminiModel(workspaceRoot);
                const timeout = getGeminiTimeout(workspaceRoot);

                const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');
                
                let client;
                const mainBrain = config?.mainBrain;
                if (mainBrain) {
                    if (mainBrain.providerType === 'local') {
                        client = new LocalOllamaClient(mainBrain.model || 'llama3', mainBrain.endpoint || 'http://127.0.0.1:11434', mainBrain.apiKey);
                    } else {
                        const keyStr = mainBrain.apiKey?.trim() || '';
                        if (keyStr.startsWith('gsk_')) client = new LocalOllamaClient(mainBrain.model, 'https://api.groq.com/openai', keyStr);
                        else if (keyStr.startsWith('sk-or-')) client = new LocalOllamaClient(mainBrain.model, 'https://openrouter.ai/api', keyStr);
                        else if (keyStr.startsWith('sk-') || keyStr.startsWith('sk-proj-')) client = new LocalOllamaClient(mainBrain.model, 'https://api.openai.com', keyStr);
                        else client = new GeminiCloudClient([keyStr], mainBrain.model || 'gemini-1.5-pro', timeout);
                    }
                } else if (config?.activeProvider === 'local') {
                    client = new LocalOllamaClient(config.providers?.local?.model || 'llama3', config.providers?.local?.endpoint || 'http://127.0.0.1:11434', keys[0]?.trim());
                } else {
                    const keyStr = keys[0]?.trim() || '';
                    if (keyStr.startsWith('gsk_')) client = new LocalOllamaClient(model, 'https://api.groq.com/openai', keyStr);
                    else if (keyStr.startsWith('sk-or-')) client = new LocalOllamaClient(model, 'https://openrouter.ai/api', keyStr);
                    else if (keyStr.startsWith('sk-') || keyStr.startsWith('sk-proj-')) client = new LocalOllamaClient(model, 'https://api.openai.com', keyStr);
                    else client = new GeminiCloudClient(keys, model, timeout);
                }

                if (!client) {
                    vscode.window.showErrorMessage('Ultra Light AI: API key not configured.');
                    return;
                }

                const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), rangeToExpand.start));
                const suffix = document.getText(new vscode.Range(rangeToExpand.end, new vscode.Position(document.lineCount, 0)));

                // Get only last 500 lines for context
                const prefixLines = prefix.split('\n').slice(-500).join('\n');

                const prompt = `You are an expert coder. Expand the following pseudo-code/comments into actual working code. 
Only output the code that REPLACES the pseudo-code. DO NOT output the prefix or suffix context. DO NOT wrap in markdown \`\`\` blocks unless it is absolutely necessary. Keep exactly the same indentation level as the pseudo-code.

--- CONTEXT PREFIX ---
${prefixLines}
--- END PREFIX ---

--- PSEUDO-CODE TO EXPAND ---
${codeToExpand}
--- END PSEUDO-CODE ---

Return only the raw expanded code that seamlessly replaces the pseudo-code.`;

                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Expanding code...",
                    cancellable: false
                }, async (progress) => {
                    try {
                        const response = await client.complete(prompt);
                        let expandedCode = response.text;
                        
                        // Clean markdown block
                        if (expandedCode.startsWith('\`\`\`')) {
                            expandedCode = expandedCode.replace(/^\`\`\`[a-zA-Z]*\r?\n/, '');
                            expandedCode = expandedCode.replace(/\r?\n\`\`\`$/, '');
                        }

                        await editor.edit(editBuilder => {
                            editBuilder.replace(rangeToExpand, expandedCode);
                        });
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`Skeleton Expansion failed: ${error.message}`);
                    }
                });
            })
        );
    }
}
