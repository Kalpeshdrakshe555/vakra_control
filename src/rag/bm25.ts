export class BM25 {
    private k1 = 1.5;
    private b = 0.75;
    private documentLengths: Map<string, number> = new Map();
    private termFrequencies: Map<string, Map<string, number>> = new Map();
    private documentCount = 0;
    private averageDocumentLength = 0;
    private inverseDocumentFrequencies: Map<string, number> = new Map();

    public tokenize(text: string): string[] {
        return text
            .replace(/([a-z])([A-Z])/g, '$1 $2') // Split camelCase
            .replace(/[_\-\.]/g, ' ')            // Split snake_case and dots
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(t => t.length > 2);          // Ignore very short words
    }

    public addDocument(id: string, text: string) {
        const tokens = this.tokenize(text);
        this.documentLengths.set(id, tokens.length);
        
        const tf = new Map<string, number>();
        for (const token of tokens) {
            tf.set(token, (tf.get(token) || 0) + 1);
        }
        this.termFrequencies.set(id, tf);
        
        this.documentCount++;
        
        let totalLen = 0;
        for (const len of this.documentLengths.values()) totalLen += len;
        this.averageDocumentLength = totalLen / this.documentCount;

        for (const token of new Set(tokens)) {
            const df = (this.inverseDocumentFrequencies.get(token) || 0) + 1;
            this.inverseDocumentFrequencies.set(token, df);
        }
    }

    public getScore(queryTokens: string[], docId: string): number {
        const docLength = this.documentLengths.get(docId) || 0;
        const tfMap = this.termFrequencies.get(docId);
        if (!tfMap) return 0;

        let score = 0;
        for (const token of queryTokens) {
            const tf = tfMap.get(token) || 0;
            if (tf === 0) continue;
            const df = this.inverseDocumentFrequencies.get(token) || 1;
            const idf = Math.log(1 + (this.documentCount - df + 0.5) / (df + 0.5));
            score += idf * ((tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (docLength / this.averageDocumentLength))));
        }
        return score;
    }
}