import * as fs from 'fs';

export class DiffValidator {
    private static readonly LAZY_PLACEHOLDER_PATTERNS: { pattern: RegExp; description: string }[] = [
        { pattern: /\/\/\s*\.{3,}/i, description: "'// ...'" },
        { pattern: /#\s*\.{3,}/i, description: "'# ...'" },
        { pattern: /\/\*\s*\.{3,}\s*\*\//i, description: "'/* ... */'" },
        { pattern: /\/\/\s*(?:rest\s+of|existing|remaining)\s+(?:the\s+)?code/i, description: "'// existing code' or '// rest of code'" },
        { pattern: /#\s*(?:rest\s+of|existing|remaining)\s+(?:the\s+)?code/i, description: "'# rest of code' or '# existing code'" },
        { pattern: /\.{3,}\s*existing\s+implementation/i, description: "'... existing implementation'" },
        { pattern: /\/\/\s*\.{3,}\s*(?:existing|rest|remaining|code|functions?|methods?|imports?)/i, description: "'// ... existing code'" },
        { pattern: /#\s*\.{3,}\s*(?:existing|rest|remaining|code|functions?|methods?|imports?)/i, description: "'# ... existing code'" },
        { pattern: /\/\/\s*(?:code\s+)?remains?\s+(?:the\s+)?(?:same|unchanged)/i, description: "'// code remains unchanged'" },
        { pattern: /#\s*(?:code\s+)?remains?\s+(?:the\s+)?(?:same|unchanged)/i, description: "'# code remains unchanged'" },
        { pattern: /\/\/\s*(?:keep\s+existing|leave\s+existing|previous\s+code)/i, description: "'// keep existing code'" },
        { pattern: /#\s*(?:keep\s+existing|leave\s+existing|previous\s+code)/i, description: "'# keep existing code'" }
    ];

    /**
     * Validates replacement code block before applying to ensure it contains complete,
     * working code without lazy placeholders or accidental wipes.
     */
    public static validateReplacementContent(content: string, options?: { allowEmpty?: boolean }): { valid: boolean; reason?: string } {
        const trimmed = content.trim();

        // 1. Check for completely empty replacement blocks
        if (trimmed.length === 0) {
            const isIntentionalDeletion = options?.allowEmpty === true || 
                /\b(delete|deletion|remove|removed|clear|empty|intentional)\b/i.test(content);
            if (!isIntentionalDeletion) {
                return {
                    valid: false,
                    reason: "Replacement block is completely empty. If you intentionally want to delete code, mark it with an explicit comment (e.g. '// intentional deletion') or use a valid replacement."
                };
            }
        }

        // 2. Check for lazy placeholders / ellipsis
        for (const { pattern, description } of this.LAZY_PLACEHOLDER_PATTERNS) {
            if (pattern.test(content)) {
                return {
                    valid: false,
                    reason: `Lazy placeholder detected (${description}). Full code must be outputted without ellipsis or placeholder comments, otherwise existing code will be erased or corrupted.`
                };
            }
        }

        // 3. Check for monologue comments masquerading as code (e.g. # I am reading...)
        const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const allComments = lines.length > 0 && lines.every(l =>
            l.startsWith('#') || l.startsWith('//') || l.startsWith('/*') || l.startsWith('*') || l.startsWith('<!--')
        );
        if (allComments && (lines.length < 5 || /reading|inspecting|checking|verifying/i.test(trimmed))) {
            return {
                valid: false,
                reason: "Replacement block appears to be an explanatory comment or monologue rather than executable code."
            };
        }

        return { valid: true };
    }

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
