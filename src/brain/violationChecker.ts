import { ParsedReply } from './protocolParser';
import { ModelProfile } from '../config/modelProfile';

export type ViolationCode =
    | 'TOO_MANY_FILES'
    | 'TOO_MANY_COMMANDS'
    | 'FILE_TOO_LONG'
    | 'MANIFEST_MISMATCH'
    | 'MISSING_FILES'
    | 'TRUNCATED'
    | 'NO_TYPE'
    | 'PLACEHOLDER'
    | 'TOO_MANY_EDITS'
    | 'UNSAFE_PATH'
    | 'SECRET_IN_REPLY';

export interface Violation {
    code: ViolationCode;
    detail: string;
    paths?: string[];
}

const PLACEHOLDER_PATTERNS: RegExp[] = [
    /\/\/\s*\.\.\.\s*existing\s+code/i,
    /\/\/\s*\.\.\.\s*rest\s+of/i,
    /\/\/\s*\.\.\.\s*unchanged/i,
    /#\s*\.\.\.\s*existing\s+code/i,
    /#\s*rest\s+of\s+the\s+file/i,
    /#\s*\.\.\.\s*remaining\s+code/i,
    /<!--\s*rest\s*-->/i,
    /\(remaining code unchanged\)/i
];

/**
 * Checks a ParsedReply against model capacity limits and protocol completeness.
 */
export function checkReply(reply: ParsedReply, profile: ModelProfile): Violation[] {
    const violations: Violation[] = [];

    // 1. Check message type
    if (reply.type === 'UNKNOWN') {
        violations.push({
            code: 'NO_TYPE',
            detail: 'Response did not specify a valid TYPE: header.'
        });
    }

    // Only FIX replies are subject to file/command execution rules
    if (reply.type !== 'FIX') {
        return violations;
    }

    // 2. Check Truncation & End Marker
    if (!reply.hasEndMarker) {
        violations.push({
            code: 'TRUNCATED',
            detail: 'Response ended without ===END OF RESPONSE=== marker.'
        });
    }

    const incompleteFiles = reply.files.filter(f => !f.complete).map(f => f.path);
    const incompleteEdits = reply.edits.filter(e => !e.complete).map(e => e.path);
    const allIncomplete = [...incompleteFiles, ...incompleteEdits];
    if (allIncomplete.length > 0) {
        violations.push({
            code: 'TRUNCATED',
            detail: `One or more file blocks were cut off or incomplete: ${allIncomplete.join(', ')}`,
            paths: allIncomplete
        });
    }

    // 3. Check Manifest consistency
    if (reply.manifest.length > 0) {
        const providedPaths = new Set([...reply.files.map(f => f.path), ...reply.edits.map(e => e.path)]);
        const missing = reply.manifest.filter(p => !providedPaths.has(p));
        if (missing.length > 0) {
            violations.push({
                code: 'MISSING_FILES',
                detail: `Manifest declared files that were missing from response blocks: ${missing.join(', ')}`,
                paths: missing
            });
        }
    }

    // 4. File counts against profile
    const totalFilesGiven = reply.files.length + reply.edits.length;
    if (totalFilesGiven > profile.maxFilesPerStep) {
        violations.push({
            code: 'TOO_MANY_FILES',
            detail: `Response provided ${totalFilesGiven} files/edits; maximum allowed per step is ${profile.maxFilesPerStep}.`
        });
    }

    // 5. Commands count against profile
    if (reply.commands.length > profile.maxCommandsPerStep) {
        violations.push({
            code: 'TOO_MANY_COMMANDS',
            detail: `Response provided ${reply.commands.length} commands; maximum allowed per step is ${profile.maxCommandsPerStep}.`
        });
    }

    // 6. Max edits per file
    for (const edit of reply.edits) {
        if (edit.blocks.length > profile.maxEditsPerFile) {
            violations.push({
                code: 'TOO_MANY_EDITS',
                detail: `File '${edit.path}' has ${edit.blocks.length} edit blocks; maximum allowed is ${profile.maxEditsPerFile}.`,
                paths: [edit.path]
            });
        }
    }

    // 7. File length and Placeholder check
    const limitLines = profile.writeMode === 'model' ? profile.modelWriteLimitLines : profile.maxLinesPerFile;
    for (const file of reply.files) {
        const lineCount = file.content.split('\n').length;
        if (lineCount > limitLines) {
            violations.push({
                code: 'FILE_TOO_LONG',
                detail: `File '${file.path}' has ${lineCount} lines; maximum allowed is ${limitLines}.`,
                paths: [file.path]
            });
        }

        for (const pat of PLACEHOLDER_PATTERNS) {
            if (pat.test(file.content)) {
                violations.push({
                    code: 'PLACEHOLDER',
                    detail: `File '${file.path}' contains lazy placeholder comments. Complete files are required.`,
                    paths: [file.path]
                });
                break;
            }
        }
    }

    return violations;
}
