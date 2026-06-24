import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { skeletonizeFile } from './astSkeletonizer';

export class DependencyGraph {
    /**
     * Extracts direct imported file paths from a given file content using RegEx.
     * Keeps it lightweight, no heavy AST.
     */
    public static getDirectImports(filepath: string, content: string): string[] {
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

        const dir = path.dirname(filepath);
        const resolvedPaths: string[] = [];

        // Resolve relative paths
        for (const imp of imports) {
            if (imp.startsWith('.')) {
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
        }

        return Array.from(new Set(resolvedPaths));
    }

    /**
     * Reads imported files and returns their skeletonized versions to provide dependency context
     * without exploding the token budget.
     */
    public static async getImportSkeletons(filepath: string, content: string, workspaceRoot: string): Promise<string> {
        const importedPaths = this.getDirectImports(filepath, content);
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
}
