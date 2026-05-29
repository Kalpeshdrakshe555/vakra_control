import * as vscode from 'vscode';
import { GeminiCloudClient } from '../router/realClients';
import { getGeminiApiKeys, getGeminiModel, getGeminiTimeout } from '../config';

/**
 * CodeActionProvider — Provides AI-powered quick fixes for diagnostics,
 * plus "Explain", "Refactor", and "Generate Docs" actions on selected code.
 */
export class AiCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.Refactor,
    ];

    constructor(
        private readonly outputChannel: vscode.OutputChannel
    ) {}

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        // AI Quick Fix for each diagnostic in range
        for (const diagnostic of context.diagnostics) {
            const fix = new vscode.CodeAction(
                `⚡ AI Fix: ${diagnostic.message.substring(0, 60)}...`,
                vscode.CodeActionKind.QuickFix
            );
            fix.command = {
                command: 'ultra-light-ai.aiFix',
                title: 'AI Quick Fix',
                arguments: [document, range, diagnostic]
            };
            fix.diagnostics = [diagnostic];
            fix.isPreferred = false;
            actions.push(fix);
        }

        // If user has a selection, offer refactor/explain actions
        const selectedText = document.getText(range);
        if (selectedText && selectedText.trim().length > 5) {
            const explainAction = new vscode.CodeAction(
                '🔍 AI: Explain this code',
                vscode.CodeActionKind.Empty
            );
            explainAction.command = {
                command: 'ultra-light-ai.explainCode',
                title: 'Explain Code',
                arguments: [selectedText, document.languageId]
            };
            actions.push(explainAction);

            const refactorAction = new vscode.CodeAction(
                '⚡ AI: Refactor selection',
                vscode.CodeActionKind.Refactor
            );
            refactorAction.command = {
                command: 'ultra-light-ai.refactorSelection',
                title: 'Refactor Selection',
                arguments: [document, range, selectedText]
            };
            actions.push(refactorAction);

            const docsAction = new vscode.CodeAction(
                '📝 AI: Generate documentation',
                vscode.CodeActionKind.Empty
            );
            docsAction.command = {
                command: 'ultra-light-ai.generateDocs',
                title: 'Generate Docs',
                arguments: [document, range, selectedText]
            };
            actions.push(docsAction);
        }

        return actions;
    }
}

/**
 * Registers all code-action related commands with VS Code.
 */
export function registerCodeActionCommands(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    postToSidebar: (msg: any) => void
): void {
    // AI Fix: Generate fix for diagnostic error
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.aiFix', async (
            document: vscode.TextDocument,
            range: vscode.Range,
            diagnostic: vscode.Diagnostic
        ) => {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const keys = getGeminiApiKeys(workspaceRoot);
            const model = getGeminiModel(workspaceRoot);
            const timeout = getGeminiTimeout(workspaceRoot);
            const client = new GeminiCloudClient(keys, model, timeout);

            const codeContext = document.getText(new vscode.Range(
                new vscode.Position(Math.max(0, range.start.line - 5), 0),
                new vscode.Position(Math.min(document.lineCount - 1, range.end.line + 5), 10000)
            ));

            const prompt = `Fix this ${document.languageId} code error:

Error: ${diagnostic.message}
Severity: ${vscode.DiagnosticSeverity[diagnostic.severity]}
Location: Line ${range.start.line + 1}

Code context:
\`\`\`${document.languageId}
${codeContext}
\`\`\`

Provide ONLY the corrected code in a code block. No explanation needed.`;

            try {
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: '⚡ AI generating fix...',
                    cancellable: false
                }, async () => {
                    const result = await client.complete(prompt);
                    // Send the fix to the sidebar chat so user can review and apply
                    postToSidebar({
                        command: 'receiveChat',
                        text: `**AI Fix** for \`${diagnostic.message.substring(0, 50)}...\`\n\n${result.text}`,
                        usage: result.usage
                    });
                    outputChannel.appendLine(`[AI Fix] Generated fix for: ${diagnostic.message}`);
                });
            } catch (error: any) {
                vscode.window.showErrorMessage(`AI Fix failed: ${error?.message}`);
            }
        })
    );

    // Explain Code
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.explainCode', async (
            selectedText: string,
            languageId: string
        ) => {
            // Send to sidebar chat
            postToSidebar({
                command: 'injectChat',
                text: `Explain this ${languageId} code:\n\`\`\`${languageId}\n${selectedText}\n\`\`\``
            });
        })
    );

    // Refactor Selection
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.refactorSelection', async (
            document: vscode.TextDocument,
            range: vscode.Range,
            selectedText: string
        ) => {
            postToSidebar({
                command: 'injectChat',
                text: `Refactor this ${document.languageId} code for better readability and performance:\n\`\`\`${document.languageId}\n${selectedText}\n\`\`\``
            });
        })
    );

    // Generate Docs
    context.subscriptions.push(
        vscode.commands.registerCommand('ultra-light-ai.generateDocs', async (
            document: vscode.TextDocument,
            range: vscode.Range,
            selectedText: string
        ) => {
            postToSidebar({
                command: 'injectChat',
                text: `Generate comprehensive documentation/comments for this ${document.languageId} code:\n\`\`\`${document.languageId}\n${selectedText}\n\`\`\``
            });
        })
    );
}
