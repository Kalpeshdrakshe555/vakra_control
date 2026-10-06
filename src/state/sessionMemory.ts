import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface FileSemanticState {
    path: string;
    status: 'created' | 'modified' | 'read' | 'deleted';
    revision: number;
    sourceHash: string;
    lastTouchedAt: number;
    symbols: string[];
    imports: string[];
    diagnostics: string[];
}

export interface SemanticLedgerEntry {
    id: string;
    tool: string;
    timestamp: number;
    summary: string;
    touchedFiles: string[];
}

export interface SessionMemorySnapshot {
    version: 1;
    sessionId: string;
    files: Record<string, FileSemanticState>;
    recentEvents: SemanticLedgerEntry[];
    recentDiagnostics: string[];
    decisions: string[];
    sessionTouchedPaths: string[];
    updatedAt: number;
}

export class SessionMemory {
    private static instance: SessionMemory | null = null;
    private snapshot: SessionMemorySnapshot;
    private storagePath: string = '';

    private constructor(workspaceRoot: string) {
        this.storagePath = path.join(workspaceRoot, '.ultra-light-ai', 'SESSION_MEMORY.json');
        this.snapshot = this.loadSnapshot();
    }

    public static getInstance(workspaceRoot: string): SessionMemory {
        if (!this.instance || this.instance.storagePath !== path.join(workspaceRoot, '.ultra-light-ai', 'SESSION_MEMORY.json')) {
            this.instance = new SessionMemory(workspaceRoot);
        }
        return this.instance;
    }

    public static recordCommand(workspaceRoot: string, command: string, success: boolean): void {
        this.getInstance(workspaceRoot).recordToolResult('execute_terminal_command', { command }, '', success);
    }

    public static recordFileApplied(workspaceRoot: string, filepath: string, content: string): void {
        this.getInstance(workspaceRoot).recordToolResult('write_file', { filepath, content }, 'Applied file patch', true);
    }

    private loadSnapshot(): SessionMemorySnapshot {
        try {
            if (fs.existsSync(this.storagePath)) {
                const raw = fs.readFileSync(this.storagePath, 'utf8');
                return JSON.parse(raw);
            }
        } catch {}

        return {
            version: 1,
            sessionId: 'session_' + Date.now(),
            files: {},
            recentEvents: [],
            recentDiagnostics: [],
            decisions: [],
            sessionTouchedPaths: [],
            updatedAt: Date.now()
        };
    }

    public save(): void {
        try {
            const dir = path.dirname(this.storagePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            this.snapshot.updatedAt = Date.now();
            fs.writeFileSync(this.storagePath, JSON.stringify(this.snapshot, null, 2), 'utf8');
        } catch (e) {
            console.error('Failed to persist session memory:', e);
        }
    }

    /**
     * Deterministic symbol extractor for Python, TS, JS without heavy external AST binaries.
     */
    public static extractSymbols(filePath: string, content: string): { symbols: string[]; imports: string[] } {
        const symbols: string[] = [];
        const imports: string[] = [];
        const lines = content.split('\n');

        const isPy = filePath.endsWith('.py');
        const isTsOrJs = /\.[jt]sx?$/.test(filePath);

        for (const line of lines) {
            const trimmed = line.trim();

            if (isPy) {
                // Python imports
                if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
                    imports.push(trimmed.slice(0, 60));
                }
                // Classes with inheritance
                const classMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)(\((.*?)\))?:/);
                if (classMatch) {
                    symbols.push(`class ${classMatch[1]}${classMatch[2] || ''}`);
                }
                // Functions / Methods
                const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\((.*?)\)(?:\s*->\s*([^:]+))?:/);
                if (defMatch) {
                    const params = defMatch[2].length > 40 ? defMatch[2].slice(0, 37) + '...' : defMatch[2];
                    const ret = defMatch[3] ? ` -> ${defMatch[3].trim()}` : '';
                    symbols.push(`def ${defMatch[1]}(${params})${ret}`);
                }
            } else if (isTsOrJs) {
                // TS/JS imports
                if (trimmed.startsWith('import ') && trimmed.includes('from')) {
                    imports.push(trimmed.slice(0, 60));
                }
                // Classes / Interfaces / Types
                const typeMatch = trimmed.match(/^(?:export\s+)?(?:class|interface|type)\s+([A-Za-z0-9_]+)/);
                if (typeMatch) {
                    symbols.push(typeMatch[0].replace('export ', ''));
                }
                // Functions / Const exports
                const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\((.*?)\)/);
                if (fnMatch) {
                    symbols.push(`function ${fnMatch[1]}()`);
                }
            }
        }

        return {
            symbols: Array.from(new Set(symbols)).slice(0, 30),
            imports: Array.from(new Set(imports)).slice(0, 15)
        };
    }

    /**
     * Compacts tool executions deterministically into durable semantic facts.
     */
    public recordToolResult(
        toolName: string,
        args: any,
        rawResult: string,
        isSuccess: boolean = true
    ): string {
        const timestamp = Date.now();
        const callId = 'call_' + Math.random().toString(36).slice(2, 8);
        let summary = '';
        const touched: string[] = [];

        if (toolName === 'write_file' || toolName === 'edit_file') {
            const relPath = (args.filepath || args.path || '').replace(/\\/g, '/');
            const content = args.content || args.new_text || '';
            touched.push(relPath);

            const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
            const { symbols, imports } = SessionMemory.extractSymbols(relPath, content);

            const prev = this.snapshot.files[relPath];
            this.snapshot.files[relPath] = {
                path: relPath,
                status: toolName === 'write_file' ? 'created' : 'modified',
                revision: (prev?.revision || 0) + 1,
                sourceHash: hash,
                lastTouchedAt: timestamp,
                symbols,
                imports,
                diagnostics: []
            };

            const symText = symbols.length > 0 ? ` -> Defined: ${symbols.slice(0, 8).join(', ')}` : '';
            summary = `[${toolName.toUpperCase()} ${relPath} (rev ${this.snapshot.files[relPath].revision})${symText}]`;
        } else if (toolName === 'read_multiple_files') {
            const paths = (Array.isArray(args.paths) ? args.paths : [args.paths]).filter(Boolean);
            paths.forEach((p: string) => {
                const norm = p.replace(/\\/g, '/');
                touched.push(norm);
                if (!this.snapshot.files[norm]) {
                    this.snapshot.files[norm] = {
                        path: norm,
                        status: 'read',
                        revision: 1,
                        sourceHash: '',
                        lastTouchedAt: timestamp,
                        symbols: [],
                        imports: [],
                        diagnostics: []
                    };
                }
            });
            summary = `[INSPECTED ${paths.join(', ')}]`;
        } else if (toolName === 'execute_terminal_command') {
            const cmd = args.command || '';
            const errorMatches = rawResult.split('\n').filter(l => 
                /fatal|error|exception|traceback|syntaxerror|cannot import|modulenotfound/i.test(l)
            );

            if (!isSuccess || errorMatches.length > 0) {
                const topErrors = errorMatches.slice(0, 4).map(e => e.trim().slice(0, 150));
                this.snapshot.recentDiagnostics.unshift(...topErrors);
                this.snapshot.recentDiagnostics = Array.from(new Set(this.snapshot.recentDiagnostics)).slice(0, 10);
                summary = `[CMD FAILED: "${cmd.slice(0, 40)}" -> ${topErrors.join(' | ') || 'Non-zero exit'}]`;
            } else {
                summary = `[CMD SUCCESS: "${cmd.slice(0, 40)}" -> verified clean]`;
            }
        } else {
            summary = `[TOOL: ${toolName} completed]`;
        }

        // Maintain MRU Touched Paths
        for (const p of touched) {
            this.snapshot.sessionTouchedPaths = [
                p,
                ...this.snapshot.sessionTouchedPaths.filter(existing => existing !== p)
            ];
        }

        this.snapshot.recentEvents.unshift({
            id: callId,
            tool: toolName,
            timestamp,
            summary,
            touchedFiles: touched
        });

        this.snapshot.recentEvents = this.snapshot.recentEvents.slice(0, 25);
        this.save();
        return summary;
    }

    public getSessionTouchedPaths(): string[] {
        return [...this.snapshot.sessionTouchedPaths];
    }

    /**
     * Renders dense, rich working memory for the model prompt (up to 3,500 tokens).
     */
    public renderWorkingMemory(maxTokens: number = 3500): string {
        const sections: string[] = ['### VAKRA WORKING MEMORY & LIVING STATE'];

        // 1. Materialized Files & Real Symbols
        const fileKeys = Object.keys(this.snapshot.files);
        if (fileKeys.length > 0) {
            sections.push('#### 📦 Materialized File Definitions:');
            for (const f of fileKeys.slice(0, 15)) {
                const info = this.snapshot.files[f];
                let line = `- \`${info.path}\` (${info.status}, rev ${info.revision})`;
                if (info.symbols.length > 0) {
                    line += `\n  - Symbols: ${info.symbols.join(', ')}`;
                }
                if (info.imports.length > 0) {
                    line += `\n  - Key Imports: ${info.imports.slice(0, 5).join('; ')}`;
                }
                sections.push(line);
            }
        }

        // 2. Active Diagnostics / Errors to resolve
        if (this.snapshot.recentDiagnostics.length > 0) {
            sections.push('#### ⚠️ Active Compiler / Runtime Diagnostics:');
            for (const diag of this.snapshot.recentDiagnostics.slice(0, 5)) {
                sections.push(`- ${diag}`);
            }
        }

        // 3. Recent Action Trail
        if (this.snapshot.recentEvents.length > 0) {
            sections.push('#### ⏱️ Recent Actions:');
            for (const ev of this.snapshot.recentEvents.slice(0, 10)) {
                sections.push(`- ${ev.summary}`);
            }
        }

        const fullText = sections.join('\n\n');
        // If content exceeds token estimate (~4 chars per token), return safe slice
        return fullText.length > maxTokens * 4 ? fullText.slice(0, maxTokens * 4) + '\n...(Memory tailored to budget)' : fullText;
    }
}
