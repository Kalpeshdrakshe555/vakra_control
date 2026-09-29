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
                
                const normFile = path.normalize(filepath).toLowerCase();
                const normRoot = path.normalize(workspaceRoot).toLowerCase();

                // Ignore node_modules, native Node internal modules, Python system libs
                if (normFile.includes('node_modules') || normFile.includes('site-packages') || normFile.includes('lib\\python') || normFile.includes('lib/python') || !normFile.startsWith(normRoot)) {
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

        // Framework Diagnostic 1: Django TemplateDoesNotExist
        const tplMatch = errorText.match(/TemplateDoesNotExist:\s*([a-zA-Z0-9_\-\.\/\\\\]+\.html)/i);
        if (tplMatch && tplMatch[1]) {
            const requestedTpl = tplMatch[1].replace(/\\/g, '/');
            const targetBase = path.basename(requestedTpl);
            const foundOnDisk: string[] = [];

            const scanForTemplate = (dir: string, depth: number) => {
                if (depth > 5) return;
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory()) {
                            if (!['node_modules', '.git', '.venv', 'env', '__pycache__', '.ultra-light-ai'].includes(entry.name)) {
                                scanForTemplate(path.join(dir, entry.name), depth + 1);
                            }
                        } else if (entry.isFile() && entry.name.toLowerCase() === targetBase.toLowerCase()) {
                            foundOnDisk.push(path.relative(workspaceRoot, path.join(dir, entry.name)).replace(/\\/g, '/'));
                        }
                    }
                } catch {}
            };
            scanForTemplate(workspaceRoot, 0);

            let tplDiagnostic = `### DJANGO TEMPLATE DIAGNOSTIC: TemplateDoesNotExist: ${requestedTpl} ###\n`;
            tplDiagnostic += `Django tried to load: '${requestedTpl}' but could not find it.\n`;
            if (foundOnDisk.length > 0) {
                tplDiagnostic += `Files matching '${targetBase}' found on disk:\n`;
                for (const f of foundOnDisk) {
                    tplDiagnostic += `- \`${f}\`\n`;
                }
                tplDiagnostic += `\nROOT CAUSE & FIX:
In Django with APP_DIRS: True, app templates MUST reside in:
  \`<app_name>/templates/<app_name>/<template_name>.html\`
If your file is currently at e.g. \`catalog/templates/${targetBase}\`, Django cannot find it with \`render(request, 'catalog/${targetBase}')\`!
FIX: Move the template into the nested directory: \`catalog/templates/catalog/${targetBase}\`, OR configure root \`templates/\` in \`settings.py\` via \`TEMPLATES['DIRS'] = [BASE_DIR / 'templates']\`.\n`;
            } else {
                tplDiagnostic += `The template file '${requestedTpl}' does not exist on disk anywhere in the workspace.\nFIX: Create the template file at \`<app_name>/templates/<app_name>/${targetBase}\` or \`templates/${requestedTpl}\`.\n`;
            }

            contexts.unshift({ filepath: requestedTpl, line: 0, codeSnippet: tplDiagnostic });
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
