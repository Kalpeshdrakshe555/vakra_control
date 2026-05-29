import * as vscode from 'vscode';
import { GeminiCloudClient } from '../router/realClients';
import { getGeminiApiKeys, getGeminiModel, getGeminiTimeout } from '../config';

/**
 * InlineCompletionItemProvider — Provides Copilot-style ghost text suggestions
 * as the user types. Triggers on typing pause with debounce.
 */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private lastRequestId = 0;
    private readonly debounceMs = 600;

    constructor(
        private readonly outputChannel: vscode.OutputChannel
    ) {}

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | null> {
        // Only trigger on automatic invocations (typing), not explicit requests
        // unless the user explicitly invoked it
        const config = vscode.workspace.getConfiguration('ultraLightAI');
        const isEnabled = config.get<boolean>('enableInlineCompletions', true);
        if (!isEnabled) {
            return null;
        }

        const line = document.lineAt(position.line);
        const prefix = line.text.substring(0, position.character);
        
        // Skip if the line is empty or just whitespace (avoid noise)
        if (prefix.trim().length < 3) {
            return null;
        }

        // Cancel any pending request
        const requestId = ++this.lastRequestId;

        // Wait for debounce
        await new Promise<void>((resolve) => {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }
            this.debounceTimer = setTimeout(resolve, this.debounceMs);
        });

        // Check if this request was superseded by a newer one
        if (requestId !== this.lastRequestId || token.isCancellationRequested) {
            return null;
        }

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const workspaceRoot = workspaceFolders && workspaceFolders.length > 0 
                ? workspaceFolders[0].uri.fsPath 
                : undefined;

            const keys = getGeminiApiKeys(workspaceRoot);
            const model = getGeminiModel(workspaceRoot);
            const timeout = getGeminiTimeout(workspaceRoot);
            const client = new GeminiCloudClient(keys, model, timeout);

            // Build context: lines before and after cursor
            const startLine = Math.max(0, position.line - 30);
            const endLine = Math.min(document.lineCount - 1, position.line + 10);
            
            const beforeCursor = document.getText(new vscode.Range(
                new vscode.Position(startLine, 0),
                position
            ));
            
            const afterCursor = document.getText(new vscode.Range(
                position,
                new vscode.Position(endLine, document.lineAt(endLine).text.length)
            ));

            const lang = document.languageId;
            const fileName = document.fileName.split(/[\\/]/).pop() || 'unknown';

            const prompt = `You are an AI code completion engine. Complete the code at the cursor position marked with <CURSOR>.
RULES:
- Return ONLY the completion text that goes after the cursor. NO explanations, NO code blocks, NO markdown.
- Keep completions short (1-3 lines max).
- Match the existing code style, indentation, and language conventions.
- If you can't provide a meaningful completion, respond with nothing.

File: ${fileName} (${lang})

\`\`\`${lang}
${beforeCursor}<CURSOR>${afterCursor}
\`\`\`

Complete after <CURSOR>:`;

            if (token.isCancellationRequested) { return null; }

            const result = await client.complete(prompt);
            
            if (token.isCancellationRequested || requestId !== this.lastRequestId) { 
                return null; 
            }

            let completionText = result.text.trim();
            
            // Clean up: Remove any markdown formatting the model might have added
            completionText = completionText
                .replace(/^```[\w]*\n?/, '')
                .replace(/\n?```$/, '')
                .replace(/^`|`$/g, '');

            if (!completionText || completionText.length === 0) {
                return null;
            }

            // Limit to reasonable length
            const lines = completionText.split('\n');
            if (lines.length > 5) {
                completionText = lines.slice(0, 5).join('\n');
            }

            const item = new vscode.InlineCompletionItem(
                completionText,
                new vscode.Range(position, position)
            );

            this.outputChannel.appendLine(`[Inline Completion] Suggested ${completionText.length} chars for ${fileName}`);
            return [item];

        } catch (error: any) {
            // Silently fail — inline completions should never show errors
            this.outputChannel.appendLine(`[Inline Completion] Error: ${error?.message || error}`);
            return null;
        }
    }
}
