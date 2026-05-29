export interface ContextSource {
    name: string;
    content: string;
    priority: number;
}

export interface BudgetAllocation {
    name: string;
    content: string;
    tokens: number;
}

/**
 * Estimates the token count for a given text.
 * Heuristic: 1 token ≈ 4 characters.
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

/**
 * Smartly truncates text to fit a token budget.
 * Keeps the first N lines and last M lines, omitting the middle.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
    const totalTokens = estimateTokens(text);
    if (totalTokens <= maxTokens) return text;

    const lines = text.split('\n');
    const avgTokensPerLine = totalTokens / lines.length;
    
    // Calculate how many lines we can keep
    const linesToKeep = Math.floor(maxTokens / avgTokensPerLine);
    
    if (linesToKeep <= 5) {
        // If budget is extremely small, just hard truncate characters
        return text.substring(0, maxTokens * 4) + '\n... (truncated)';
    }

    // Allocate 60% budget to top, 40% to bottom
    const topLinesCount = Math.floor(linesToKeep * 0.6);
    const bottomLinesCount = linesToKeep - topLinesCount;

    const topPart = lines.slice(0, topLinesCount).join('\n');
    const bottomPart = lines.slice(lines.length - bottomLinesCount).join('\n');
    const omittedCount = lines.length - linesToKeep;

    return `${topPart}\n\n... (${omittedCount} lines omitted — ask for specific function if needed) ...\n\n${bottomPart}`;
}

/**
 * Allocates a token budget proportionally across multiple context sources based on their priority.
 */
export function allocateBudget(totalBudgetTokens: number, sources: ContextSource[]): BudgetAllocation[] {
    if (sources.length === 0) return [];

    let remainingBudget = totalBudgetTokens;
    const allocations: BudgetAllocation[] = [];
    
    // Sort sources by priority descending (highest priority first)
    const sortedSources = [...sources].sort((a, b) => b.priority - a.priority);

    for (const source of sortedSources) {
        const sourceTokens = estimateTokens(source.content);
        
        // If we can fit the whole source, allocate it
        if (sourceTokens <= remainingBudget) {
            allocations.push({
                name: source.name,
                content: source.content,
                tokens: sourceTokens
            });
            remainingBudget -= sourceTokens;
        } else {
            // Otherwise, truncate it to the remaining budget
            if (remainingBudget > 50) { // Only allocate if we have a meaningful chunk left
                const truncatedContent = truncateToTokens(source.content, remainingBudget);
                allocations.push({
                    name: source.name,
                    content: truncatedContent,
                    tokens: remainingBudget
                });
            } else {
                allocations.push({
                    name: source.name,
                    content: `... (omitted due to context limits) ...`,
                    tokens: 10
                });
            }
            remainingBudget = 0;
        }
    }

    // Restore original order
    return sources.map(s => allocations.find(a => a.name === s.name)!);
}
