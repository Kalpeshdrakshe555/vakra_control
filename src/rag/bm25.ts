/**
 * BM25 Search Engine
 * A zero-dependency implementation of the Okapi BM25 ranking function.
 */

export interface TokenizedChunk {
    id: string;
    tokens: string[];
    contentLength: number;
}

export class BM25 {
    private chunks: TokenizedChunk[] = [];
    private documentCount = 0;
    private averageDocumentLength = 0;
    private termDocumentFrequency: Map<string, number> = new Map();
    private chunkTermFrequencies: Map<string, Map<string, number>> = new Map();

    private readonly k1 = 1.5;
    private readonly b = 0.75;

    public addChunks(chunks: TokenizedChunk[]) {
        for (const chunk of chunks) {
            this.chunks.push(chunk);
            this.documentCount++;

            const tfMap = new Map<string, number>();
            const uniqueTerms = new Set<string>();

            for (const token of chunk.tokens) {
                tfMap.set(token, (tfMap.get(token) || 0) + 1);
                uniqueTerms.add(token);
            }

            this.chunkTermFrequencies.set(chunk.id, tfMap);

            for (const term of uniqueTerms) {
                this.termDocumentFrequency.set(term, (this.termDocumentFrequency.get(term) || 0) + 1);
            }
        }

        const totalLength = this.chunks.reduce((sum, chunk) => sum + chunk.contentLength, 0);
        this.averageDocumentLength = this.documentCount > 0 ? totalLength / this.documentCount : 0;
    }

    private computeIDF(term: string): number {
        const df = this.termDocumentFrequency.get(term) || 0;
        if (df === 0) return 0;
        return Math.log(1 + (this.documentCount - df + 0.5) / (df + 0.5));
    }

    public search(queryTokens: string[], topK: number = 5): { id: string, score: number }[] {
        const scores: { id: string, score: number }[] = [];

        for (const chunk of this.chunks) {
            let score = 0;
            const tfMap = this.chunkTermFrequencies.get(chunk.id);
            if (!tfMap) continue;

            for (const token of queryTokens) {
                const tf = tfMap.get(token) || 0;
                if (tf > 0) {
                    const idf = this.computeIDF(token);
                    const numerator = tf * (this.k1 + 1);
                    const denominator = tf + this.k1 * (1 - this.b + this.b * (chunk.contentLength / this.averageDocumentLength));
                    score += idf * (numerator / denominator);
                }
            }

            if (score > 0) {
                scores.push({ id: chunk.id, score });
            }
        }

        return scores.sort((a, b) => b.score - a.score).slice(0, topK);
    }
}

/**
 * Tokenizes text into searchable keywords.
 */
export function tokenizeCode(text: string): string[] {
    return text
        .replace(/([a-z])([A-Z])/g, '$1 $2')  // split camelCase
        .replace(/[_\-\.\/\\]/g, ' ')         // split snake_case and paths
        .toLowerCase()
        .split(/[^a-z0-9]+/)                  // split by non-alphanumeric
        .filter(t => t.length > 2);           // ignore very short tokens
}
