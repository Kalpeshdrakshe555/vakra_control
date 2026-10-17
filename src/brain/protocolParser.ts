import { BrainReplyType } from './protocolSpec';

export interface ParsedFile {
    path: string;
    content: string;
    complete: boolean;
}

export interface EditBlock {
    search: string;
    replace: string;
}

export interface ParsedEdit {
    path: string;
    blocks: EditBlock[];
    complete: boolean;
}

export interface ParsedReply {
    type: BrainReplyType;
    stepNo?: number;
    stepTitle?: string;
    manifest: string[];
    files: ParsedFile[];
    edits: ParsedEdit[];
    commands: string[];
    verify: string[];
    nextPlanned?: string;
    needFiles: string[];
    needCommands: string[];
    question?: string;
    text: string;
    hasEndMarker: boolean;
    warnings: string[];
}

/**
 * Normalizes a relative path string and checks for path escape safety.
 */
function sanitizeProtocolPath(rawPath: string, warnings: string[]): string | null {
    let p = rawPath.trim().replace(/^['"`]+|['"`]+$/g, '').trim();
    p = p.replace(/\\/g, '/');
    if (p.startsWith('./')) p = p.slice(2);

    // Reject drive letters, root slashes, or path traversal
    if (/^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.includes('..')) {
        warnings.push(`Unsafe path rejected in protocol: '${rawPath}'`);
        return null;
    }

    return p;
}

/**
 * Strips outer markdown code block if the entire body is wrapped in one.
 */
function unwrapSingleOuterFence(text: string): string {
    const lines = text.split('\n');
    let firstIdx = -1;
    let lastIdx = -1;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().length > 0) {
            firstIdx = i;
            break;
        }
    }

    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().length > 0) {
            lastIdx = i;
            break;
        }
    }

    if (firstIdx !== -1 && lastIdx > firstIdx) {
        const first = lines[firstIdx].trim();
        const last = lines[lastIdx].trim();
        if (/^```[a-zA-Z0-9_\-\.]*$/.test(first) && /^```$/.test(last)) {
            // Count total fences
            let fenceCount = 0;
            for (let i = firstIdx; i <= lastIdx; i++) {
                if (/^```/.test(lines[i].trim())) fenceCount++;
            }
            if (fenceCount === 2) {
                return lines.slice(firstIdx + 1, lastIdx).join('\n');
            }
        }
    }

    return text;
}

/**
 * Parses a raw response string from Web Brain or an LLM into a structured protocol object.
 */
export function parseReply(raw: string): ParsedReply {
    const warnings: string[] = [];
    if (!raw || !raw.trim()) {
        return {
            type: 'UNKNOWN',
            manifest: [],
            files: [],
            edits: [],
            commands: [],
            verify: [],
            needFiles: [],
            needCommands: [],
            text: '',
            hasEndMarker: false,
            warnings: ['Empty response received']
        };
    }

    // 1. Normalization
    let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Strip BOM and zero-width spaces
    text = text.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\uFEFF]/g, '');

    // Check end marker
    const hasEndMarker = /^===END OF RESPONSE===\s*$/m.test(text);

    // Strip single outer fence wrapping whole reply if present
    text = unwrapSingleOuterFence(text);

    const allLines = text.split('\n');

    // 2. Detect TYPE: <X>
    let type: BrainReplyType = 'UNKNOWN';
    let stepNo: number | undefined;
    let stepTitle: string | undefined;
    let question: string | undefined;
    const needFiles: string[] = [];
    const needCommands: string[] = [];

    for (const line of allLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const typeMatch = trimmed.match(/^TYPE:\s*([A-Z_]+)/i);
        if (typeMatch) {
            const rawType = typeMatch[1].toUpperCase();
            if (['FIX', 'PLAN', 'NEED_FILES', 'NEED_COMMAND', 'ASK_USER', 'DIAGNOSIS'].includes(rawType)) {
                type = rawType as BrainReplyType;
            }
            break;
        }

        // Alternative heuristic if TYPE is not explicitly on the very first line
        if (/^===FILE:/i.test(trimmed) || /^===EDIT:/i.test(trimmed)) {
            type = 'FIX';
            warnings.push('Implicit TYPE: FIX detected from file block marker.');
            break;
        }
    }

    // 3. Extract STEP, QUESTION, NEED_*
    for (const line of allLines) {
        const trimmed = line.trim();
        const stepMatch = trimmed.match(/^STEP:\s*(\d+)?\s*(?:-\s*(.*))?$/i);
        if (stepMatch) {
            if (stepMatch[1]) stepNo = parseInt(stepMatch[1], 10);
            if (stepMatch[2]) stepTitle = stepMatch[2].trim();
        }

        const qMatch = trimmed.match(/^QUESTION:\s*(.+)$/i);
        if (qMatch) question = qMatch[1].trim();

        const nfMatch = trimmed.match(/^NEED_FILES:\s*(.+)$/i);
        if (nfMatch) {
            const files = nfMatch[1].split(',').map(s => s.trim()).filter(Boolean);
            needFiles.push(...files);
        }

        const ncMatch = trimmed.match(/^NEED_COMMAND:\s*(.+)$/i);
        if (ncMatch) {
            needCommands.push(ncMatch[1].trim());
        }
    }

    // 4. Extract MANIFEST
    const manifest: string[] = [];
    let inManifest = false;
    let declaredManifestCount: number | null = null;

    for (let i = 0; i < allLines.length; i++) {
        const line = allLines[i].trim();
        const manMatch = line.match(/^MANIFEST:\s*(\d+)/i);
        if (manMatch) {
            declaredManifestCount = parseInt(manMatch[1], 10);
            inManifest = true;
            continue;
        }

        if (inManifest) {
            if (line.startsWith('- ') || line.startsWith('* ')) {
                const p = line.slice(2).trim();
                const sanitized = sanitizeProtocolPath(p, warnings);
                if (sanitized) manifest.push(sanitized);
            } else if (line.startsWith('===') || line.startsWith('STEP:') || line.startsWith('TYPE:')) {
                inManifest = false;
            }
        }
    }

    if (declaredManifestCount !== null && manifest.length !== declaredManifestCount) {
        warnings.push(`Manifest count mismatch: declared ${declaredManifestCount}, found ${manifest.length}`);
    }

    // 5. Parse Blocks: FILE, EDIT, COMMANDS, VERIFY, NEXT_PLANNED
    const files: ParsedFile[] = [];
    const edits: ParsedEdit[] = [];
    const commands: string[] = [];
    const verify: string[] = [];
    let nextPlanned: string | undefined;

    let idx = 0;
    while (idx < allLines.length) {
        const line = allLines[idx];
        const trimmed = line.trim();

        // Check NEXT_PLANNED:
        const npMatch = trimmed.match(/^NEXT_PLANNED:\s*(.+)$/i);
        if (npMatch) {
            nextPlanned = npMatch[1].trim();
            idx++;
            continue;
        }

        // Check ===FILE: path===
        const fileMatch = trimmed.match(/^===FILE:\s*(.+?)===\s*$/);
        if (fileMatch) {
            const rawPath = fileMatch[1];
            const sanitizedPath = sanitizeProtocolPath(rawPath, warnings);
            idx++;

            const contentLines: string[] = [];
            let complete = false;

            while (idx < allLines.length) {
                const cur = allLines[idx];
                const curTrimmed = cur.trim();
                if (curTrimmed === '===END FILE===') {
                    complete = true;
                    idx++;
                    break;
                }
                // Check if an unclosed block hits the next block marker
                if (/^===(?:FILE:|EDIT:|COMMANDS|VERIFY|END OF RESPONSE)/.test(curTrimmed)) {
                    warnings.push(`Missing ===END FILE=== for '${rawPath}' before next block marker`);
                    break;
                }
                contentLines.push(cur);
                idx++;
            }

            if (!complete) {
                warnings.push(`File '${rawPath}' was truncated or missing ===END FILE===`);
            }

            let fileContent = contentLines.join('\n');
            fileContent = unwrapSingleOuterFence(fileContent);

            if (sanitizedPath) {
                files.push({
                    path: sanitizedPath,
                    content: fileContent,
                    complete
                });
            }
            continue;
        }

        // Check ===EDIT: path===
        const editMatch = trimmed.match(/^===EDIT:\s*(.+?)===\s*$/);
        if (editMatch) {
            const rawPath = editMatch[1];
            const sanitizedPath = sanitizeProtocolPath(rawPath, warnings);
            idx++;

            const editLines: string[] = [];
            let complete = false;

            while (idx < allLines.length) {
                const cur = allLines[idx];
                const curTrimmed = cur.trim();
                if (curTrimmed === '===END EDIT===') {
                    complete = true;
                    idx++;
                    break;
                }
                if (/^===(?:FILE:|EDIT:|COMMANDS|VERIFY|END OF RESPONSE)/.test(curTrimmed)) {
                    warnings.push(`Missing ===END EDIT=== for '${rawPath}' before next block marker`);
                    break;
                }
                editLines.push(cur);
                idx++;
            }

            const parsedBlocks = parseSearchReplaceBlocks(editLines.join('\n'), warnings);
            if (!complete || parsedBlocks.hasError) {
                complete = false;
                warnings.push(`Edit block for '${rawPath}' incomplete or ill-formed`);
            }

            if (sanitizedPath) {
                edits.push({
                    path: sanitizedPath,
                    blocks: parsedBlocks.blocks,
                    complete
                });
            }
            continue;
        }

        // Check ===COMMANDS===
        if (trimmed === '===COMMANDS===') {
            idx++;
            while (idx < allLines.length) {
                const cur = allLines[idx];
                const curTrimmed = cur.trim();
                if (curTrimmed === '===END COMMANDS===') {
                    idx++;
                    break;
                }
                if (/^===(?:FILE:|EDIT:|COMMANDS|VERIFY|END OF RESPONSE)/.test(curTrimmed)) {
                    break;
                }
                if (curTrimmed && !curTrimmed.startsWith('#')) {
                    const cleanCmd = curTrimmed.replace(/^(?:\$|>|PS>)\s*/, '').replace(/^`|`$/g, '').trim();
                    if (cleanCmd) commands.push(cleanCmd);
                }
                idx++;
            }
            continue;
        }

        // Check ===VERIFY===
        if (trimmed === '===VERIFY===') {
            idx++;
            while (idx < allLines.length) {
                const cur = allLines[idx];
                const curTrimmed = cur.trim();
                if (curTrimmed === '===END VERIFY===') {
                    idx++;
                    break;
                }
                if (/^===(?:FILE:|EDIT:|COMMANDS|VERIFY|END OF RESPONSE)/.test(curTrimmed)) {
                    break;
                }
                if (curTrimmed && !curTrimmed.startsWith('#')) {
                    const cleanCmd = curTrimmed.replace(/^(?:\$|>|PS>)\s*/, '').replace(/^`|`$/g, '').trim();
                    if (cleanCmd) verify.push(cleanCmd);
                }
                idx++;
            }
            continue;
        }

        idx++;
    }

    return {
        type,
        stepNo,
        stepTitle,
        manifest,
        files,
        edits,
        commands,
        verify,
        nextPlanned,
        needFiles,
        needCommands,
        question,
        text,
        hasEndMarker,
        warnings
    };
}

/**
 * Parses one or more SEARCH / REPLACE blocks within an EDIT body.
 */
function parseSearchReplaceBlocks(
    body: string,
    warnings: string[]
): { blocks: EditBlock[]; hasError: boolean } {
    const blocks: EditBlock[] = [];
    const lines = body.split('\n');

    let state: 'IDLE' | 'SEARCH' | 'REPLACE' = 'IDLE';
    let currentSearch: string[] = [];
    let currentReplace: string[] = [];
    let hasError = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (/^<{5,9}\s*SEARCH\s*$/.test(trimmed)) {
            if (state !== 'IDLE') {
                warnings.push('Nested SEARCH marker detected');
                hasError = true;
            }
            state = 'SEARCH';
            currentSearch = [];
            currentReplace = [];
            continue;
        }

        if (/^={5,9}\s*$/.test(trimmed)) {
            if (state !== 'SEARCH') {
                warnings.push('Unexpected ======= divider outside SEARCH block');
                hasError = true;
            }
            state = 'REPLACE';
            continue;
        }

        if (/^>{5,9}\s*REPLACE\s*$/.test(trimmed)) {
            if (state !== 'REPLACE') {
                warnings.push('Unexpected >>>>>>> REPLACE marker outside REPLACE block');
                hasError = true;
            } else {
                blocks.push({
                    search: currentSearch.join('\n'),
                    replace: currentReplace.join('\n')
                });
            }
            state = 'IDLE';
            continue;
        }

        if (state === 'SEARCH') {
            currentSearch.push(line);
        } else if (state === 'REPLACE') {
            currentReplace.push(line);
        }
    }

    if (state !== 'IDLE') {
        warnings.push('Unterminated SEARCH/REPLACE block');
        hasError = true;
    }

    return { blocks, hasError };
}
