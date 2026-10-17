export interface CleanOutputOptions {
    maxLines?: number;
    maxOutputBytes?: number;
    dedupeConsecutive?: boolean;
}

/**
 * Strips ANSI escape codes, simulates carriage-return overwrites, collapses blank lines,
 * dedupes consecutive identical lines, and keeps the tail lines within the limit.
 */
export function cleanOutput(text: string, options?: CleanOutputOptions): string {
    if (!text) return '';

    const maxLines = options?.maxLines ?? 120;
    const maxOutputBytes = options?.maxOutputBytes ?? 1024 * 1024;
    const dedupeConsecutive = options?.dedupeConsecutive ?? true;

    // 1. Strip ANSI Escape sequences (CSI, OSC, and general terminal formatting)
    // CSI: ESC [ ... [a-zA-Z]
    // OSC: ESC ] ... (BEL or ESC \)
    let cleaned = text
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b[@-Z\\-_]/g, '');

    // 2. Handle Carriage Return (\r) progress bar overwriting simulation
    // Split by \n first to preserve explicit newlines
    const rawLines = cleaned.replace(/\r\n/g, '\n').split('\n');
    const resolvedLines: string[] = [];

    for (const rawLine of rawLines) {
        if (!rawLine.includes('\r')) {
            resolvedLines.push(rawLine);
            continue;
        }

        // Simulate terminal carriage return: the last segment after \r overwrites previous text on the line
        const parts = rawLine.split('\r');
        let effectiveLine = '';
        for (const part of parts) {
            if (part.length >= effectiveLine.length) {
                effectiveLine = part;
            } else {
                effectiveLine = part + effectiveLine.slice(part.length);
            }
        }
        resolvedLines.push(effectiveLine);
    }

    // 3. Deduplicate consecutive identical lines (e.g. repeated logs/polling)
    const collapsedLines: string[] = [];
    if (dedupeConsecutive) {
        let lastLine: string | null = null;
        let repeatCount = 0;

        for (const line of resolvedLines) {
            if (line === lastLine && line.trim().length > 0) {
                repeatCount++;
            } else {
                if (repeatCount > 1) {
                    collapsedLines.push(`    [... repeated ${repeatCount} times ...]`);
                }
                repeatCount = 1;
                lastLine = line;
                collapsedLines.push(line);
            }
        }
        if (repeatCount > 1) {
            collapsedLines.push(`    [... repeated ${repeatCount} times ...]`);
        }
    } else {
        collapsedLines.push(...resolvedLines);
    }

    // 4. Collapse 3+ consecutive empty/whitespace lines to at most 1
    const normalizedBlankLines: string[] = [];
    let consecutiveBlanks = 0;
    for (const line of collapsedLines) {
        if (line.trim().length === 0) {
            consecutiveBlanks++;
            if (consecutiveBlanks <= 1) {
                normalizedBlankLines.push('');
            }
        } else {
            consecutiveBlanks = 0;
            normalizedBlankLines.push(line);
        }
    }

    // 5. Keep the tail of lines if exceeding maxLines
    let finalLines = normalizedBlankLines;
    if (finalLines.length > maxLines) {
        const omittedCount = finalLines.length - maxLines;
        finalLines = [
            `[... ${omittedCount} earlier lines omitted ...]`,
            ...finalLines.slice(omittedCount)
        ];
    }

    let result = finalLines.join('\n');

    // 6. Output byte cap protection
    if (Buffer.byteLength(result, 'utf8') > maxOutputBytes) {
        const buf = Buffer.from(result, 'utf8');
        const head = buf.subarray(0, 1024 * 16).toString('utf8');
        const tail = buf.subarray(buf.length - (maxOutputBytes - 1024 * 32)).toString('utf8');
        result = `${head}\n\n[... output truncated due to size limit ...]\n\n${tail}`;
    }

    return result;
}
