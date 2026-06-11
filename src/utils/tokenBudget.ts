export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function truncateToTokens(text: string, maxTokens: number): string {
    const maxChars = maxTokens * CHARS_PER_TOKEN;
    if (text.length <= maxChars) return text;
    
    // Smart truncation: keep top 60% (imports, classes, signatures) 
    // and bottom 40% (exports, recent functions)
    const topChars = Math.floor(maxChars * 0.6);
    const bottomChars = Math.floor(maxChars * 0.4);
    
    const top = text.substring(0, topChars);
    const bottom = text.substring(text.length - bottomChars);
    
    return `${top}\n\n... [CONTENT TRUNCATED TO SAVE TOKEN BUDGET] ...\n\n${bottom}`;
}

export interface ContextSource {
    name: string;
    content: string;
    priority: number; // 1 = lowest, 10 = highest
}

export interface AllocatedSource {
    name: string;
    content: string;
    tokens: number;
}

export function allocateBudget(totalBudgetTokens: number, sources: ContextSource[]): AllocatedSource[] {
    // Sort sources by priority descending (highest first)
    const sorted = [...sources].sort((a, b) => b.priority - a.priority);
    const result: AllocatedSource[] = [];
    let remainingTokens = totalBudgetTokens;

    for (const source of sorted) {
        if (remainingTokens <= 50) {
            // Not enough budget left, skip remaining lower-priority context
            break;
        }
        
        const sourceTokens = estimateTokens(source.content);
        
        if (sourceTokens <= remainingTokens) {
            result.push({
                name: source.name,
                content: source.content,
                tokens: sourceTokens
            });
            remainingTokens -= sourceTokens;
        } else {
            // Not enough budget for full file, smartly truncate it
            const truncated = truncateToTokens(source.content, remainingTokens);
            result.push({
                name: source.name,
                content: truncated,
                tokens: remainingTokens
            });
            remainingTokens = 0; // Budget exhausted
        }
    }

    return result;
}