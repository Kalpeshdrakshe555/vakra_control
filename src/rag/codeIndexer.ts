import * as vscode from 'vscode';

export interface CodeChunk {
    id: string;
    filepath: string;      // Legacy property for backward compatibility
    filePath: string;      // Standard property relative to workspace root
    symbolName: string;    // Name of the class, function, or symbol
    name: string;          // Human-readable identifier
    startLine: number;
    endLine: number;
    type: 'class' | 'function' | 'imports' | 'block';
    content: string;
    language?: string;
    framework?: string;
    exports?: string[];
    isEntryPoint?: boolean;
    importanceScore?: number;
}

/**
 * Extracts document symbols using VS Code's language server with a fallback timeout.
 */
async function getDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
    try {
        const res = await Promise.race([
            Promise.resolve(vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri)),
            new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1500))
        ]);
        return res || [];
    } catch {
        return [];
    }
}

/**
 * Recursively flattens VS Code document symbols into function and class scopes.
 */
function flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];
    const queue = [...symbols];

    while (queue.length > 0) {
        const sym = queue.shift()!;
        switch (sym.kind) {
            case vscode.SymbolKind.Class:
            case vscode.SymbolKind.Interface:
            case vscode.SymbolKind.Function:
            case vscode.SymbolKind.Method:
            case vscode.SymbolKind.Constructor:
                result.push(sym);
                break;
        }
        if (sym.children && sym.children.length > 0) {
            queue.push(...sym.children);
        }
    }
    return result;
}

/**
 * Splits an oversized function strictly at nested statement or block boundaries
 * rather than arbitrary line numbers.
 */
function splitOversizedFunction(
    filepath: string,
    symbolName: string,
    type: CodeChunk['type'],
    lines: string[],
    startLine: number,
    endLine: number,
    maxLines: number = 80
): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const totalLines = endLine - startLine + 1;

    if (totalLines <= maxLines) {
        chunks.push({
            id: `${filepath}#${symbolName}`,
            filepath,
            filePath: filepath,
            symbolName,
            name: symbolName,
            startLine,
            endLine,
            type,
            content: lines.slice(startLine, endLine + 1).join('\n')
        });
        return chunks;
    }

    // Preserve the function header/signature (first 1-3 lines) for context in each sub-chunk
    const signatureLines = lines.slice(startLine, Math.min(startLine + 3, endLine + 1));
    const signatureHeader = `// [Parent: ${symbolName}]\n` + signatureLines.join('\n') + '\n    // ... [continued] ...\n';

    // Find block boundaries within the function (nested braces at base depth, switch cases, or blank statement lines)
    const splitPoints: number[] = [startLine];
    let currentBlockLines = 0;
    let braceDepth = 0;

    for (let i = startLine; i <= endLine; i++) {
        const line = lines[i];
        for (const ch of line) {
            if (ch === '{') braceDepth++;
            else if (ch === '}') braceDepth--;
        }
        currentBlockLines++;

        // A clean boundary occurs when braceDepth returns to 1 (top-level statement within function)
        // or on blank lines separating statements when the block size exceeds maxLines
        const isStatementBoundary = (braceDepth <= 1 && currentBlockLines >= maxLines) ||
                                    (line.trim() === '' && currentBlockLines >= maxLines - 15);

        if (isStatementBoundary && i < endLine) {
            splitPoints.push(i);
            currentBlockLines = 0;
        }
    }
    splitPoints.push(endLine);

    for (let p = 0; p < splitPoints.length - 1; p++) {
        const segStart = p === 0 ? splitPoints[p] : splitPoints[p] + 1;
        const segEnd = splitPoints[p + 1];
        if (segStart > segEnd) continue;

        const bodySlice = lines.slice(segStart, segEnd + 1).join('\n');
        const partContent = p === 0 ? bodySlice : signatureHeader + bodySlice;

        chunks.push({
            id: `${filepath}#${symbolName}_part${p + 1}`,
            filepath,
            filePath: filepath,
            symbolName: `${symbolName} (Part ${p + 1})`,
            name: `${symbolName} (Part ${p + 1})`,
            startLine: segStart,
            endLine: segEnd,
            type: 'block',
            content: partContent
        });
    }

    return chunks;
}

/**
 * Asynchronously extracts structure-aware symbols using VS Code Document Symbol Provider
 * with automatic fallback to AST/regex boundaries.
 */
export async function chunkCodeFileAsync(filepath: string, content: string, uri?: vscode.Uri): Promise<CodeChunk[]> {
    if (uri) {
        try {
            const symbols = await getDocumentSymbols(uri);
            if (symbols && symbols.length > 0) {
                const flatSymbols = flattenSymbols(symbols);
                if (flatSymbols.length > 0) {
                    const lines = content.split(/\r?\n/);
                    const chunks: CodeChunk[] = [];
                    const coveredRanges: [number, number][] = [];

                    for (const sym of flatSymbols) {
                        const startLine = sym.range.start.line;
                        const endLine = sym.range.end.line;
                        const isClass = sym.kind === vscode.SymbolKind.Class || sym.kind === vscode.SymbolKind.Interface;
                        const type: CodeChunk['type'] = isClass ? 'class' : 'function';

                        // Avoid duplicate nested chunks if already represented
                        const alreadyCovered = coveredRanges.some(([s, e]) => startLine >= s && endLine <= e);
                        if (!alreadyCovered || isClass) {
                            coveredRanges.push([startLine, endLine]);
                            const subChunks = splitOversizedFunction(
                                filepath,
                                sym.name,
                                type,
                                lines,
                                startLine,
                                endLine
                            );
                            chunks.push(...subChunks);
                        }
                    }

                    if (chunks.length > 0) {
                        return chunks;
                    }
                }
            }
        } catch {
            // Fall through to regex-based chunker
        }
    }

    return chunkCodeFile(filepath, content);
}

/**
 * Synchronous Structure-Aware Code Chunker.
 * Preserves complete function, method, and class definitions using language boundaries.
 */
export function chunkCodeFile(filepath: string, content: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const lines = content.split(/\r?\n/);

    let importsEndLine = -1;
    let inImport = false;
    const exports: string[] = [];

    // Quick pass: detect imports & exports
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('import ') || line.startsWith('require(') || line.startsWith('from ')) {
            inImport = true;
            importsEndLine = Math.max(importsEndLine, i);
        } else if (inImport && line === '') {
            continue;
        } else if (inImport && !line.startsWith('import ') && !line.startsWith('from ')) {
            inImport = false;
        }
        const exportMatch = line.match(/^export\s+(?:default\s+)?(?:class|function|const|let|var)\s+([a-zA-Z0-9_]+)/);
        if (exportMatch) exports.push(exportMatch[1]);
        if (line.includes('module.exports =')) exports.push('default');
    }

    if (importsEndLine >= 0) {
        chunks.push({
            id: `${filepath}#imports`,
            filepath,
            filePath: filepath,
            symbolName: 'imports',
            name: 'imports',
            startLine: 0,
            endLine: importsEndLine,
            type: 'imports',
            content: lines.slice(0, importsEndLine + 1).join('\n'),
            exports
        });
    }

    // Language Boundary Regexes
    const jsBoundary  = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:class|function)\s+([a-zA-Z0-9_]+)/;
    const jsConst     = /^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/;
    const pyFunc      = /^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/;
    const pyClass     = /^class\s+([a-zA-Z0-9_]+)[\s:(]/;
    const goFunc      = /^func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_]+)\s*\(/;
    const rustFn      = /^(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*[<(]/;
    const rustImpl    = /^(?:pub\s+)?impl\s+([a-zA-Z0-9_]+)/;
    const javaMethod  = /^(?:public|protected|private|static|\s)+[\w<>\[\]]+\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{?/;

    const isPythonFile = filepath.endsWith('.py');

    let i = importsEndLine + 1;
    while (i < lines.length) {
        const rawLine = lines[i];
        const line = rawLine.trim();

        const match =
            line.match(jsBoundary) || line.match(jsConst) ||
            line.match(pyFunc)     || line.match(pyClass)  ||
            line.match(goFunc)     || line.match(rustFn)   ||
            line.match(rustImpl)   || line.match(javaMethod);

        if (match) {
            const name = match[1];
            const isClass = !!(line.includes('class ') || line.match(pyClass) || line.match(rustImpl));
            const type: CodeChunk['type'] = isClass ? 'class' : 'function';
            const startLine = i;
            let endLine = startLine;

            if (isPythonFile || line.match(pyFunc) || line.match(pyClass)) {
                // Python: strict indentation-based scope boundary
                const baseIndent = rawLine.match(/^(\s*)/)?.[1].length ?? 0;
                for (let j = i + 1; j < lines.length; j++) {
                    const l = lines[j];
                    const trimmed = l.trim();
                    if (trimmed === '') { endLine = j; continue; }
                    const indent = l.match(/^(\s*)/)?.[1].length ?? 0;
                    if (indent <= baseIndent) { break; }
                    endLine = j;
                }
            } else {
                // Brace-counting for JS/TS/Go/Rust/Java/C++
                let braceCount = 0;
                let foundBrace = false;
                for (let j = startLine; j < lines.length; j++) {
                    for (const ch of lines[j]) {
                        if (ch === '{') { braceCount++; foundBrace = true; }
                        else if (ch === '}') { braceCount--; }
                    }
                    if (foundBrace && braceCount === 0) { endLine = j; break; }
                }
                if (!foundBrace) {
                    while (endLine < lines.length && lines[endLine].trim() !== '') endLine++;
                    if (endLine >= lines.length) endLine = lines.length - 1;
                }
            }

            // Split only if oversized, strictly preserving statement boundaries
            const subChunks = splitOversizedFunction(
                filepath,
                name,
                type,
                lines,
                startLine,
                endLine,
                80
            );
            chunks.push(...subChunks);
            i = endLine + 1;
        } else {
            i++;
        }
    }

    // Fallback: if no functions/classes detected, use statement-aware block chunker
    if (chunks.length === (importsEndLine >= 0 ? 1 : 0)) {
        const maxLines = 80;
        let start = importsEndLine + 1;
        while (start < lines.length) {
            const end = Math.min(start + maxLines - 1, lines.length - 1);
            chunks.push({
                id: `${filepath}#L${start}-${end}`,
                filepath,
                filePath: filepath,
                symbolName: `Lines ${start + 1}-${end + 1}`,
                name: `Lines ${start + 1}-${end + 1}`,
                startLine: start,
                endLine: end,
                type: 'block',
                content: lines.slice(start, end + 1).join('\n')
            });
            if (end === lines.length - 1) break;
            start = end + 1;
        }
    }

    return chunks;
}