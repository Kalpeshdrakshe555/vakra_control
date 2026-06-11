export interface CodeChunk {
    id: string;
    filepath: string;
    startLine: number;
    endLine: number;
    type: 'class' | 'function' | 'imports' | 'block';
    name: string;
    content: string;
}

export function chunkCodeFile(filepath: string, content: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const lines = content.split('\n');
    
    // Regex for standard function/class boundaries
    const boundaryRegex = /^(\s*)(export\s+)?(default\s+)?(async\s+)?(function|class)\s+([a-zA-Z0-9_]+)/;
    const arrowRegex = /^(\s*)(export\s+)?(const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(async\s+)?(\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/;

    let currentChunk: CodeChunk | null = null;
    let importsChunk: CodeChunk = {
        id: `${filepath}#imports`, filepath, startLine: 0, endLine: 0, type: 'imports', name: 'imports', content: ''
    };

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(boundaryRegex) || lines[i].match(arrowRegex);
        
        if (match) {
            const type = match[5] === 'class' ? 'class' : 'function';
            const name = match[6] || match[4] || 'anonymous';
            
            if (currentChunk) {
                currentChunk.endLine = i - 1;
                currentChunk.content = lines.slice(currentChunk.startLine, currentChunk.endLine + 1).join('\n');
                chunks.push(currentChunk);
            } else {
                importsChunk.endLine = Math.max(0, i - 1);
                importsChunk.content = lines.slice(0, i).join('\n');
                if (importsChunk.content.trim()) chunks.push(importsChunk);
            }
            
            currentChunk = {
                id: `${filepath}#${name}`, filepath, startLine: i, endLine: lines.length - 1, type, name, content: ''
            };
        }
    }
    
    if (currentChunk) {
        currentChunk.content = lines.slice(currentChunk.startLine).join('\n');
        chunks.push(currentChunk);
    } else if (chunks.length === 0) {
        // Fallback for files without clear functions (like CSS, JSON or pure scripts)
        for (let i = 0; i < lines.length; i += 60) {
            const end = Math.min(i + 59, lines.length - 1);
            chunks.push({
                id: `${filepath}#L${i}-${end}`,
                filepath,
                startLine: i,
                endLine: end,
                type: 'block',
                name: `Lines ${i}-${end}`,
                content: lines.slice(i, end + 1).join('\n')
            });
        }
    }
    return chunks;
}