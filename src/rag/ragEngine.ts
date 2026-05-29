import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BM25, TokenizedChunk, tokenizeCode } from './bm25';
import { chunkFile, CodeChunk } from './codeIndexer';

export class RagEngine {
    private workspaceRoot: string;
    private bm25: BM25;
    private chunks: CodeChunk[] = [];
    private indexReady = false;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.bm25 = new BM25();
    }

    /**
     * Scans the workspace and builds the BM25 index in the background.
     */
    public async buildIndex() {
        try {
            const files = await vscode.workspace.findFiles(
                '**/*.{ts,js,py,java,go,rs,tsx,jsx,css,json,html,md}',
                '**/node_modules/**,**/dist/**,**/.git/**,**/out/**,**/*.lock,**/build/**'
            );

            this.chunks = [];
            const tokenizedChunks: TokenizedChunk[] = [];

            for (const file of files) {
                try {
                    const content = await fs.promises.readFile(file.fsPath, 'utf8');
                    // Skip huge files
                    if (content.length > 100000) continue;

                    const fileChunks = chunkFile(path.relative(this.workspaceRoot, file.fsPath), content);
                    
                    for (const chunk of fileChunks) {
                        this.chunks.push(chunk);
                        tokenizedChunks.push({
                            id: chunk.id,
                            tokens: chunk.tokens,
                            contentLength: chunk.content.length
                        });
                    }
                } catch (e) {
                    // console.warn(`Failed to index file ${file.fsPath}`, e);
                }
            }

            this.bm25 = new BM25();
            this.bm25.addChunks(tokenizedChunks);
            this.indexReady = true;
            
            console.log(`[RAG] Index built successfully: ${files.length} files, ${this.chunks.length} chunks.`);
        } catch (error) {
            console.error('[RAG] Failed to build index:', error);
        }
    }

    /**
     * Searches the local workspace index for relevant code chunks.
     */
    public search(query: string, topK: number = 5): CodeChunk[] {
        if (!this.indexReady) {
            return [];
        }

        const queryTokens = tokenizeCode(query);
        if (queryTokens.length === 0) return [];

        const results = this.bm25.search(queryTokens, topK);
        
        return results.map(r => this.chunks.find(c => c.id === r.id)).filter(Boolean) as CodeChunk[];
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
            
            const newChunks = chunkFile(relativePath, content);
            this.chunks.push(...newChunks);
            
            // Rebuild BM25 index (can be optimized later for real incremental updates)
            const tokenizedChunks: TokenizedChunk[] = this.chunks.map(chunk => ({
                id: chunk.id,
                tokens: chunk.tokens,
                contentLength: chunk.content.length
            }));
            
            this.bm25 = new BM25();
            this.bm25.addChunks(tokenizedChunks);
        } catch (e) {
            // Ignore missing files or unreadable files
        }
    }
}
