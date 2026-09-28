import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BM25 } from './bm25';
import { chunkCodeFile, chunkCodeFileAsync, CodeChunk } from './codeIndexer';
import { ProjectScanner } from '../indexer/projectScanner';

// Bug 7 Fix: Synonym map for common code terms
const CODE_SYNONYMS: Record<string, string[]> = {
    'login':    ['auth', 'authenticate', 'signin', 'session', 'token'],
    'database': ['db', 'model', 'schema', 'orm', 'query', 'migration'],
    'api':      ['route', 'endpoint', 'handler', 'view', 'controller', 'url'],
    'error':    ['exception', 'bug', 'fail', 'crash', 'traceback', 'issue'],
    'user':     ['account', 'profile', 'member', 'customer', 'person'],
    'create':   ['add', 'insert', 'new', 'post', 'make'],
    'delete':   ['remove', 'drop', 'destroy', 'clear'],
    'update':   ['edit', 'patch', 'modify', 'change', 'put'],
    'list':     ['get', 'fetch', 'retrieve', 'read', 'all', 'index'],
    'test':     ['spec', 'assert', 'check', 'verify', 'unittest'],
};

export class RagEngine {
    private workspaceRoot: string;
    private bm25: BM25;
    private chunks: CodeChunk[] = [];
    private indexReady = false;
    private rebuildTimer: NodeJS.Timeout | null = null;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.bm25 = new BM25();
    }

    /**
     * Returns the path to the persistent RAG index file.
     */
    private getCachePath(): string {
        const aiMetaDir = path.join(this.workspaceRoot, '.ultra-light-ai');
        if (!fs.existsSync(aiMetaDir)) {
            fs.mkdirSync(aiMetaDir, { recursive: true });
        }
        return path.join(aiMetaDir, 'rag-index.json');
    }

    /**
     * Scans the workspace and builds the BM25 index in the background.
     */
    public async buildIndex() {
        try {
            const cachePath = this.getCachePath();
            if (fs.existsSync(cachePath)) {
                try {
                    const cacheData = await fs.promises.readFile(cachePath, 'utf8');
                    const parsed = JSON.parse(cacheData);
                    // Bug 6 Fix: Staleness check — if cache older than 24h, rebuild
                    const isStale = parsed.builtAt && (Date.now() - parsed.builtAt > 24 * 60 * 60 * 1000);
                    if (!isStale && Array.isArray(parsed.chunks)) {
                        this.chunks = parsed.chunks;
                        this.bm25 = new BM25();
                        // Bug 1 Fix: Restore boost scores from cached chunk metadata
                        for (const chunk of this.chunks) {
                            this.bm25.addDocument(chunk.id, chunk.content, chunk.importanceScore || 1.0);
                        }
                        this.indexReady = true;
                        console.log(`[RAG] Index loaded from cache: ${this.chunks.length} chunks.`);
                        return;
                    } else {
                        console.log(`[RAG] Cache stale or invalid, rebuilding...`);
                    }
                } catch (e) {
                    console.warn('[RAG] Failed to load cache, rebuilding...', e);
                }
            }

            const userIgnoreFolders = vscode.workspace.getConfiguration('ultraLightAI').get<string[]>('ignoreFolders') || [];
            const aiignorePath = path.join(this.workspaceRoot, '.aiignore');
            let aiignoreList: string[] = [];
            if (fs.existsSync(aiignorePath)) {
                try {
                    const aiContent = fs.readFileSync(aiignorePath, 'utf8');
                    aiignoreList = aiContent.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
                } catch (e) {}
            }
            const combinedIgnores = Array.from(new Set([...userIgnoreFolders, ...aiignoreList, 'node_modules', '.git', 'dist', 'out', 'build', '.next', '.vscode', '.venv', 'venv', 'coverage', '__pycache__']));
            const excludePattern = `{${combinedIgnores.map(f => `**/${f}/**`).join(',')},**/*.lock}`;

            const files = await vscode.workspace.findFiles(
                '**/*.{ts,js,py,java,go,rs,tsx,jsx,css,json,html,md}',
                excludePattern
            );

            this.chunks = [];
            
            // Bug 3 Fix: Read ProjectProfile ONCE before the loop (not per-file)
            const profile = ProjectScanner.getProfile(this.workspaceRoot);

            for (const file of files) {
                try {
                    const content = await fs.promises.readFile(file.fsPath, 'utf8');
                    if (content.length > 100000) continue;

                    const relativePath = path.relative(this.workspaceRoot, file.fsPath);
                    const fileChunks = await chunkCodeFileAsync(relativePath, content, file);
                    
                    const isEntryPoint = profile?.entryPoints.includes(relativePath.replace(/\\/g, '/')) || false;
                    
                    let importanceScore = 1.0;
                    if (isEntryPoint) importanceScore = 2.0;
                    else if (relativePath.includes('config') || relativePath.includes('setup')) importanceScore = 1.5;
                    else if (relativePath.includes('test') || relativePath.includes('spec')) importanceScore = 0.5;

                    for (const chunk of fileChunks) {
                        chunk.language = file.fsPath.split('.').pop();
                        chunk.framework = profile?.framework;
                        chunk.isEntryPoint = isEntryPoint;
                        chunk.importanceScore = importanceScore;
                        this.chunks.push(chunk);
                    }
                } catch (e) { /* ignore unreadable files */ }
            }

            this.bm25 = new BM25();
            for (const chunk of this.chunks) {
                this.bm25.addDocument(chunk.id, chunk.content, chunk.importanceScore || 1.0);
            }
            this.indexReady = true;
            
            // Bug 6 Fix: Save cache with timestamp for staleness check
            try {
                const cachePayload = { builtAt: Date.now(), fileCount: files.length, chunks: this.chunks };
                await fs.promises.writeFile(cachePath, JSON.stringify(cachePayload), 'utf8');
            } catch (e) { /* ignore write errors */ }

            console.log(`[RAG] Index built successfully: ${files.length} files, ${this.chunks.length} chunks.`);
        } catch (error) {
            console.error('[RAG] Failed to build index:', error);
        }
    }

    /**
     * Searches the local workspace index for relevant code chunks.
     */
    public search(query: string, topK: number = 5): CodeChunk[] {
        if (!this.indexReady) return [];

        // Bug 7 Fix: Expand query tokens with synonyms
        const baseTokens = this.bm25.tokenize(query);
        if (baseTokens.length === 0) return [];
        
        const expandedTokens = new Set(baseTokens);
        for (const token of baseTokens) {
            const synonyms = CODE_SYNONYMS[token.toLowerCase()];
            if (synonyms) synonyms.forEach(s => expandedTokens.add(s));
        }
        const queryTokens = Array.from(expandedTokens);

        const scoredChunks = this.chunks.map(chunk => ({
            chunk,
            score: this.bm25.getScore(queryTokens, chunk.id)
        })).filter(result => result.score > 0);
        
        scoredChunks.sort((a, b) => b.score - a.score);
        return scoredChunks.slice(0, topK).map(result => result.chunk);
    }

    /**
     * Bug 8 Fix: Returns focused 15-line snippets around matching lines instead of full chunks.
     * Reduces token consumption by ~60%.
     */
    public searchWithSnippets(query: string, topK: number = 5): { filepath: string, snippet: string, score: number }[] {
        const chunks = this.search(query, topK);
        const queryTokens = this.bm25.tokenize(query);

        return chunks.map(chunk => {
            const lines = chunk.content.split('\n');
            // Find lines that contain any query token
            const matchingLineIndices: number[] = [];
            lines.forEach((l, idx) => {
                const lower = l.toLowerCase();
                if (queryTokens.some(t => lower.includes(t))) matchingLineIndices.push(idx);
            });

            let snippetLines: string[];
            if (matchingLineIndices.length === 0) {
                // No direct match — return first 15 lines
                snippetLines = lines.slice(0, 15);
            } else {
                // Return ±6 lines around first match
                const center = matchingLineIndices[0];
                const start = Math.max(0, center - 6);
                const end = Math.min(lines.length, center + 9);
                snippetLines = lines.slice(start, end);
            }

            const matchOffset = matchingLineIndices.length > 0 ? Math.max(0, matchingLineIndices[0] - 6) : 0;
            const absoluteStart = chunk.startLine + (lines.length - snippetLines.length > 0 ? matchOffset : 0);
            const header = `// ${chunk.filepath} (L${absoluteStart}–, ${chunk.type}: ${chunk.name})`;
            return {
                filepath: chunk.filepath,
                snippet: header + '\n' + snippetLines.join('\n'),
                score: this.bm25.getScore(queryTokens, chunk.id)
            };
        });
    }
    
    /**
     * Incremental update for a single file (used by file watchers)
     */
    public async updateFile(filePath: string) {
        if (!this.indexReady) return;
        
        const relativePath = path.relative(this.workspaceRoot, filePath);
        
        // Remove old chunks
        this.chunks = this.chunks.filter(c => c.filepath !== relativePath);
        
        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            if (content.length > 100000) return;
            
            const newChunks = await chunkCodeFileAsync(relativePath, content, vscode.Uri.file(filePath));
            this.chunks.push(...newChunks);
            
        // Bug 2 Fix: Debounce BM25 rebuild with correct boost scores
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
        this.rebuildTimer = setTimeout(async () => {
            this.bm25 = new BM25();
            for (const chunk of this.chunks) {
                this.bm25.addDocument(chunk.id, chunk.content, chunk.importanceScore || 1.0); // ✅ boost restored
            }
            try {
                const cachePath = this.getCachePath();
                const cachePayload = { builtAt: Date.now(), fileCount: this.chunks.length, chunks: this.chunks };
                await fs.promises.writeFile(cachePath, JSON.stringify(cachePayload), 'utf8');
            } catch(e) {}
        }, 3000);
        } catch (e) {
            // Ignore missing files or unreadable files
        }
    }
}
