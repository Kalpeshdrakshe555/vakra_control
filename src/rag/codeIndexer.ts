export interface CodeChunk {
    id: string;
    filepath: string;
    startLine: number;
    endLine: number;
    type: 'class' | 'function' | 'imports' | 'block';
    name: string;
    content: string;
    language?: string;
    framework?: string;
    exports?: string[];
    isEntryPoint?: boolean;
    importanceScore?: number;
}

export function chunkCodeFile(filepath: string, content: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const lines = content.split('\n');

    let importsEndLine = -1;
    let inImport = false;
    const exports: string[] = [];

    // Quick pass: detect imports & exports
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('import ') || line.startsWith('require(')) {
            inImport = true;
            importsEndLine = Math.max(importsEndLine, i);
        } else if (inImport && line === '') {
            continue;
        } else if (inImport) {
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
            startLine: 0,
            endLine: importsEndLine,
            type: 'imports',
            name: 'imports',
            content: lines.slice(0, importsEndLine + 1).join('\n'),
            exports
        });
    }

    // ============================================================
    // MULTI-LANGUAGE Boundary Detection Regexes
    // ============================================================
    // JS/TS
    const jsBoundary  = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:class|function)\s+([a-zA-Z0-9_]+)/;
    const jsConst     = /^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/;
    // Python
    const pyFunc      = /^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/;
    const pyClass     = /^class\s+([a-zA-Z0-9_]+)[\s:(]/;
    // Go
    const goFunc      = /^func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_]+)\s*\(/;
    // Rust
    const rustFn      = /^(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*[<(]/;
    const rustImpl    = /^(?:pub\s+)?impl\s+([a-zA-Z0-9_]+)/;

    const isPythonFile = filepath.endsWith('.py');

    let i = importsEndLine + 1;
    while (i < lines.length) {
        const rawLine = lines[i];
        const line = rawLine.trim();

        const match =
            line.match(jsBoundary) || line.match(jsConst) ||
            line.match(pyFunc)     || line.match(pyClass)  ||
            line.match(goFunc)     ||
            line.match(rustFn)     || line.match(rustImpl);

        if (match) {
            const name = match[1];
            const isClass = !!(line.includes('class ') || line.match(pyClass) || line.match(rustImpl));
            const type: CodeChunk['type'] = isClass ? 'class' : 'function';
            const startLine = i;
            let endLine = startLine;

            if (isPythonFile || line.match(pyFunc) || line.match(pyClass)) {
                // Python: indent-based boundary
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
                // Brace-counting for JS/TS/Go/Rust/Java
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

            const chunkContent = lines.slice(startLine, endLine + 1).join('\n');
            const maxLines = 80;

            if (endLine - startLine <= maxLines + 10) {
                chunks.push({
                    id: `${filepath}#${name}`,
                    filepath, startLine, endLine, type, name,
                    content: chunkContent, exports
                });
            } else {
                // Split oversized chunks with overlap
                let currentStart = startLine;
                let part = 1;
                while (currentStart <= endLine) {
                    const currentEnd = Math.min(currentStart + maxLines - 1, endLine);
                    chunks.push({
                        id: `${filepath}#${name}_part${part}`,
                        filepath,
                        startLine: currentStart,
                        endLine: currentEnd,
                        type: 'block',
                        name: `${name} (Part ${part})`,
                        content: lines.slice(currentStart, currentEnd + 1).join('\n'),
                        exports
                    });
                    if (currentEnd === endLine) break;
                    currentStart += (maxLines - 20); // 20-line overlap
                    part++;
                }
            }
            i = endLine + 1;
        } else {
            i++;
        }
    }

    // Fallback: if no functions/classes detected, use sliding block chunker
    if (chunks.length === (importsEndLine >= 0 ? 1 : 0)) {
        const maxLines = 80;
        const overlapLines = 20;
        let start = importsEndLine + 1;
        while (start < lines.length) {
            const end = Math.min(start + maxLines - 1, lines.length - 1);
            chunks.push({
                id: `${filepath}#L${start}-${end}`,
                filepath,
                startLine: start,
                endLine: end,
                type: 'block',
                name: `Lines ${start}-${end}`,
                content: lines.slice(start, end + 1).join('\n')
            });
            if (end === lines.length - 1) break;
            start += (maxLines - overlapLines);
        }
    }

    return chunks;
}