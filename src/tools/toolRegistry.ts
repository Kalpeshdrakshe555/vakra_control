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
     * 1. execute_terminal_command
     * 2. list_directory_tree
     * 3. get_code_diagnostics
     * 4. get_symbol_outline
     */
    public static registerEssentialTools() {
        // Terminal Execution Tool
        this.registerTool({
            name: 'execute_terminal_command',
            description: 'Executes a non-interactive shell command in the integrated terminal and returns stdout/stderr output.',
            parameters: '{"command": "string", "explanation": "optional string"}',
            execute: async (argsStr: string, workspaceRoot: string) => {
                try {
                    const parsed = JSON.parse(argsStr || '{}');
                    const cmd = (parsed.command || '').replace(/^[\$#>]\s*/, '').trim();
                    if (!cmd) return 'Error: command parameter is required.';
                    const { TerminalCapture } = require('./terminalCapture');
                    const res = await TerminalCapture.runAndCapture(cmd, workspaceRoot);
                    return `[TERMINAL OUTPUT - Exit Code: ${res.exitCode}]\n${res.output || '(No output)'}`;
                } catch (e: any) {
                    return `Terminal Execution Error: ${e?.message || e}`;
                }
            }
        });

        // Codebase Semantic/BM25 Search Tool
        this.registerTool({
            name: 'search_codebase',
            description: 'Performs semantic/textual BM25 search across the workspace codebase to find symbols, classes, functions, or keywords.',
            parameters: '{"query": "string"}',
            execute: async (argsStr: string, workspaceRoot: string) => {
                try {
                    const parsed = JSON.parse(argsStr || '{}');
                    const query = (parsed.query || parsed.term || '').trim();
                    if (!query) return "Error: 'query' parameter is required for search_codebase.";
                    const { RagEngine } = require('../rag/ragEngine');
                    const ragEngine = new RagEngine(workspaceRoot);
                    let results = ragEngine.searchWithSnippets(query, 5);
                    if ((!results || results.length === 0) && typeof ragEngine.buildIndex === 'function') {
                        await ragEngine.buildIndex();
                        results = ragEngine.searchWithSnippets(query, 5);
                    }
                    if (!results || results.length === 0) {
                        return `No matches found for query: "${query}" in workspace.`;
                    }
                    return results.map((r: any) => r.snippet).join('\n\n---\n\n');
                } catch (e: any) {
                    return `Codebase search error: ${e?.message || e}`;
                }
            }
        });

        // =========================================================================
        // [VERSION 1 - LEGACY TOOL: research_web_docs - PRESERVED FOR ROLLBACK]
        // =========================================================================
        this.registerTool({
            name: 'research_web_docs',
            description: 'Legacy web documentation researcher (Version 1).',
            parameters: '{"query": "string", "urls": ["url1", "url2"]}',
            execute: async (argsStr: string, workspaceRoot: string) => {
                try {
                    const parsed = JSON.parse(argsStr || '{}');
                    const { UnifiedWebSearch } = require('./unifiedWebSearch');
                    const res = await UnifiedWebSearch.execute(parsed, workspaceRoot);
                    return res.text;
                } catch (e: any) {
                    return `Research error: ${e?.message || e}`;
                }
            }
        });

        // =========================================================================
        // [VERSION 2 - UNIFIED WEB SEARCH: 5K CHUNK STREAMING & AUTO-PAGINATION]
        // =========================================================================
        this.registerTool({
            name: 'search_web',
            description: 'Searches live web and scrapes top 2 authoritative websites (5,000 chars each). Use offset to read next 5k slice.',
            parameters: '{"query": "string", "offset": 0, "urls": ["url1", "url2"]}',
            execute: async (argsStr: string, workspaceRoot: string) => {
                try {
                    const parsed = JSON.parse(argsStr || '{}');
                    const { UnifiedWebSearch } = require('./unifiedWebSearch');
                    const res = await UnifiedWebSearch.execute(parsed, workspaceRoot);
                    return res.text;
                } catch (e: any) {
                    return `Web search error: ${e?.message || e}`;
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

    public static hasTool(name: string): boolean {
        if (!name) return false;
        if (this.tools.size === 0) {
            this.registerEssentialTools();
        }
        return this.tools.has(name.toLowerCase());
    }

    public static async executeTool(name: string, args: string, workspaceRoot: string): Promise<string> {
        if (this.tools.size === 0) {
            this.registerEssentialTools();
        }
        const tool = this.tools.get(name.toLowerCase());
        if (!tool) throw new Error(`Tool ${name} not found`);
        return await tool.execute(args, workspaceRoot);
    }
}
