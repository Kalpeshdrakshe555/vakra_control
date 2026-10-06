import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { skeletonizeFile } from './astSkeletonizer';

export class DependencyGraph {
    /**
     * Extracts direct imported file paths from a given file content using RegEx.
     * Keeps it lightweight, no heavy AST.
     */
    public static getDirectImports(filepath: string, content: string, workspaceRoot?: string): string[] {
        const imports: string[] = [];
        
        // Match ES6 imports: import { X } from './path' or import X from './path'
        const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
        // Match CommonJS requires: require('./path')
        const requireRegex = /require\(['"]([^'"]+)['"]\)/g;

        let match;
        while ((match = importRegex.exec(content)) !== null) {
            imports.push(match[1]);
        }
        while ((match = requireRegex.exec(content)) !== null) {
            imports.push(match[1]);
        }

        // Match Python imports: from .models import X or from app.models import X
        const pyFromRegex = /^\s*from\s+([a-zA-Z0-9_.]+)\s+import/gm;
        while ((match = pyFromRegex.exec(content)) !== null) {
            imports.push(match[1]);
        }

        const dir = path.dirname(filepath);
        const resolvedPaths: string[] = [];

        // Resolve relative paths
        for (const imp of imports) {
            if (imp.startsWith('.')) {
                if (filepath.endsWith('.py')) {
                    // Python relative import: .models -> ./models.py, ..utils -> ../utils.py
                    const leadingDots = imp.match(/^\.+/)?.[0].length || 1;
                    const modName = imp.replace(/^\.+/, '').replace(/\./g, path.sep);
                    let baseDir = dir;
                    for (let i = 1; i < leadingDots; i++) {
                        baseDir = path.dirname(baseDir);
                    }
                    const pyCandidates = [
                        path.join(baseDir, modName + '.py'),
                        path.join(baseDir, modName, '__init__.py')
                    ];
                    for (const cand of pyCandidates) {
                        if (fs.existsSync(cand)) {
                            resolvedPaths.push(cand);
                            break;
                        }
                    }
                } else {
                    let resolved = path.resolve(dir, imp);
                    // Simple attempt to resolve extension if missing
                    if (!fs.existsSync(resolved)) {
                        if (fs.existsSync(resolved + '.ts')) resolved += '.ts';
                        else if (fs.existsSync(resolved + '.js')) resolved += '.js';
                        else if (fs.existsSync(resolved + '.tsx')) resolved += '.tsx';
                        else if (fs.existsSync(resolved + '.jsx')) resolved += '.jsx';
                        else if (fs.existsSync(resolved + '/index.ts')) resolved += '/index.ts';
                        else if (fs.existsSync(resolved + '/index.js')) resolved += '/index.js';
                    }
                    
                    if (fs.existsSync(resolved)) {
                        resolvedPaths.push(resolved);
                    }
                }
            } else if (workspaceRoot && filepath.endsWith('.py')) {
                // Python package import relative to workspace root (e.g. from app.models import X)
                const modPath = imp.replace(/\./g, path.sep);
                const candidates = [
                    path.join(workspaceRoot, modPath + '.py'),
                    path.join(workspaceRoot, modPath, '__init__.py'),
                    path.join(dir, modPath + '.py')
                ];
                for (const cand of candidates) {
                    if (fs.existsSync(cand)) {
                        resolvedPaths.push(cand);
                        break;
                    }
                }
            }
        }

        return Array.from(new Set(resolvedPaths));
    }

    /**
     * Reads imported files and returns their skeletonized versions to provide dependency context
     * without exploding the token budget.
     */
    public static async getImportSkeletons(filepath: string, content: string, workspaceRoot: string): Promise<string> {
        const importedPaths = this.getDirectImports(filepath, content, workspaceRoot);
        if (importedPaths.length === 0) return '';

        let skeletonsContext = `\n\n> 🔗 **Dependencies (Imported by ${path.basename(filepath)}):**\n`;
        let skeletonCount = 0;

        for (const impPath of importedPaths) {
            // Cap at 3 imports to prevent recursive explosion
            if (skeletonCount >= 3) {
                skeletonsContext += `\n... (And more imports, skipping to save tokens)\n`;
                break;
            }

            try {
                const uri = vscode.Uri.file(impPath);
                const relPath = path.relative(workspaceRoot, impPath);
                
                // Use astSkeletonizer to get signatures only
                let skeleton = await skeletonizeFile(uri);
                
                // Further compress by removing empty lines and comments if needed
                if (skeleton.length > 2000) {
                    skeleton = skeleton.substring(0, 2000) + '\n// ... truncated';
                }

                skeletonsContext += `\n--- File: ${relPath} (Signatures only) ---\n\`\`\`\n${skeleton}\n\`\`\`\n`;
                skeletonCount++;
            } catch (e) {
                console.error(`Could not skeletonize import ${impPath}`, e);
            }
        }

        return skeletonCount > 0 ? skeletonsContext : '';
    }

    /**
     * Finds files in the workspace that import the given targetPath.
     */
    public static getDependents(targetPath: string, workspaceRoot: string): string[] {
        const dependents: string[] = [];
        if (!workspaceRoot || !fs.existsSync(targetPath)) return dependents;

        const normalizedTarget = path.normalize(targetPath).toLowerCase();
        const baseNameNoExt = path.basename(targetPath, path.extname(targetPath));

        const scanDir = (dir: string) => {
            const ignoreList = new Set(['node_modules', '.git', 'out', 'dist', '.ultra-light-ai', '__pycache__', 'venv', '.venv']);
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (ignoreList.has(entry.name)) continue;
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        scanDir(full);
                    } else if (entry.isFile() && /\.(py|ts|tsx|js|jsx)$/i.test(entry.name)) {
                        if (path.normalize(full).toLowerCase() === normalizedTarget) continue;
                        try {
                            const content = fs.readFileSync(full, 'utf8');
                            if (content.includes(baseNameNoExt)) {
                                const directImports = DependencyGraph.getDirectImports(full, content, workspaceRoot);
                                if (directImports.some(imp => path.normalize(imp).toLowerCase() === normalizedTarget)) {
                                    dependents.push(full);
                                }
                            }
                        } catch {}
                    }
                }
            } catch {}
        };

        scanDir(workspaceRoot);
        return Array.from(new Set(dependents));
    }
}
