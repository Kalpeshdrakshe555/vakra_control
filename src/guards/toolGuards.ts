import * as fs from 'fs';
import * as path from 'path';
import { splitSequence } from '../platform/commandSequence';
import { isSecretPath } from '../security/secretsFilter';
import { validateProjectRules } from './projectRules';
import { LoopDetector } from './loopDetector';

export type GuardCode =
    | 'SERVER_BLOCKED'
    | 'FILE_WRITE_VIA_SHELL'
    | 'OVERWRITE_SHRINK'
    | 'PATH_ESCAPE'
    | 'STRUCTURE_VIOLATION'
    | 'DESTRUCTIVE_COMMAND'
    | 'SECRET_FILE'
    | 'LOOP_REPEAT';

export type GuardDecision =
    | { allow: true; note?: string }
    | { allow: false; code: GuardCode; reason: string; hint: string };

export interface GuardContext {
    workspaceRoot: string;
    loopDetector?: LoopDetector;
    destination?: 'local' | 'web';
    blockServers?: boolean;
}

const SERVER_PATTERNS: RegExp[] = [
    /\bmanage\.py\s+runserver\b/i,
    /\bflask\s+run\b/i,
    /\buvicorn\b/i,
    /\bgunicorn\b/i,
    /\bpython\s+-m\s+http\.server\b/i,
    /\bnpm\s+(?:run\s+)?(?:start|dev|serve)\b/i,
    /\byarn\s+(?:start|dev)\b/i,
    /\bpnpm\s+(?:start|dev)\b/i,
    /\bvite\b(?!\s+build\b)/i,
    /\bnext\s+dev\b/i,
    /\bng\s+serve\b/i,
    /\bnodemon\b/i,
    /\bphp\s+artisan\s+serve\b/i,
    /\brails\s+(?:s|server)\b/i,
    /\blive-server\b/i
];

const SHELL_WRITE_PATTERNS: RegExp[] = [
    /<<\s*['"]?[a-zA-Z0-9_]+['"]?/, // heredoc
    /\bcat\s*>{1,2}/i,
    /\becho\s+.*>{1,2}\s*[^&|;]+/i,
    /\bprintf\s+.*>{1,2}\s*[^&|;]+/i,
    /\btee\s+/i,
    /\b(?:Set-Content|Add-Content|Out-File|New-Item\s+-Value)\b/i
];

const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
    /\brm\s+-(?:rf|fr|r)\b/i,
    /\bdel\s+(?:\/s|\/q)\b/i,
    /\brmdir\s+(?:\/s|\/q)\b/i,
    /\bRemove-Item\s+.*-Recurse\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-(?:f|fd|fx)\b/i,
    /\bformat\s+[a-zA-Z]:/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bdrop\s+database\b/i
];

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
 * Checks tools against safety invariants before execution.
 */
export function guardTool(call: { name: string; args: any }, ctx: GuardContext): GuardDecision {
    const { name, args } = call;
    const { workspaceRoot } = ctx;

    // 0. Check Loop Detector
    if (ctx.loopDetector) {
        const argsHash = LoopDetector.hashArgs(args);
        const loopCheck = ctx.loopDetector.check({ tool: name, argsHash });
        if (loopCheck.repeat) {
            return {
                allow: false,
                code: 'LOOP_REPEAT',
                reason: 'Repeated identical tool call without state change',
                hint: loopCheck.message || 'Proceed to the next task instead of repeating the same action.'
            };
        }
    }

    // 1. Terminal / Shell command guard
    if (name === 'run_in_terminal' || name === 'execute_terminal_command') {
        const cmd = (args?.command || '').trim();
        const segments = splitSequence(cmd);

        for (const seg of segments) {
            // A. Destructive command check
            for (const pat of DESTRUCTIVE_COMMAND_PATTERNS) {
                if (pat.test(seg)) {
                    return {
                        allow: false,
                        code: 'DESTRUCTIVE_COMMAND',
                        reason: `Command contains potentially destructive operation: '${seg}'`,
                        hint: 'Destructive filesystem commands are blocked. Ask the user for confirmation if required.'
                    };
                }
            }

            // B. Long-running server block
            if (ctx.blockServers !== false) {
                for (const pat of SERVER_PATTERNS) {
                    if (pat.test(seg)) {
                        return {
                            allow: false,
                            code: 'SERVER_BLOCKED',
                            reason: `Command starts a persistent background server: '${seg}'`,
                            hint: 'Do not start persistent dev servers. Verify functionality using non-blocking check commands, build commands, or test scripts.'
                        };
                    }
                }
            }

            // C. File write via shell redirection
            for (const pat of SHELL_WRITE_PATTERNS) {
                if (pat.test(seg)) {
                    // Check if redirect is merely to /dev/null or NUL
                    if (/>\s*(?:\/dev\/null|NUL|\$null)\b/i.test(seg)) {
                        continue;
                    }
                    return {
                        allow: false,
                        code: 'FILE_WRITE_VIA_SHELL',
                        reason: `Shell file-writing command detected: '${seg}'`,
                        hint: 'Write files with the write_file/edit_file tool, never through terminal redirection.'
                    };
                }
            }
        }
    }

    // 2. File Path Escape and Secret File Checks
    const filepath = args?.filepath || args?.path || (Array.isArray(args?.filepaths) ? args.filepaths[0] : undefined);
    if (filepath && typeof filepath === 'string') {
        const normPath = filepath.trim();
        
        // Prevent path traversal outside workspace
        if (workspaceRoot) {
            const resolved = path.resolve(workspaceRoot, normPath);
            const rel = path.relative(workspaceRoot, resolved);
            if (rel.startsWith('..') || path.isAbsolute(rel) || (path.isAbsolute(normPath) && !resolved.startsWith(workspaceRoot))) {
                return {
                    allow: false,
                    code: 'PATH_ESCAPE',
                    reason: `Target path '${normPath}' resolves outside workspace root.`,
                    hint: 'Operate strictly within the workspace directory tree.'
                };
            }

            // Secret file check if destined for web
            if (ctx.destination === 'web' && isSecretPath(rel)) {
                return {
                    allow: false,
                    code: 'SECRET_FILE',
                    reason: `Access to sensitive credential/environment file '${normPath}' is blocked.`,
                    hint: 'Never read or transmit sensitive secret files to external AI models.'
                };
            }

            // Project Structure rules check
            const structCheck = validateProjectRules(rel, workspaceRoot);
            if (!structCheck.ok) {
                return {
                    allow: false,
                    code: 'STRUCTURE_VIOLATION',
                    reason: structCheck.message || 'Workspace architecture structure rule violation.',
                    hint: 'Follow the required folder hierarchy in project_rules.json.'
                };
            }
        }
    }

    // 3. Write / Edit Placeholder and Catastrophic Shrink Check
    if (name === 'write_file') {
        const content = String(args?.content || '');
        const targetFile = args?.filepath;

        // Check for lazy placeholders
        for (const pat of PLACEHOLDER_PATTERNS) {
            if (pat.test(content)) {
                return {
                    allow: false,
                    code: 'OVERWRITE_SHRINK',
                    reason: 'File content contains lazy placeholder comments (e.g. "// ... existing code ...").',
                    hint: 'Provide the complete, unabbreviated file or use edit_file with precise SEARCH/REPLACE blocks.'
                };
            }
        }

        // Catastrophic shrink check
        if (targetFile && workspaceRoot && !args?.allowShrink) {
            const resolved = path.resolve(workspaceRoot, targetFile);
            if (fs.existsSync(resolved)) {
                try {
                    const oldContent = fs.readFileSync(resolved, 'utf8');
                    const oldLines = oldContent.split('\n').length;
                    if (oldLines > 30 && content.length < 0.6 * oldContent.length) {
                        return {
                            allow: false,
                            code: 'OVERWRITE_SHRINK',
                            reason: `Write would delete ${Math.round((1 - content.length / oldContent.length) * 100)}% of existing ${oldLines}-line file.`,
                            hint: 'Overwriting most of an existing file is blocked. Use edit_file for partial updates, or specify allowShrink: true if intended.'
                        };
                    }
                } catch {
                    // Ignore stat read failure
                }
            }
        }
    }

    return { allow: true };
}
