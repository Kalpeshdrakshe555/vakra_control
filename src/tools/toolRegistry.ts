import * as fs from 'fs';
import * as path from 'path';

export interface AgentTool {
    name: string;
    description: string;
    parameters: string;
    execute: (args: string, workspaceRoot: string) => Promise<string>;
}

import * as vscode from 'vscode';

export class ToolRegistry {
    private static tools: Map<string, AgentTool> = new Map();

    public static registerTool(tool: AgentTool) {
        this.tools.set(tool.name.toLowerCase(), tool);
    }

    /**
     * Registers Essential Agent Tools:
     * 1. list_directory_tree
     * 2. get_code_diagnostics
     * 3. get_symbol_outline
     * 4. check_localhost_health
     */
    public static registerEssentialTools() {
        // 0. research_web_docs
        this.registerTool({
            name: 'research_web_docs',
            description: 'Autonomous Sub-Agent: Researches web documentation, saves clean markdown under .ultra-light-ai/research/, and returns an executive summary.',
            parameters: '{"query": "string", "urls": ["url1", "url2"]}',
            execute: async (argsStr: string, workspaceRoot: string) => {
                try {
                    const parsed = JSON.parse(argsStr || '{}');
                    const query = parsed.query || 'Documentation Research';
                    const urls = parsed.urls || [];
                    const { researchWebDocs } = require('./scraper');
                    return await researchWebDocs(query, urls, workspaceRoot);
                } catch (e: any) {
                    return `Research sub-agent error: ${e?.message || e}`;
                }
            }
        });

        // 1. list_directory_tree
        this.registerTool({
            name: 'list_directory_tree',
            description: 'Returns a visual directory tree structure up to specified depth.',
            parameters: '{"dir": "optional path", "depth": number}',
            execute: async (argsStr: string, workspaceRoot: string) => {
                try {
                    let dir = workspaceRoot;
                    let depth = 2;
                    if (argsStr) {
                        try {
                            const parsed = JSON.parse(argsStr);
                            if (parsed.dir) dir = path.resolve(workspaceRoot, parsed.dir);
                            if (parsed.depth) depth = parsed.depth;
                        } catch {}
                    }
                    const buildTree = (currentDir: string, currentDepth: number, prefix = ''): string => {
                        if (currentDepth < 0 || !fs.existsSync(currentDir)) return '';
                        const items = fs.readdirSync(currentDir).filter(i => !i.startsWith('.') && i !== 'node_modules' && i !== 'dist' && i !== 'out');
                        let treeStr = '';
                        items.forEach((item, index) => {
                            const isLast = index === items.length - 1;
                            const fullPath = path.join(currentDir, item);
                            const stat = fs.statSync(fullPath);
                            const connector = isLast ? '└── ' : '├── ';
                            treeStr += `${prefix}${connector}${item}${stat.isDirectory() ? '/' : ''}\n`;
                            if (stat.isDirectory() && currentDepth > 1) {
                                treeStr += buildTree(fullPath, currentDepth - 1, prefix + (isLast ? '    ' : '│   '));
                            }
                        });
                        return treeStr;
                    };
                    return `Directory Tree for ${path.relative(workspaceRoot, dir) || '.'}:\n` + buildTree(dir, depth);
                } catch (e: any) {
                    return `Error building directory tree: ${e?.message || e}`;
                }
            }
        });

        // 2. get_code_diagnostics
        this.registerTool({
            name: 'get_code_diagnostics',
            description: 'Gets active LSP compiler errors and red squiggles for a file or workspace.',
            parameters: '{"filepath": "relative file path"}',
            execute: async (argsStr: string, workspaceRoot: string) => {
                try {
                    let targetUri: vscode.Uri | undefined;
                    if (argsStr) {
                        try {
                            const parsed = JSON.parse(argsStr);
                            if (parsed.filepath) targetUri = vscode.Uri.file(path.resolve(workspaceRoot, parsed.filepath));
                        } catch {}
                    }
                    const diagnostics = targetUri
                        ? vscode.languages.getDiagnostics(targetUri)
                        : vscode.languages.getDiagnostics().flatMap(([uri, diags]) => diags.map(d => ({ uri, d })));

                    if (Array.isArray(diagnostics) && diagnostics.length === 0) {
                        return 'No active code diagnostics/errors found.';
                    }

                    if (targetUri) {
                        return (diagnostics as vscode.Diagnostic[]).map(d => `[Line ${d.range.start.line + 1}] ${d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning'}: ${d.message}`).join('\n');
                    } else {
                        return (diagnostics as any[]).slice(0, 15).map(({ uri, d }) => `[${path.relative(workspaceRoot, uri.fsPath)}:${d.range.start.line + 1}] ${d.message}`).join('\n');
                    }
                } catch (e: any) {
                    return `Error fetching diagnostics: ${e?.message || e}`;
                }
            }
        });

        // 3. get_symbol_outline
        this.registerTool({
            name: 'get_symbol_outline',
            description: 'Returns the AST symbol outline (classes, functions, methods) for a file.',
            parameters: '{"filepath": "relative file path"}',
            execute: async (argsStr: string, workspaceRoot: string) => {
                try {
                    const parsed = JSON.parse(argsStr || '{}');
                    if (!parsed.filepath) return 'Error: filepath parameter required.';
                    const fullPath = path.resolve(workspaceRoot, parsed.filepath);
                    if (!fs.existsSync(fullPath)) return `File not found: ${parsed.filepath}`;

                    const uri = vscode.Uri.file(fullPath);
                    const symbols: vscode.DocumentSymbol[] | undefined = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
                    if (!symbols || symbols.length === 0) return `No symbols found in ${parsed.filepath}.`;

                    const formatSymbols = (syms: vscode.DocumentSymbol[], indent = ''): string => {
                        return syms.map(s => `${indent}- ${s.name} (${vscode.SymbolKind[s.kind]}) [Line ${s.range.start.line + 1}-${s.range.end.line + 1}]\n` + (s.children ? formatSymbols(s.children, indent + '  ') : '')).join('');
                    };

                    return `Symbol Outline for ${parsed.filepath}:\n` + formatSymbols(symbols);
                } catch (e: any) {
                    return `Error fetching symbol outline: ${e?.message || e}`;
                }
            }
        });

        // 4. check_localhost_health
        this.registerTool({
            name: 'check_localhost_health',
            description: 'Pings a local dev server port (e.g. 3000, 5173, 8080) to verify if it is online and responsive.',
            parameters: '{"port": 3000}',
            execute: async (argsStr: string) => {
                try {
                    const parsed = JSON.parse(argsStr || '{}');
                    const port = parsed.port || 3000;
                    const url = `http://localhost:${port}`;
                    const res = await fetch(url, { method: 'GET' });
                    return `Local server ping to ${url}: HTTP ${res.status} ${res.statusText}`;
                } catch (e: any) {
                    return `Dev server at localhost port failed to respond: ${e?.message || e}`;
                }
            }
        });

        // 5. replace_symbol
        this.registerTool({
            name: 'replace_symbol',
            description: 'Surgically replaces a whole function, class, or method by symbol name using LSP AST outline without fragile SEARCH blocks. Use "Class.method" for methods.',
            parameters: '{"filepath": "string", "symbolName": "string", "newCode": "string"}',
            execute: async (argsStr: string, _workspaceRoot: string) => {
                try {
                    const parsed = JSON.parse(argsStr || '{}');
                    if (!parsed.filepath || !parsed.symbolName || !parsed.newCode) {
                        return 'Error: replace_symbol requires "filepath", "symbolName", and "newCode".';
                    }
                    const { replaceSymbol } = require('../operations/replaceSymbol');
                    const res = await replaceSymbol({
                        filepath: parsed.filepath,
                        symbolName: parsed.symbolName,
                        newCode: parsed.newCode
                    });
                    if (!res.success) {
                        let msg = `replace_symbol failed: ${res.message}`;
                        if (res.candidates && res.candidates.length) {
                            msg += `\nAvailable candidate symbols: ${res.candidates.join(', ')}`;
                        }
                        return msg;
                    }
                    return res.message;
                } catch (e: any) {
                    return `replace_symbol error: ${e?.message || e}`;
                }
            }
        });

        // 6. capture_localhost_preview
        this.registerTool({
            name: 'capture_localhost_preview',
            description: 'Captures a visual screenshot and DOM layout health report of a local dev server (e.g. http://localhost:3000) using the system browser.',
            parameters: '{"url": "string", "viewport": "desktop|mobile"}',
            execute: async (argsStr: string) => {
                try {
                    const parsed = JSON.parse(argsStr || '{}');
                    const url = parsed.url || 'http://localhost:3000';
                    const viewport = parsed.viewport || 'desktop';
                    const { VisionCapture } = require('./visionCapture');
                    const capturer = new VisionCapture();
                    try {
                        const result = await capturer.capture(url, viewport);
                        let summary = `### 👁️ Visual Preview Captured (${result.viewport})\n`;
                        summary += `- URL: ${url}\n`;
                        summary += `- Console Errors: ${result.consoleErrors.length > 0 ? result.consoleErrors.join(', ') : 'None'}\n`;
                        summary += `- Failed Requests: ${result.failedRequests.length > 0 ? result.failedRequests.join(', ') : 'None'}\n`;
                        summary += `- DOM Findings: ${result.findings.length > 0 ? result.findings.map((f: any) => `\n  - [${f.severity}] ${f.text}`).join('') : 'No layout defects detected'}\n`;
                        return summary;
                    } finally {
                        capturer.dispose();
                    }
                } catch (e: any) {
                    return `capture_localhost_preview error: ${e?.message || e}`;
                }
            }
        });
    }

    public static loadWorkspacePlugins(workspaceRoot: string) {
        const pluginsPath = path.join(workspaceRoot, '.ultra-light-ai', 'plugins.js');
        if (fs.existsSync(pluginsPath)) {
            try {
                // Clear existing workspace plugins to reload
                // For safety, we should delete require cache but keeping it simple
                delete require.cache[require.resolve(pluginsPath)];
                const userPlugins = require(pluginsPath);
                if (Array.isArray(userPlugins)) {
                    for (const p of userPlugins) {
                        if (p.name && p.execute) {
                            this.registerTool(p);
                        }
                    }
                }
            } catch (e) {
                console.error("Failed to load workspace plugins", e);
            }
        }
    }

    public static getAvailableToolsPrompt(): string {
        if (this.tools.size === 0) return '';
        let prompt = `\n\n### ADDITIONAL TOOLS & PLUGINS ###\nYou have access to the following function tools in this workspace. Call them using their function name with valid JSON arguments or standard function call syntax:\n`;
        for (const tool of this.tools.values()) {
            prompt += `- **${tool.name}**: ${tool.description} | Parameters: \`${tool.parameters}\`\n`;
        }
        return prompt;
    }

    public static async executeTool(name: string, args: string, workspaceRoot: string): Promise<string> {
        const tool = this.tools.get(name.toLowerCase());
        if (!tool) throw new Error(`Tool ${name} not found`);
        return await tool.execute(args, workspaceRoot);
    }
}
