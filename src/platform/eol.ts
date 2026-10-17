import * as fs from 'fs';
import * as path from 'path';

export interface NormalizedTextResult {
    text: string;
    eol: '\n' | '\r\n';
    hadBom: boolean;
}

/**
 * Reads text from a file, normalizes newlines to '\n', and detects original EOL and UTF-8 BOM.
 */
export async function readTextNormalized(filePath: string): Promise<NormalizedTextResult> {
    const raw = await fs.promises.readFile(filePath);
    return parseNormalizedBuffer(raw);
}

/**
 * Synchronous version of readTextNormalized.
 */
export function readTextNormalizedSync(filePath: string): NormalizedTextResult {
    const raw = fs.readFileSync(filePath);
    return parseNormalizedBuffer(raw);
}

function parseNormalizedBuffer(buffer: Buffer): NormalizedTextResult {
    let hadBom = false;
    let content = buffer;

    // Check for UTF-8 BOM (0xEF, 0xBB, 0xBF)
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        hadBom = true;
        content = buffer.subarray(3);
    }

    const rawString = content.toString('utf8');
    const crlfCount = (rawString.match(/\r\n/g) || []).length;
    const lfCount = (rawString.match(/[^\r]\n/g) || []).length;
    const eol: '\n' | '\r\n' = crlfCount > lfCount ? '\r\n' : '\n';

    // Normalize all line breaks to standard \n internally
    const text = rawString.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    return { text, eol, hadBom };
}

/**
 * Writes text to disk, preserving the target EOL ('\n' or '\r\n') and optional BOM.
 */
export async function writeTextPreservingEol(
    filePath: string,
    text: string,
    eol: '\n' | '\r\n' = '\n',
    hadBom: boolean = false
): Promise<void> {
    const parentDir = path.dirname(filePath);
    if (!fs.existsSync(parentDir)) {
        await fs.promises.mkdir(parentDir, { recursive: true });
    }

    const formatted = formatWithEolAndBom(text, eol, hadBom);
    await fs.promises.writeFile(filePath, formatted);
}

/**
 * Synchronous version of writeTextPreservingEol.
 */
export function writeTextPreservingEolSync(
    filePath: string,
    text: string,
    eol: '\n' | '\r\n' = '\n',
    hadBom: boolean = false
): void {
    const parentDir = path.dirname(filePath);
    if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
    }

    const formatted = formatWithEolAndBom(text, eol, hadBom);
    fs.writeFileSync(filePath, formatted);
}

function formatWithEolAndBom(text: string, eol: '\n' | '\r\n', hadBom: boolean): Buffer {
    let output = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (eol === '\r\n') {
        output = output.replace(/\n/g, '\r\n');
    }

    const textBuffer = Buffer.from(output, 'utf8');
    if (hadBom) {
        const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
        return Buffer.concat([bom, textBuffer]);
    }
    return textBuffer;
}

/**
 * Detects the EOL convention of the nearest sibling file in the same directory,
 * falling back to '\n' or Windows platform default.
 */
export function detectSiblingEol(targetPath: string): '\n' | '\r\n' {
    try {
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) return process.platform === 'win32' ? '\r\n' : '\n';

        const files = fs.readdirSync(dir);
        for (const file of files) {
            const full = path.join(dir, file);
            if (full === targetPath) continue;
            try {
                const stat = fs.statSync(full);
                if (stat.isFile() && stat.size > 0 && stat.size < 100000) {
                    const sample = fs.readFileSync(full, 'utf8');
                    if (sample.includes('\r\n')) return '\r\n';
                    if (sample.includes('\n')) return '\n';
                }
            } catch {
                // Ignore unreadable sibling files
            }
        }
    } catch {
        // Fallback
    }
    return process.platform === 'win32' ? '\r\n' : '\n';
}
