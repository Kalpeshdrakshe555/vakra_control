import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

async function getSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
    try {
        // It's possible this command fails on certain files or language servers
        // Add a 2-second timeout to prevent hanging the chat stream
        const res = await Promise.race([
            Promise.resolve(vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri)),
            new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2000))
        ]);
        return res || [];
    } catch (e) {
        console.warn(`Could not get symbols for ${uri.fsPath}. LSP may not be available.`, e);
        return [];
    }
}

function findFunctionLikeSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
    const functionSymbols: vscode.DocumentSymbol[] = [];
    const queue = [...symbols];

    while (queue.length > 0) {
        const symbol = queue.shift()!;
        switch (symbol.kind) {
            case vscode.SymbolKind.Function:
            case vscode.SymbolKind.Method:
            case vscode.SymbolKind.Constructor:
                functionSymbols.push(symbol);
                break;
        }
        if (symbol.children) {
            queue.push(...symbol.children);
        }
    }
    return functionSymbols;
}

/**
 * Uses VS Code's built-in Language Server to strip function/method bodies,
 * leaving only signatures. This is a robust way to reduce token count for large files.
 * @param uri The vscode.Uri of the file to skeletonize.
 * @returns A "skeleton" of the code as a string.
 */
export async function skeletonizeFile(uri: vscode.Uri): Promise<string> {
    const document = await vscode.workspace.openTextDocument(uri);
    let content = document.getText();
    const symbols = await getSymbols(uri);
    const functionSymbols = findFunctionLikeSymbols(symbols);

    // Sort symbols from bottom to top to avoid range conflicts during string replacement
    functionSymbols.sort((a, b) => b.range.start.line - a.range.start.line);

    for (const symbol of functionSymbols) {
        const symbolText = document.getText(symbol.range);
        const firstBraceIndex = symbolText.indexOf('{');
        
        // Ensure we don't strip bodies of single-line arrow functions or abstract methods
        if (firstBraceIndex === -1 || !symbolText.includes('\n')) {
            continue;
        }

        const lastBraceIndex = symbolText.lastIndexOf('}');

        if (lastBraceIndex > firstBraceIndex) {
            // Extract the content of the function body, between the braces.
            const bodyContent = symbolText.substring(firstBraceIndex + 1, lastBraceIndex);

            // Regex to find leading comments (JSDoc, multiline, singleline) at the start of the body.
            const leadingCommentsRegex = /^(\s*(\/\*[\s\S]*?\*\/|\/\/[^\r\n]*\r?\n))+/m;
            const match = bodyContent.match(leadingCommentsRegex);

            let preservedComments = '';
            if (match) {
                preservedComments = match[0];
            }

            const symbolStartOffset = document.offsetAt(symbol.range.start);
            const bodyStartOffset = symbolStartOffset + firstBraceIndex + 1;
            const bodyEndOffset = symbolStartOffset + lastBraceIndex;

            if (bodyEndOffset > bodyStartOffset) {
                const indentation = ' '.repeat(symbol.range.start.character + 2);
                const placeholder = `// ... Function body stripped by AI ...`;
                const newBody = preservedComments + '\n' + indentation + placeholder + '\n' + ' '.repeat(symbol.range.start.character);
                content = content.substring(0, bodyStartOffset) + newBody + content.substring(bodyEndOffset);
            }
        }
    }

    // Final cleanup pass to remove excessive newlines
    return content.replace(/\n\s*\n\s*\n/g, '\n\n');
}

/**
 * Generates a compact structural map of the workspace (file paths tree + top-level class/function signatures)
 * to provide the model with immediate structural awareness without needing blind file reads.
 */
export async function generateStructuralRepoMap(workspaceRoot: string, maxFiles: number = 25): Promise<string> {
    try {
        const userIgnoreFolders = vscode.workspace.getConfiguration('ultraLightAI').get<string[]>('ignoreFolders') || [];
        const combinedIgnores = Array.from(new Set([
            ...userIgnoreFolders, 
            'node_modules', '.git', 'dist', 'out', 'build', '.next', '.vscode', '.venv', 'venv', 'coverage', '__pycache__'
        ]));
        const excludePattern = `{${combinedIgnores.map(f => `**/${f}/**`).join(',')},**/*.lock,**/*.min.js,**/*.map}`;

        const files = await vscode.workspace.findFiles(
            '**/*.{ts,js,py,java,go,rs,tsx,jsx,css,html}',
            excludePattern,
            maxFiles
        );

        if (files.length === 0) return '';

        const mapLines: string[] = ['<workspace_structural_map>'];

        for (const fileUri of files) {
            const relPath = path.relative(workspaceRoot, fileUri.fsPath).replace(/\\/g, '/');
            const symbols = await getSymbols(fileUri);
            
            mapLines.push(`📁 ${relPath}`);

            if (symbols && symbols.length > 0) {
                for (const sym of symbols) {
                    const kindName = sym.kind === vscode.SymbolKind.Class ? 'class' :
                                     sym.kind === vscode.SymbolKind.Interface ? 'interface' :
                                     sym.kind === vscode.SymbolKind.Function ? 'function' :
                                     sym.kind === vscode.SymbolKind.Method ? 'method' : '';
                    if (kindName) {
                        mapLines.push(`   - ${kindName} ${sym.name}`);
                        if (sym.children && (sym.kind === vscode.SymbolKind.Class || sym.kind === vscode.SymbolKind.Interface)) {
                            for (const child of sym.children.slice(0, 5)) {
                                if (child.kind === vscode.SymbolKind.Method || child.kind === vscode.SymbolKind.Function) {
                                    mapLines.push(`     • method ${child.name}`);
                                }
                            }
                            if (sym.children.length > 5) {
                                mapLines.push(`     • ... (${sym.children.length - 5} more methods)`);
                            }
                        }
                    }
                }
            } else {
                try {
                    const content = await fs.promises.readFile(fileUri.fsPath, 'utf8');
                    const lines = content.split('\n');
                    const signatures: string[] = [];
                    for (const line of lines.slice(0, 80)) {
                        const trimmed = line.trim();
                        const match = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:class|function|def)\s+([a-zA-Z0-9_]+)/);
                        if (match) {
                            signatures.push(`   - ${match[0]}`);
                        }
                    }
                    mapLines.push(...signatures.slice(0, 5));
                } catch {}
            }
        }

        mapLines.push('</workspace_structural_map>');
        return mapLines.join('\n');
    } catch (e) {
        console.warn('Failed to generate structural repo map:', e);
        return '';
    }
}