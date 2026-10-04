import * as fs from 'fs';
import * as path from 'path';
import { SessionMemory } from '../state/sessionMemory';

export interface IndexedFileInfo {
    path: string;
    lineCount: number;
    exports: string[];
    imports: string[];
    summary: string;
}

export class LivingIndex {
    private static indexedFiles: Map<string, IndexedFileInfo> = new Map();
    private static lastScanTime: number = 0;

    /**
     * Recursively gathers relevant code files while ignoring noisy directories.
     */
    private static getWorkspaceFiles(dir: string, baseDir: string = dir): string[] {
        const results: string[] = [];
        const ignoreList = new Set([
            'node_modules', '.git', 'out', 'dist', '.ultra-light-ai',
            '__pycache__', 'venv', '.venv', 'env', '.idea', '.vscode'
        ]);

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (ignoreList.has(entry.name)) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    results.push(...this.getWorkspaceFiles(fullPath, baseDir));
                } else if (entry.isFile() && /\.(py|ts|tsx|js|jsx|json|html|css|md)$/i.test(entry.name)) {
                    results.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
                }
            }
        } catch {}

        return results;
    }

    /**
     * Fast regex-based parser extracting high-value symbols and import relationships.
     */
    public static parseFile(workspaceRoot: string, relPath: string): IndexedFileInfo | null {
        try {
            const fullPath = path.join(workspaceRoot, relPath);
            if (!fs.existsSync(fullPath)) return null;

            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');
            const exports: string[] = [];
            const imports: string[] = [];

            const isPy = relPath.endsWith('.py');
            const isTsOrJs = /\.[jt]sx?$/.test(relPath);

            for (const line of lines) {
                const trimmed = line.trim();

                if (isPy) {
                    // Extract Python imports
                    const importMatch = trimmed.match(/^(?:from\s+([A-Za-z0-9_.]+)\s+import\s+([^#]+)|import\s+([^#]+))/);
                    if (importMatch) {
                        const imp = (importMatch[1] ? `${importMatch[1]}.${importMatch[2]}` : importMatch[3]).trim();
                        imports.push(imp.slice(0, 45));
                    }
                    // Classes & Django Models
                    const classMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)(?:\((.*?)\))?:/);
                    if (classMatch) {
                        exports.push(`class ${classMatch[1]}${classMatch[2] ? `(${classMatch[2]})` : ''}`);
                    }
                    // Functions & Views
                    const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\((.*?)\)/);
                    if (defMatch && !defMatch[1].startsWith('__')) {
                        exports.push(`def ${defMatch[1]}()`);
                    }
                    // Django URL patterns
                    if (trimmed.includes('path(') || trimmed.includes('re_path(')) {
                        const urlMatch = trimmed.match(/path\(\s*['"](.*?)['"]/);
                        if (urlMatch) exports.push(`route: /${urlMatch[1]}`);
                    }
                } else if (isTsOrJs) {
                    // Extract TS/JS imports
                    const tsImport = trimmed.match(/import\s+(?:\{([^}]+)\}|([A-Za-z0-9_]+))\s+from\s+['"](.*?)['"]/);
                    if (tsImport) {
                        imports.push(tsImport[3].replace(/^(\.\/|\.\.\/)+/, ''));
                    }
                    // TS/JS Exports
                    const expMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:class|interface|type|function|const)\s+([A-Za-z0-9_]+)/);
                    if (expMatch && trimmed.startsWith('export')) {
                        exports.push(expMatch[0].replace('export ', ''));
                    }
                }
            }

            return {
                path: relPath,
                lineCount: lines.length,
                exports: Array.from(new Set(exports)).slice(0, 15),
                imports: Array.from(new Set(imports)).slice(0, 10),
                summary: `${lines.length} lines`
            };
        } catch {
            return null;
        }
    }

    /**
     * Re-indexes workspace files.
     */
    public static async refreshBlueprint(workspaceRoot: string): Promise<string> {
        if (!workspaceRoot) return '';
        const allRelPaths = this.getWorkspaceFiles(workspaceRoot);

        for (const rel of allRelPaths) {
            const parsed = this.parseFile(workspaceRoot, rel);
            if (parsed) this.indexedFiles.set(rel, parsed);
        }

        this.lastScanTime = Date.now();
        const bpText = this.buildBlueprintText(workspaceRoot, 4000);

        try {
            const findingsDir = path.join(workspaceRoot, '.ultra-light-ai');
            if (!fs.existsSync(findingsDir)) fs.mkdirSync(findingsDir, { recursive: true });
            fs.writeFileSync(path.join(findingsDir, 'BLUEPRINT.md'), bpText, 'utf8');
        } catch {}

        return bpText;
    }

    /**
     * 4-Tier MRU & Dependency Ranked Blueprint Generator.
     * Prevents truncation blindness by prioritizing session-touched files and their imports.
     */
    public static buildBlueprintText(workspaceRoot: string, maxTokens: number = 4000): string {
        if (this.indexedFiles.size === 0 || Date.now() - this.lastScanTime > 60000) {
            const allRelPaths = this.getWorkspaceFiles(workspaceRoot);
            for (const rel of allRelPaths) {
                const parsed = this.parseFile(workspaceRoot, rel);
                if (parsed) this.indexedFiles.set(rel, parsed);
            }
            this.lastScanTime = Date.now();
        }

        const sessionMemory = SessionMemory.getInstance(workspaceRoot);
        const sessionTouched = new Set(sessionMemory.getSessionTouchedPaths());

        // Tier 0 & 1: Session touched files (MRU)
        // Tier 2: Dependencies / Imports of touched files
        // Tier 3: General project files
        const tier1: IndexedFileInfo[] = [];
        const tier2: IndexedFileInfo[] = [];
        const tier3: IndexedFileInfo[] = [];

        const touchedDependencyKeys = new Set<string>();

        // Collect dependencies of session touched files
        for (const pathKey of sessionTouched) {
            const info = this.indexedFiles.get(pathKey);
            if (info) {
                info.imports.forEach(imp => touchedDependencyKeys.add(imp.toLowerCase()));
            }
        }

        for (const [relPath, info] of this.indexedFiles.entries()) {
            if (sessionTouched.has(relPath)) {
                tier1.push(info);
            } else if (Array.from(touchedDependencyKeys).some(k => relPath.toLowerCase().includes(k))) {
                tier2.push(info);
            } else {
                tier3.push(info);
            }
        }

        // Assemble Blueprint with high-priority files at the absolute top
        const outputLines: string[] = [
            `# LIVING ARCHITECTURE BLUEPRINT (Total Tracked: ${this.indexedFiles.size} files)`,
            `*Prioritized by Working Set MRU & Dependency Graph*\n`
        ];

        if (tier1.length > 0) {
            outputLines.push('## 🎯 ACTIVE SESSION WORKING SET (Highest Priority):');
            for (const f of tier1) {
                outputLines.push(this.formatFileEntry(f, true));
            }
            outputLines.push('');
        }

        if (tier2.length > 0) {
            outputLines.push('## 🔗 LINKED DEPENDENCIES:');
            for (const f of tier2) {
                outputLines.push(this.formatFileEntry(f, false));
            }
            outputLines.push('');
        }

        if (tier3.length > 0) {
            outputLines.push('## 📁 PROJECT SKELETON:');
            for (const f of tier3) {
                outputLines.push(this.formatFileEntry(f, false));
            }
        }

        const fullBlueprint = outputLines.join('\n');
        // Budget management (approx 4 chars per token)
        const charLimit = maxTokens * 4;
        if (fullBlueprint.length > charLimit) {
            return fullBlueprint.slice(0, charLimit) + '\n\n...(Lower skeleton truncated to preserve context budget)';
        }

        return fullBlueprint;
    }

    private static formatFileEntry(file: IndexedFileInfo, isHighPriority: boolean): string {
        let entry = `- **\`${file.path}\`** (${file.summary})`;
        if (file.exports.length > 0) {
            entry += `\n  - Symbols: ${file.exports.join(', ')}`;
        }
        if (isHighPriority && file.imports.length > 0) {
            entry += `\n  - Imports: ${file.imports.slice(0, 6).join('; ')}`;
        }
        return entry;
    }
}
