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
            mapLines.push(`📁 ${relPath}`);

            try {
                const content = await fs.promises.readFile(fileUri.fsPath, 'utf8');
                const lines = content.split('\n');

                // 1. Extract Local Inter-File Connections / Imports
                const connections: string[] = [];
                for (const line of lines.slice(0, 50)) {
                    const trimmed = line.trim();
                    // JS/TS local import: import { a, b } from './module'
                    const jsMatch = trimmed.match(/^import\s+(?:\{([^}]+)\}|([a-zA-Z0-9_]+))\s+from\s+['"](\.[^'"]+)['"]/);
                    if (jsMatch) {
                        const importedNames = (jsMatch[1] || jsMatch[2] || '').trim().replace(/\s+/g, ' ');
                        const fromPath = jsMatch[3];
                        connections.push(`${fromPath} (${importedNames})`);
                    }
                    // Python local import: from .models import Item, Category or from app.models import ...
                    const pyMatch = trimmed.match(/^from\s+(\.[a-zA-Z0-9_.]+|[a-zA-Z0-9_.]+)\s+import\s+([a-zA-Z0-9_,\s*]+)/);
                    if (pyMatch && (pyMatch[1].startsWith('.') || pyMatch[1].includes('.'))) {
                        const modName = pyMatch[1];
                        const symbols = pyMatch[2].trim().replace(/\s+/g, ' ');
                        connections.push(`${modName} (${symbols})`);
                    }
                }
                if (connections.length > 0) {
                    mapLines.push(`   ↳ imports: ${connections.slice(0, 3).join(' | ')}`);
                }

                // 2. Extract Key Definitions (Functions, Classes, Endpoints)
                const signatures: string[] = [];
                for (const line of lines.slice(0, 250)) {
                    const trimmed = line.trim();
                    // Python class or def
                    const pyDef = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\([^)]*\):?/);
                    if (pyDef) {
                        signatures.push(`def ${pyDef[1]}`);
                        continue;
                    }
                    const pyClass = trimmed.match(/^class\s+([a-zA-Z0-9_]+)(?:\(([^)]+)\))?:?/);
                    if (pyClass) {
                        signatures.push(`class ${pyClass[1]}${pyClass[2] ? `(${pyClass[2]})` : ''}`);
                        continue;
                    }
                    // JS/TS class, function, export const/function
                    const jsFunc = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)/);
                    if (jsFunc) {
                        signatures.push(`function ${jsFunc[1]}`);
                        continue;
                    }
                    const jsConst = trimmed.match(/^(?:export\s+)?(?:const|let)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/);
                    if (jsConst) {
                        signatures.push(`export ${jsConst[1]}()`);
                        continue;
                    }
                    const jsClass = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+([a-zA-Z0-9_]+)/);
                    if (jsClass) {
                        signatures.push(`class ${jsClass[1]}`);
                        continue;
                    }
                    // Route endpoints (Express / Flask / FastAPI)
                    const routeMatch = trimmed.match(/^(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/i);
                    if (routeMatch) {
                        signatures.push(`${routeMatch[1].toUpperCase()} ${routeMatch[2]}`);
                        continue;
                    }
                    const pyRoute = trimmed.match(/^@(app|router)\.(get|post|put|delete|route)\s*\(\s*['"]([^'"]+)['"]/i);
                    if (pyRoute) {
                        signatures.push(`${pyRoute[2].toUpperCase()} ${pyRoute[3]}`);
                        continue;
                    }
                }

                if (signatures.length > 0) {
                    for (const sig of signatures.slice(0, 6)) {
                        mapLines.push(`   - ${sig}`);
                    }
                    if (signatures.length > 6) {
                        mapLines.push(`   - ... (${signatures.length - 6} more symbols)`);
                    }
                }
            } catch (err) {
                // Skip unreadable files
            }
        }

        mapLines.push('</workspace_structural_map>');
        return mapLines.join('\n');
    } catch (e) {
        console.warn('Failed to generate structural repo map:', e);
        return '';
    }
}