export interface EditFailure {
    index: number;
    reason: 'NOT_FOUND' | 'AMBIGUOUS' | 'EMPTY_SEARCH';
    context?: string;
}

export interface EditResult {
    ok: boolean;
    applied: number;
    total: number;
    failures: EditFailure[];
    newContent?: string;
}

export interface SearchReplaceBlock {
    search: string;
    replace: string;
}

/**
 * Applies a list of SEARCH/REPLACE blocks sequentially with tolerant fuzzy fallback strategies.
 */
export function applyEdits(original: string, blocks: SearchReplaceBlock[]): EditResult {
    if (!blocks || blocks.length === 0) {
        return { ok: true, applied: 0, total: 0, failures: [], newContent: original };
    }

    // Preserve original EOL
    const hadCrlf = original.includes('\r\n');
    let currentText = original.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const failures: EditFailure[] = [];
    let appliedCount = 0;

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const search = block.search.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const replace = block.replace.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        if (!search.trim()) {
            failures.push({ index: i, reason: 'EMPTY_SEARCH' });
            continue;
        }

        // Strategy 1: Exact match
        const exactResult = applyExact(currentText, search, replace);
        if (exactResult.ok) {
            currentText = exactResult.text!;
            appliedCount++;
            continue;
        } else if (exactResult.ambiguous) {
            failures.push({ index: i, reason: 'AMBIGUOUS', context: exactResult.context });
            continue;
        }

        // Strategy 2: Trailing whitespace tolerant
        const trailingResult = applyTrimEnd(currentText, search, replace);
        if (trailingResult.ok) {
            currentText = trailingResult.text!;
            appliedCount++;
            continue;
        } else if (trailingResult.ambiguous) {
            failures.push({ index: i, reason: 'AMBIGUOUS', context: 'Found multiple matches with trailing whitespace matching' });
            continue;
        }

        // Strategy 3: Indentation tolerant
        const indentResult = applyIndentationTolerant(currentText, search, replace);
        if (indentResult.ok) {
            currentText = indentResult.text!;
            appliedCount++;
            continue;
        } else if (indentResult.ambiguous) {
            failures.push({ index: i, reason: 'AMBIGUOUS', context: 'Found multiple matches with indentation matching' });
            continue;
        }

        // Not found: provide closest window context
        failures.push({
            index: i,
            reason: 'NOT_FOUND',
            context: findClosestSnippet(currentText, search)
        });
    }

    const ok = failures.length === 0;
    const finalContent = ok && hadCrlf ? currentText.replace(/\n/g, '\r\n') : currentText;

    return {
        ok,
        applied: appliedCount,
        total: blocks.length,
        failures,
        newContent: ok ? finalContent : undefined
    };
}

function applyExact(text: string, search: string, replace: string): { ok: boolean; ambiguous?: boolean; text?: string; context?: string } {
    const firstIdx = text.indexOf(search);
    if (firstIdx === -1) return { ok: false };

    const secondIdx = text.indexOf(search, firstIdx + search.length);
    if (secondIdx !== -1) {
        return { ok: false, ambiguous: true, context: `Found multiple instances of search block (${firstIdx}, ${secondIdx})` };
    }

    const updated = text.slice(0, firstIdx) + replace + text.slice(firstIdx + search.length);
    return { ok: true, text: updated };
}

function applyTrimEnd(text: string, search: string, replace: string): { ok: boolean; ambiguous?: boolean; text?: string } {
    const textLines = text.split('\n');
    const searchLines = search.split('\n');
    const matches: number[] = [];

    for (let i = 0; i <= textLines.length - searchLines.length; i++) {
        let match = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (textLines[i + j].trimEnd() !== searchLines[j].trimEnd()) {
                match = false;
                break;
            }
        }
        if (match) {
            matches.push(i);
        }
    }

    if (matches.length === 0) return { ok: false };
    if (matches.length > 1) return { ok: false, ambiguous: true };

    const matchIdx = matches[0];
    const before = textLines.slice(0, matchIdx);
    const after = textLines.slice(matchIdx + searchLines.length);
    const replaceLines = replace.split('\n');
    const updated = [...before, ...replaceLines, ...after].join('\n');
    return { ok: true, text: updated };
}

function applyIndentationTolerant(text: string, search: string, replace: string): { ok: boolean; ambiguous?: boolean; text?: string } {
    const textLines = text.split('\n');
    const searchLines = search.split('\n');
    if (searchLines.length === 0) return { ok: false };
    const matches: number[] = [];

    for (let i = 0; i <= textLines.length - searchLines.length; i++) {
        let match = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (textLines[i + j].trim() !== searchLines[j].trim()) {
                match = false;
                break;
            }
        }
        if (match) {
            matches.push(i);
        }
    }

    if (matches.length === 0) return { ok: false };
    if (matches.length > 1) return { ok: false, ambiguous: true };

    const matchIdx = matches[0];
    const textIndent = (textLines[matchIdx].match(/^\s*/) || [''])[0];
    const searchIndent = (searchLines[0].match(/^\s*/) || [''])[0];
    const indentDiff = textIndent.length - searchIndent.length;

    const adjustedReplaceLines = replace.split('\n').map(line => {
        if (indentDiff > 0) return ' '.repeat(indentDiff) + line;
        if (indentDiff < 0) return line.slice(Math.min(line.length, -indentDiff));
        return line;
    });

    const before = textLines.slice(0, matchIdx);
    const after = textLines.slice(matchIdx + searchLines.length);
    const updated = [...before, ...adjustedReplaceLines, ...after].join('\n');
    return { ok: true, text: updated };
}

function findClosestSnippet(text: string, search: string): string {
    const lines = text.split('\n');
    const firstSearchLine = search.split('\n')[0].trim();
    if (!firstSearchLine) return '';

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(firstSearchLine)) {
            const start = Math.max(0, i - 2);
            const end = Math.min(lines.length, i + 3);
            return lines.slice(start, end).join('\n');
        }
    }
    return '';
}
