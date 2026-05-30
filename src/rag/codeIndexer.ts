import * as path from 'path';
import { tokenizeCode } from './bm25';

export interface CodeChunk {
    id: string;
    filepath: string;
    startLine: number;
    endLine: number;
    type: 'function' | 'class' | 'imports' | 'block' | 'generic';
    name: string;
    content: string;
    tokens: string[];
}

/**
 * Parses a file and breaks it into semantic chunks using Regex.
 * This provides zero-dependency AST-like chunking.
 */
export function chunkFile(filepath: string, content: string): CodeChunk[] {
    const ext = path.extname(filepath).toLowerCase();
    
    if (['.ts', '.js', '.jsx', '.tsx', '.py'].includes(ext)) {
        return chunkCodeFile(filepath, content);
    } else {
        return chunkGenericFile(filepath, content);
    }
}

/**
 * Strategy for code files (TS/JS/Python) to extract functions and classes.
 */
function chunkCodeFile(filepath: string, content: string): CodeChunk[] {
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];
    
    // Regex to detect function and class boundaries
    const blockRegex = /^(\s*)(?:export\s+)?(?:async\s+)?(?:function|class|interface|type)\s+([a-zA-Z0-9_]+)/;
    const arrowFnRegex = /^(\s*)(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s+)?\(/;

    let currentChunkType: CodeChunk['type'] = 'imports';
    let currentChunkName = 'imports';
    let currentChunkStart = 0;
    let currentChunkIndent = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        const match = blockRegex.exec(line) || arrowFnRegex.exec(line);
        if (match) {
            const indent = match[1].length;
            const name = match[2];
            
            // If we are at the root level, start a new chunk
            if (indent === 0) {
                // Save previous chunk
                if (i > currentChunkStart) {
                    const blockContent = lines.slice(currentChunkStart, i).join('\n').trim();
                    if (blockContent.length > 10) {
                        chunks.push({
                            id: `${filepath}#L${currentChunkStart}-${i - 1}`,
                            filepath,
                            startLine: currentChunkStart,
                            endLine: i - 1,
                            type: currentChunkType,
                            name: currentChunkName,
                            content: blockContent,
                            tokens: tokenizeCode(`${filepath} ${currentChunkName} ${blockContent}`)
                        });
                    }
                }

                currentChunkStart = i;
                currentChunkName = name;
                currentChunkType = line.includes('class') || line.includes('interface') ? 'class' : 'function';
            }
        }
    }

    // Save final chunk
    if (lines.length > currentChunkStart) {
        const blockContent = lines.slice(currentChunkStart).join('\n').trim();
        if (blockContent.length > 10) {
            chunks.push({
                id: `${filepath}#L${currentChunkStart}-${lines.length}`,
                filepath,
                startLine: currentChunkStart,
                endLine: lines.length,
                type: currentChunkType,
                name: currentChunkName,
                content: blockContent,
                tokens: tokenizeCode(`${filepath} ${currentChunkName} ${blockContent}`)
            });
        }
    }

    return chunks;
}

/**
 * Strategy for generic files (JSON, Markdown, CSS) - simple line-based chunking
 */
function chunkGenericFile(filepath: string, content: string, linesPerChunk: number = 100, overlap: number = 20): CodeChunk[] {
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];
    
    if (lines.length === 0) return chunks;

    for (let i = 0; i < lines.length; i += (linesPerChunk - overlap)) {
        const blockLines = lines.slice(i, i + linesPerChunk);
        const blockContent = blockLines.join('\n');
        chunks.push({
            id: `${filepath}#L${i}-${i + blockLines.length}`,
            filepath,
            startLine: i,
            endLine: i + blockLines.length,
            type: 'generic',
            name: `block_${Math.floor(i/(linesPerChunk-overlap)) + 1}`,
            content: blockContent,
            tokens: tokenizeCode(`${filepath} ${blockContent}`)
        });
        if (i + linesPerChunk >= lines.length) break;
    }
    
    return chunks;
}
