import * as vscode from 'vscode';
import * as path from 'path';

export class SmartSearch {
    public static activate(context: vscode.ExtensionContext, getRagEngine: () => any) {
        context.subscriptions.push(
            vscode.commands.registerCommand('ultra-light-ai.smartSearch', async () => {
                const ragEngine = getRagEngine();
                if (!ragEngine) {
                    vscode.window.showErrorMessage('Ultra Light AI: RAG Engine is not initialized yet.');
                    return;
                }

                const query = await vscode.window.showInputBox({
                    prompt: 'What logic are you looking for?',
                    placeHolder: 'e.g. "Where do we calculate cart totals?" or "User authentication"',
                    ignoreFocusOut: true
                });

                if (!query) return;

                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Searching codebase semantically...",
                    cancellable: false
                }, async () => {
                    const chunks = ragEngine.search(query, 10);
                    if (!chunks || chunks.length === 0) {
                        vscode.window.showInformationMessage('No matching code found for your query.');
                        return;
                    }

                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

                    interface SmartSearchQuickPickItem extends vscode.QuickPickItem {
                        chunk: any;
                    }

                    const quickPickItems: SmartSearchQuickPickItem[] = chunks.map((chunk: any) => {
                        const relativePath = path.relative(workspaceRoot, chunk.filepath);
                        return {
                            label: `$(symbol-${chunk.type === 'function' ? 'method' : chunk.type === 'class' ? 'class' : 'file'}) ${chunk.name || 'Block'}`,
                            description: `${relativePath}:${chunk.startLine}`,
                            detail: chunk.content.split('\n')[0].trim().substring(0, 80) + '...',
                            chunk: chunk
                        };
                    });

                    const selected = await vscode.window.showQuickPick<SmartSearchQuickPickItem>(quickPickItems, {
                        placeHolder: 'Select a result to jump to the code',
                        matchOnDescription: true,
                        matchOnDetail: true
                    });

                    if (selected && selected.chunk) {
                        const uri = vscode.Uri.file(selected.chunk.filepath);
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const editor = await vscode.window.showTextDocument(doc);
                        
                        // Jump to the exact line
                        const startLine = Math.max(0, selected.chunk.startLine - 1);
                        const endLine = Math.max(0, selected.chunk.endLine - 1);
                        const range = new vscode.Range(startLine, 0, endLine, 0);
                        
                        editor.selection = new vscode.Selection(startLine, 0, startLine, 0);
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    }
                });
            })
        );
    }
}
