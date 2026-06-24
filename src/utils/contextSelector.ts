import * as vscode from 'vscode';

export class ContextSelector {
    /**
     * Extracts potential code symbols and explicitly mentioned files from a prompt.
     */
    public static extractExplicitMentions(prompt: string): { files: string[], symbols: string[] } {
        const files: string[] = [];
        const symbols: string[] = [];
        
        // Extract @file paths
        const fileMatches = prompt.matchAll(/@file\s+(?:"([^"]+)"|([^\s@]+))/gi);
        for (const match of fileMatches) {
            const filepath = match[1] || match[2];
            if (filepath) files.push(filepath);
        }

        // Extract PascalCase, camelCase, snake_case symbols
        // Minimum length 4 to avoid common short words
        const symbolRegex = /[A-Z][a-z0-9]+[A-Z][a-z0-9]+|[a-z]+[A-Z][a-z0-9]+|[a-z0-9]+_[a-z0-9_]+/g;
        const matches = prompt.match(symbolRegex) || [];
        
        const commonWords = new Set(['javascript', 'typescript', 'python', 'java', 'html', 'css', 'json', 'please', 'thanks']);
        for (const m of matches) {
            if (m.length >= 4 && !commonWords.has(m.toLowerCase())) {
                symbols.push(m);
            }
        }

        return { files, symbols: Array.from(new Set(symbols)) };
    }

    /**
     * Decides if the active file should be injected into the prompt based on relevance.
     */
    public static shouldInjectActiveFile(prompt: string, activeFilePath: string, activeFileContent: string): boolean {
        const promptLower = prompt.toLowerCase();
        
        // 1. Explicit UI requests (@active, @current)
        if (promptLower.includes('@active') || promptLower.includes('@current')) {
            return true;
        }

        // 2. Greetings or generic non-context requests -> Skip
        const isGreeting = /^(hi|hello|hey|yo|what's up|sup|morning|evening|afternoon)$/i.test(prompt.trim());
        if (isGreeting || promptLower.includes('ignore active file')) {
            return false;
        }

        // 3. Check for keywords indicating debugging or editing the current view
        const editKeywords = ['fix', 'bug', 'error', 'this file', 'current file', 'here', 'refactor', 'update', 'change', 'explain'];
        if (editKeywords.some(kw => promptLower.includes(kw))) {
            return true;
        }

        // 4. Check if any symbols mentioned in the prompt actually exist in the active file
        const mentions = this.extractExplicitMentions(prompt);
        if (mentions.symbols.length > 0) {
            for (const sym of mentions.symbols) {
                if (activeFileContent.includes(sym)) {
                    return true;
                }
            }
        }

        // Default to not injecting to save tokens
        return false;
    }
}
