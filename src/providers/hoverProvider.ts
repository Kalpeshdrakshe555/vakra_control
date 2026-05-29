import * as vscode from 'vscode';
import { GeminiCloudClient } from '../router/realClients';
import { getGeminiApiKeys, getGeminiModel, getGeminiTimeout } from '../config';

/**
 * HoverProvider — Shows AI-generated explanations when hovering over code elements.
 * Only activates when the user holds Ctrl/Cmd while hovering, to avoid noise.
 */
export class AiHoverProvider implements vscode.HoverProvider {
    private cache = new Map<string, string>();
    private readonly maxCacheSize = 50;

    constructor(
        private readonly outputChannel: vscode.OutputChannel
    ) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        const config = vscode.workspace.getConfiguration('ultraLightAI');
        const isEnabled = config.get<boolean>('enableHoverExplanations', false);
        if (!isEnabled) {
            return null;
        }

        // Get the word under cursor
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) { return null; }

        const word = document.getText(wordRange);
        if (!word || word.length < 2 || word.length > 50) { return null; }

        // Get surrounding context (3 lines above & below)
        const startLine = Math.max(0, position.line - 3);
        const endLine = Math.min(document.lineCount - 1, position.line + 3);
        const context = document.getText(new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, document.lineAt(endLine).text.length)
        ));

        // Check cache
        const cacheKey = `${document.uri.fsPath}:${word}:${position.line}`;
        if (this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey)!;
            return new vscode.Hover(new vscode.MarkdownString(cached));
        }

        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const keys = getGeminiApiKeys(workspaceRoot);
            const model = getGeminiModel(workspaceRoot);
            const timeout = Math.min(getGeminiTimeout(workspaceRoot), 10000); // Max 10s for hover
            const client = new GeminiCloudClient(keys, model, timeout);

            const prompt = `Briefly explain what "${word}" does in this ${document.languageId} code context. Keep it under 2 sentences.

\`\`\`${document.languageId}
${context}
\`\`\`

Explain "${word}":`;

            if (token.isCancellationRequested) { return null; }

            const result = await client.complete(prompt);
            
            if (token.isCancellationRequested) { return null; }

            const explanation = result.text.trim();
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**⚡ Ultra Light AI** — \`${word}\`\n\n`);
            md.appendMarkdown(explanation);
            md.isTrusted = true;

            // Cache result
            if (this.cache.size >= this.maxCacheSize) {
                const firstKey = this.cache.keys().next().value;
                if (firstKey) { this.cache.delete(firstKey); }
            }
            this.cache.set(cacheKey, md.value);

            this.outputChannel.appendLine(`[Hover] Explained "${word}" at line ${position.line + 1}`);
            return new vscode.Hover(md, wordRange);

        } catch (error: any) {
            this.outputChannel.appendLine(`[Hover] Error: ${error?.message || error}`);
            return null;
        }
    }
}
