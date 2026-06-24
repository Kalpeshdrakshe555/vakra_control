import * as fs from 'fs';
import * as path from 'path';

export interface ErrorContext {
    filepath: string;
    line: number;
    codeSnippet: string;
}

export class ErrorDiagnoser {
    /**
     * Parses error text for file paths and line numbers.
     */
    public static extractErrors(errorText: string, workspaceRoot: string): ErrorContext[] {
        const contexts: ErrorContext[] = [];
        if (!errorText || !workspaceRoot) return contexts;
        
        // Standard error formats
        const regexes = [
            /at\s+.*?\s+\((.*?):(\d+):(\d+)\)/g,                           // Node.js: at Module._compile (internal/modules...:12:34)
            /at\s+(.*?):(\d+):(\d+)/g,                                     // Node.js: at /path/to/file.js:12:34
            /File\s+"(.*?)",\s+line\s+(\d+)/g,                               // Python: File "/path/to/file.py", line 42
            /([a-zA-Z0-9_.\-\/\\]+\.(?:ts|js|py|tsx|jsx|go|rs|java)):(\d+):(\d+)/g, // TS/JS/Rust: file.ts:42:15
            /in\s+(.*?)\s+on\s+line\s+(\d+)/g                                // PHP
        ];

        const uniqueFiles = new Set<string>();

        for (const regex of regexes) {
            let match;
            while ((match = regex.exec(errorText)) !== null) {
                let filepath = match[1];
                let line = parseInt(match[2], 10);
                
                // Clean up paths that start with file://
                if (filepath.startsWith('file://')) {
                    filepath = filepath.substring(7);
                }
                
                // Resolve absolute path
                if (!path.isAbsolute(filepath)) {
                    filepath = path.join(workspaceRoot, filepath);
                }
                
                // Ignore node_modules, native Node internal modules, Python libs
                if (filepath.includes('node_modules') || filepath.includes('lib/python') || !filepath.includes(workspaceRoot)) {
                    continue;
                }
                
                const key = `${filepath}:${line}`;
                if (!uniqueFiles.has(key)) {
                    if (fs.existsSync(filepath)) {
                        uniqueFiles.add(key);
                        const snippet = this.readCodeSnippet(filepath, line);
                        contexts.push({ filepath, line, codeSnippet: snippet });
                    }
                }
                
                if (contexts.length >= 3) break; // Limit to max 3 file contexts to avoid token explosion
            }
        }

        return contexts;
    }

    private static readCodeSnippet(filepath: string, line: number, contextLines: number = 7): string {
        try {
            const content = fs.readFileSync(filepath, 'utf8');
            const lines = content.split('\n');
            const start = Math.max(0, line - 1 - contextLines);
            const end = Math.min(lines.length, line + contextLines);
            
            let snippet = `// --- ${path.basename(filepath)} (Lines ${start + 1}-${end}) ---\n`;
            for (let i = start; i < end; i++) {
                const marker = (i === line - 1) ? '>> ' : '   ';
                snippet += `${marker}${i + 1}: ${lines[i]}\n`;
            }
            return snippet;
        } catch (e) {
            return `Failed to read file: ${filepath}`;
        }
    }
}
