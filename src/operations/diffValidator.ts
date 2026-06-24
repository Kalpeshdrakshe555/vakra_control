import * as fs from 'fs';

export class DiffValidator {
    /**
     * Calculates a confidence score (0-100) for a search block matching existing text.
     */
    public static calculateConfidence(fileText: string, searchStr: string): number {
        if (!fileText || !searchStr) return 0;
        
        // Tier 1: Exact match
        if (fileText.includes(searchStr)) return 100;
        
        const normalizedFile = fileText.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
        const normalizedSearch = searchStr.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
        
        // Tier 2: Normalized match (whitespace insensitive)
        if (normalizedFile.includes(normalizedSearch)) return 90;
        
        // Tier 3: Line anchors match
        const searchLines = searchStr.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (searchLines.length >= 2) {
            const firstLine = searchLines[0];
            const lastLine = searchLines[searchLines.length - 1];
            
            const fileLines = fileText.split('\n').map(l => l.trim());
            const hasFirst = fileLines.includes(firstLine);
            const hasLast = fileLines.includes(lastLine);
            
            if (hasFirst && hasLast) return 70;
            if (hasFirst || hasLast) return 40;
        }

        return 30; // Poor match, probably a hallucination
    }

    /**
     * Validates if a patch is safe to apply automatically.
     */
    public static validatePatch(fileText: string, searchStr: string): { safe: boolean, score: number, reason?: string } {
        const score = this.calculateConfidence(fileText, searchStr);
        
        if (score >= 90) return { safe: true, score };
        if (score >= 70) return { safe: false, score, reason: "Imperfect match. Anchors found but middle content differs. Applying this might corrupt code." };
        
        return { safe: false, score, reason: "Severe context mismatch. The code to replace was not found in the file. (Hallucination suspected)" };
    }
}
