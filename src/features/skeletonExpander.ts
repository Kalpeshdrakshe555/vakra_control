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

                const { createConfiguredClient } = require('../router/realClients');
                
                let client: any;
                try {
                    const clientResult = createConfiguredClient(config, {
                        model,
                        timeoutSeconds: timeout,
                        keys
                    });
                    client = clientResult.client;
                } catch {
                    client = null;
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
