import * as fs from 'fs';
import * as path from 'path';
import { runProcess, ProcessResult } from './process';
import { resolvePython } from './python';
import { cleanOutput } from './output';

export interface SegmentResult {
    segment: string;
    cwd: string;
    ok: boolean;
    exitCode: number | null;
    output: string;
    durationMs: number;
}

export interface SequenceResult {
    ok: boolean;
    results: SegmentResult[];
    failingSegment?: string;
    finalCwd: string;
    combinedOutput: string;
}

export interface CommandSequenceOptions {
    workspaceRoot?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    env?: NodeJS.ProcessEnv;
    onSegmentStart?: (segment: string, cwd: string) => void;
}

/**
 * Splits a compound command string into individual sequential segments on '&&' or ';',
 * strictly respecting quotes (single, double) and escapes.
 * Does NOT split on '||'.
 */
export function splitSequence(cmd: string): string[] {
    if (!cmd || !cmd.trim()) return [];

    const segments: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;

    let i = 0;
    while (i < cmd.length) {
        const ch = cmd[i];
        const next = i + 1 < cmd.length ? cmd[i + 1] : '';

        // Handle escape character \ inside double quotes or outside quotes
        if (ch === '\\' && !inSingleQuote) {
            current += ch;
            if (next) {
                current += next;
                i += 2;
                continue;
            }
        }

        // Toggle quote states
        if (ch === "'" && !inDoubleQuote && !inBacktick) {
            inSingleQuote = !inSingleQuote;
            current += ch;
            i++;
            continue;
        }

        if (ch === '"' && !inSingleQuote && !inBacktick) {
            inDoubleQuote = !inDoubleQuote;
            current += ch;
            i++;
            continue;
        }

        if (ch === '`' && !inSingleQuote && !inDoubleQuote) {
            inBacktick = !inBacktick;
            current += ch;
            i++;
            continue;
        }

        // If outside quotes, check delimiters
        if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
            // Check '&&'
            if (ch === '&' && next === '&') {
                const trimmed = current.trim();
                if (trimmed) segments.push(trimmed);
                current = '';
                i += 2;
                continue;
            }

            // Check ';'
            if (ch === ';') {
                const trimmed = current.trim();
                if (trimmed) segments.push(trimmed);
                current = '';
                i++;
                continue;
            }
        }

        current += ch;
        i++;
    }

    const lastTrimmed = current.trim();
    if (lastTrimmed) {
        segments.push(lastTrimmed);
    }

    return segments;
}

/**
 * Runs a list of command segments sequentially with in-process CWD tracking and platform-appropriate shells.
 */
export async function runCommandSequence(
    cmd: string,
    initialCwd: string,
    options?: CommandSequenceOptions
): Promise<SequenceResult> {
    const segments = splitSequence(cmd);
    const results: SegmentResult[] = [];
    let currentCwd = initialCwd;
    const workspaceRoot = options?.workspaceRoot || initialCwd;

    for (const segment of segments) {
        options?.onSegmentStart?.(segment, currentCwd);

        // 1. In-process 'cd' handler
        const cdMatch = segment.match(/^cd\s+(.+)$/i);
        if (cdMatch) {
            let targetDir = cdMatch[1].trim();
            // Strip surrounding quotes if present
            if ((targetDir.startsWith('"') && targetDir.endsWith('"')) ||
                (targetDir.startsWith("'") && targetDir.endsWith("'"))) {
                targetDir = targetDir.slice(1, -1);
            }

            const resolvedTarget = path.resolve(currentCwd, targetDir);
            if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()) {
                currentCwd = resolvedTarget;
                results.push({
                    segment,
                    cwd: currentCwd,
                    ok: true,
                    exitCode: 0,
                    output: `Changed directory to: ${currentCwd}`,
                    durationMs: 1
                });
                continue;
            } else {
                results.push({
                    segment,
                    cwd: currentCwd,
                    ok: false,
                    exitCode: 1,
                    output: `Error: directory not found: ${targetDir}`,
                    durationMs: 1
                });
                return {
                    ok: false,
                    results,
                    failingSegment: segment,
                    finalCwd: currentCwd,
                    combinedOutput: cleanOutput(results.map(r => r.output).join('\n'))
                };
            }
        }

        // 2. Execute command segment
        const segRes = await executeSingleSegment(segment, currentCwd, workspaceRoot, options);
        results.push(segRes);

        if (!segRes.ok) {
            return {
                ok: false,
                results,
                failingSegment: segment,
                finalCwd: currentCwd,
                combinedOutput: cleanOutput(results.map(r => r.output).join('\n'))
            };
        }
    }

    return {
        ok: true,
        results,
        finalCwd: currentCwd,
        combinedOutput: cleanOutput(results.map(r => r.output).join('\n'))
    };
}

async function executeSingleSegment(
    segment: string,
    cwd: string,
    workspaceRoot: string,
    options?: CommandSequenceOptions
): Promise<SegmentResult> {
    const startTime = Date.now();
    const isWindows = process.platform === 'win32';

    // If python command is used on Windows, transparently map to resolved python (venv or py)
    let processedSegment = segment;
    if (isWindows && /^(?:python|python3|py)(\.exe)?(\s|$)/i.test(segment)) {
        const resolved = await resolvePython(workspaceRoot, cwd);
        if (resolved.ok) {
            const remainder = segment.replace(/^(?:python|python3|py)(\.exe)?/i, '').trim();
            const preArgStr = resolved.preArgs.length > 0 ? resolved.preArgs.join(' ') + ' ' : '';
            processedSegment = `& "${resolved.exe}" ${preArgStr}${remainder}`;
        }
    }

    // Run via platform shell for robustness with pipes, redirects, and environment expansion
    let shellExe: string;
    let shellArgs: string[];

    if (isWindows) {
        shellExe = 'powershell.exe';
        shellArgs = ['-NoProfile', '-NonInteractive', '-Command', processedSegment];
    } else {
        shellExe = '/bin/sh';
        shellArgs = ['-c', processedSegment];
    }

    const res: ProcessResult = await runProcess({
        exe: shellExe,
        args: shellArgs,
        cwd,
        env: options?.env,
        timeoutMs: options?.timeoutMs ?? 60000,
        maxOutputBytes: options?.maxOutputBytes ?? 1024 * 1024
    });

    const rawOutput = (res.stdout || '') + (res.stderr ? '\n' + res.stderr : '');
    const cleaned = cleanOutput(rawOutput);

    return {
        segment,
        cwd,
        ok: res.ok,
        exitCode: res.exitCode,
        output: cleaned,
        durationMs: Date.now() - startTime
    };
}

/**
 * Finds project anchor directory (manage.py, package.json, Cargo.toml, etc.) up to maxDepth 3.
 */
export function findProjectAnchorDir(startDir: string, maxDepth: number = 3): string | null {
    const anchorFiles = [
        'manage.py',
        'package.json',
        'Cargo.toml',
        'pyproject.toml',
        'pom.xml',
        'build.gradle',
        'go.mod'
    ];

    const ignoredDirs = new Set(['node_modules', 'venv', '.venv', 'env', '.git', 'dist', 'build', '__pycache__']);

    function scan(dir: string, depth: number): string | null {
        if (depth > maxDepth) return null;

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() && anchorFiles.includes(entry.name)) {
                    return dir;
                }
            }

            for (const entry of entries) {
                if (entry.isDirectory() && !ignoredDirs.has(entry.name) && !entry.name.startsWith('.')) {
                    const found = scan(path.join(dir, entry.name), depth + 1);
                    if (found) return found;
                }
            }
        } catch {
            // Ignore access errors
        }
        return null;
    }

    return scan(startDir, 0);
}
