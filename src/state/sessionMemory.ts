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
    routesOrKeys: string[]; // Captures framework routes, endpoints, Django URLs, form actions
    liveSnippet?: string;   // Compact live code snippet for hot files
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
    completedSubTasks: string[]; // Persistent sub-task ledger across chat turns and summarization
    updatedAt: number;
}

export class SessionMemory {
    private static instance: SessionMemory | null = null;
    private snapshot: SessionMemorySnapshot;
    private storagePath: string = '';
    private workspaceRoot: string = '';

    private constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.storagePath = path.join(workspaceRoot, '.ultra-light-ai', 'SESSION_MEMORY.json');
        this.snapshot = this.loadSnapshot();
    }

    public static getInstance(workspaceRoot: string): SessionMemory {
        if (!this.instance || this.instance.workspaceRoot !== workspaceRoot) {
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
                const parsed = JSON.parse(raw);
                return {
                    ...parsed,
                    completedSubTasks: Array.isArray(parsed.completedSubTasks) ? parsed.completedSubTasks : []
                };
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
            completedSubTasks: [],
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
     * Extracts symbols, imports, AND framework routes/URLs/templates so small models never lose cross-file links.
     */
    public static extractSymbols(filePath: string, content: string): { symbols: string[]; imports: string[]; routesOrKeys: string[]; liveSnippet: string } {
        const symbols: string[] = [];
        const imports: string[] = [];
        const routesOrKeys: string[] = [];
        const lines = content.split(/\r?\n/);

        const isPy = filePath.endsWith('.py');
        const isTsOrJs = /\.[jt]sx?$/.test(filePath);
        const isHtml = /\.html?$/.test(filePath);

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

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
                // Django / FastAPI / Flask routes, templates, reverse URLs
                if (/path\(|re_path\(|render\(|redirect\(|reverse\(|@(?:app|router)\.(?:get|post|put|delete)/.test(trimmed)) {
                    routesOrKeys.push(trimmed.slice(0, 90));
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
                // React / Express / Next.js routes and endpoints
                if (/Route\s+path=|app\.(get|post|put|delete)\(|router\.(get|post|put|delete)\(/.test(trimmed)) {
                    routesOrKeys.push(trimmed.slice(0, 90));
                }
            } else if (isHtml) {
                // Capture Django/Jinja {% url %} tags, hrefs, and form actions
                const urlMatches = trimmed.match(/\{%\s*url\s+[^%]+%\}|href="[^"]+"|action="[^"]+"/g);
                if (urlMatches) {
                    routesOrKeys.push(...urlMatches.slice(0, 4));
                }
            }
        }

        // Build compact live snippet (first 45 non-empty lines with line numbers) for Hot File pinning
        const compactLines = lines
            .map((l, idx) => `${idx + 1}: ${l}`)
            .filter(l => l.trim().length > 3)
            .slice(0, 45);

        return {
            symbols: Array.from(new Set(symbols)).slice(0, 30),
            imports: Array.from(new Set(imports)).slice(0, 15),
            routesOrKeys: Array.from(new Set(routesOrKeys)).slice(0, 15),
            liveSnippet: compactLines.join('\n').slice(0, 1400)
        };
    }

    public recordSubTaskDone(stepSummary: string): void {
        if (!this.snapshot.completedSubTasks) {
            this.snapshot.completedSubTasks = [];
        }
        if (!this.snapshot.completedSubTasks.includes(stepSummary)) {
            this.snapshot.completedSubTasks.push(stepSummary);
            this.save();
        }
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
            touched.push(relPath);

            // FIX: Always read full updated file from disk so we don't overwrite symbols with a 5-line diff patch!
            const fullPath = path.isAbsolute(relPath) ? relPath : path.join(this.workspaceRoot, relPath);
            let fullContent = args.content || args.new_text || '';
            try {
                if (fs.existsSync(fullPath)) {
                    fullContent = fs.readFileSync(fullPath, 'utf8');
                }
            } catch {}

            const hash = crypto.createHash('sha256').update(fullContent).digest('hex').slice(0, 12);
            const { symbols, imports, routesOrKeys, liveSnippet } = SessionMemory.extractSymbols(relPath, fullContent);

            const prev = this.snapshot.files[relPath];
            this.snapshot.files[relPath] = {
                path: relPath,
                status: toolName === 'write_file' ? 'created' : 'modified',
                revision: (prev?.revision || 0) + 1,
                sourceHash: hash,
                lastTouchedAt: timestamp,
                symbols,
                imports,
                routesOrKeys,
                liveSnippet,
                diagnostics: []
            };

            const symText = symbols.length > 0 ? ` -> Defined: ${symbols.slice(0, 6).join(', ')}` : '';
            summary = `[${toolName.toUpperCase()} ${relPath} (rev ${this.snapshot.files[relPath].revision})${symText}]`;
        } else if (toolName === 'read_multiple_files') {
            const rawPaths = args.filepaths || args.paths || [];
            const paths = (Array.isArray(rawPaths) ? rawPaths : [rawPaths]).filter(Boolean);
            paths.forEach((p: string) => {
                const norm = p.replace(/\\/g, '/');
                touched.push(norm);
                const fullPath = path.isAbsolute(p) ? p : path.join(this.workspaceRoot, p);
                let symbols: string[] = [];
                let imports: string[] = [];
                let routesOrKeys: string[] = [];
                let liveSnippet = '';
                let fileHash = '';
                try {
                    if (fs.existsSync(fullPath)) {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        fileHash = crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
                        const extracted = SessionMemory.extractSymbols(fullPath, content);
                        symbols = extracted.symbols;
                        imports = extracted.imports;
                        routesOrKeys = extracted.routesOrKeys;
                        liveSnippet = extracted.liveSnippet;
                    }
                } catch {}

                this.snapshot.files[norm] = {
                    path: norm,
                    status: this.snapshot.files[norm]?.status === 'modified' ? 'modified' : 'read',
                    revision: this.snapshot.files[norm]?.revision || 1,
                    sourceHash: fileHash,
                    lastTouchedAt: timestamp,
                    symbols: symbols.length > 0 ? symbols : (this.snapshot.files[norm]?.symbols || []),
                    imports: imports.length > 0 ? imports : (this.snapshot.files[norm]?.imports || []),
                    routesOrKeys: routesOrKeys.length > 0 ? routesOrKeys : (this.snapshot.files[norm]?.routesOrKeys || []),
                    liveSnippet: liveSnippet || this.snapshot.files[norm]?.liveSnippet,
                    diagnostics: []
                };
            });
            summary = `[INSPECTED ${paths.join(', ')}]`;
        } else if (toolName === 'execute_terminal_command') {
            const cmd = args.command || '';
            const errorMatches = rawResult.split('\n').filter(l => 
                /fatal|error|exception|traceback|syntaxerror|cannot import|modulenotfound|noreversematch/i.test(l)
            );

            if (!isSuccess || errorMatches.length > 0) {
                const topErrors = errorMatches.slice(0, 4).map(e => e.trim().slice(0, 150));
                this.snapshot.recentDiagnostics = Array.from(new Set([...topErrors, ...this.snapshot.recentDiagnostics])).slice(0, 6);
                summary = `[CMD FAILED: "${cmd.slice(0, 40)}" -> ${topErrors.join(' | ') || 'Non-zero exit'}]`;
            } else {
                // FIX: Clear stale diagnostics when verification command succeeds!
                this.snapshot.recentDiagnostics = [];
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

        this.snapshot.recentEvents = this.snapshot.recentEvents.slice(0, 20);
        this.save();
        return summary;
    }

    public getSessionTouchedPaths(): string[] {
        return [...this.snapshot.sessionTouchedPaths];
    }

    public getTouchedPaths(): string[] {
        return [...this.snapshot.sessionTouchedPaths];
    }

    public getFile(relPath: string): FileSemanticState | undefined {
        const norm = relPath.replace(/\\/g, '/');
        return this.snapshot.files[norm];
    }

    public getCompletedSubTasks(): string[] {
        return [...(this.snapshot.completedSubTasks || [])];
    }

    public resetSession(): void {
        this.snapshot.recentEvents = [];
        this.snapshot.recentDiagnostics = [];
        this.snapshot.completedSubTasks = [];
        this.snapshot.sessionTouchedPaths = [];
        this.save();
    }

    /**
     * Renders Pinned Working Memory:
     * - Top 3 Most Recently Touched Files get their LIVE CODE SNIPPET + Routes pinned (survives chat summarization!).
     * - Remaining files get compact symbol & route outlines.
     */
    public renderWorkingMemory(maxTokens: number = 2500): string {
        const sections: string[] = ['### 🧠 PINNED WORKING MEMORY (SURVIVES CHAT SUMMARIZATION)'];

        if (this.snapshot.completedSubTasks && this.snapshot.completedSubTasks.length > 0) {
            sections.push('#### ✅ Completed Milestones:\n' + this.snapshot.completedSubTasks.map(t => `- [x] ${t}`).join('\n'));
        }

        const mruPaths = this.snapshot.sessionTouchedPaths;
        const hotPaths = mruPaths.slice(0, 3); // Top 3 actively worked files
        const warmPaths = Object.keys(this.snapshot.files).filter(p => !hotPaths.includes(p)).slice(0, 12);

        if (hotPaths.length > 0) {
            sections.push('#### 🔥 Active Working Files (Live Disk State - Do NOT re-read unless needed):');
            for (const p of hotPaths) {
                const info = this.snapshot.files[p];
                if (!info) continue;
                let block = `##### 📄 \`${info.path}\` (${info.status}, rev${info.revision})`;
                if (info.routesOrKeys?.length) block += `\n- **Routes/Links:** ${info.routesOrKeys.join(' | ')}`;
                if (info.symbols?.length) block += `\n- **Symbols:** ${info.symbols.join(', ')}`;
                if (info.liveSnippet) block += `\n\`\`\`\n${info.liveSnippet}\n\`\`\``;
                sections.push(block);
            }
        }

        if (warmPaths.length > 0) {
            sections.push('#### 📦 Other Known Project Files (Outline):');
            for (const p of warmPaths) {
                const info = this.snapshot.files[p];
                if (!info) continue;
                let line = `- \`${info.path}\` (${info.status})`;
                if (info.symbols?.length > 0) line += ` | Symbols: ${info.symbols.slice(0, 8).join(', ')}`;
                if (info.routesOrKeys?.length > 0) line += ` | Links/Routes: ${info.routesOrKeys.slice(0, 5).join(', ')}`;
                sections.push(line);
            }
        }

        if (this.snapshot.recentDiagnostics && this.snapshot.recentDiagnostics.length > 0) {
            sections.push('#### ⚠️ UNRESOLVED ERRORS (Must Fix Before Finish):');
            for (const diag of this.snapshot.recentDiagnostics.slice(0, 6)) {
                sections.push(`- ❌ ${diag}`);
            }
        }

        const fullText = sections.join('\n\n');
        return fullText.length > maxTokens * 4 ? fullText.slice(0, maxTokens * 4) + '\n...[clipped]' : fullText;
    }
}
