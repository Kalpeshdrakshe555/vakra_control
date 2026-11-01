import * as fs from 'fs';
import * as path from 'path';
import { runProcess, ProcessResult } from './process';
import { resolvePython } from './python';
import { cleanOutput } from './output';
import { scanEnvironment } from './envScanner';

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
    signal?: AbortSignal;
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

            // Check '||' (Split so PowerShell 5.1 doesn't throw syntax error)
            if (ch === '|' && next === '|') {
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
        if (options?.signal?.aborted) {
            return {
                ok: false,
                results,
                failingSegment: segment,
                finalCwd: currentCwd,
                combinedOutput: cleanOutput(results.map(r => r.output).join('\n') + '\nProcess cancelled by abort signal')
            };
        }

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

    // 0. Guard against terminal file writing via python one-liners (causes Windows shell quote corruption)
    if (/python(?:\.exe)?\s+-c\s+["']open\(.+?\)\.write\(/i.test(segment)) {
        return {
            segment,
            cwd,
            ok: false,
            exitCode: 1,
            output: '[GUARD BLOCKED]: Writing code files via terminal python one-liners is prohibited because shell quote escaping corrupts code on Windows. Use the official write_file or edit_file tool instead.',
            durationMs: 1
        };
    }

    // 0b. Transparently handle activation commands as successful no-ops because venv is auto-bound
    if (/^\s*(?:source\s+)?(?:\.\/|\.\\)?(?:\.venv|venv|env)[\\/](?:bin|scripts)[\\/]activate(?:\.bat|\.ps1)?\s*$/i.test(segment) ||
        /^\s*(?:activate|deactivate)\s*$/i.test(segment)) {
        return {
            segment,
            cwd,
            ok: true,
            exitCode: 0,
            output: 'Virtual environment auto-bound to execution context.',
            durationMs: 1
        };
    }

    // Prepare execution environment with workspace .venv auto-bound to PATH
    const effectiveEnv: NodeJS.ProcessEnv = { ...(options?.env || process.env) };
    const envSnap = scanEnvironment(workspaceRoot);
    if (envSnap.venvBinDir && fs.existsSync(envSnap.venvBinDir)) {
        const pathKey = isWindows
            ? (Object.keys(effectiveEnv).find(k => k.toLowerCase() === 'path') || 'Path')
            : 'PATH';
        const currentPath = effectiveEnv[pathKey] || '';
        if (!currentPath.split(path.delimiter).includes(envSnap.venvBinDir)) {
            effectiveEnv[pathKey] = `${envSnap.venvBinDir}${path.delimiter}${currentPath}`;
        }
        if (envSnap.venvPath) {
            effectiveEnv['VIRTUAL_ENV'] = envSnap.venvPath;
        }
    }

    // If python command is used on Windows, transparently map to resolved python (venv or py)
    let processedSegment = segment;
    if (isWindows) {
        if (/^(?:python|python3|py)(\.exe)?(\s|$)/i.test(segment)) {
            const resolved = await resolvePython(workspaceRoot, cwd);
            if (resolved.ok) {
                const remainder = segment.replace(/^(?:python|python3|py)(\.exe)?/i, '').trim();
                const preArgStr = resolved.preArgs.length > 0 ? resolved.preArgs.join(' ') + ' ' : '';
                processedSegment = `& "${resolved.exe}" ${preArgStr}${remainder}`;
            }
        } else if (/^\s*rm\s+-(?:rf|fr|r)\s+(.+)$/i.test(processedSegment)) {
            // Translate POSIX rm -rf to PowerShell Remove-Item
            const target = processedSegment.replace(/^\s*rm\s+-(?:rf|fr|r)\s+/i, '').trim();
            processedSegment = `if (Test-Path ${target}) { Remove-Item -Recurse -Force ${target} }`;
        } else if (/^\s*mkdir\s+-p\s+(.+)$/i.test(processedSegment)) {
            // Translate POSIX mkdir -p to PowerShell New-Item
            const target = processedSegment.replace(/^\s*mkdir\s+-p\s+/i, '').trim();
            processedSegment = `New-Item -ItemType Directory -Force -Path ${target}`;
        } else if (/^\s*cat\s+(.+)$/i.test(processedSegment)) {
            // Translate cat to Get-Content
            const target = processedSegment.replace(/^\s*cat\s+/i, '').trim();
            processedSegment = `Get-Content ${target}`;
        } else if (/^\s*export\s+([A-Za-z0-9_]+)\s*=\s*(.+)$/i.test(processedSegment)) {
            // Translate export VAR=val to $env:VAR="val"
            const m = processedSegment.match(/^\s*export\s+([A-Za-z0-9_]+)\s*=\s*(.+)$/i);
            if (m) {
                processedSegment = `$env:${m[1]} = ${m[2]}`;
            }
        } else if (/^\s*touch\s+(.+)$/i.test(processedSegment)) {
            // Translate POSIX touch to PowerShell New-Item -ItemType File
            const target = processedSegment.replace(/^\s*touch\s+/i, '').trim();
            processedSegment = `New-Item -ItemType File -Force -Path ${target}`;
        }

        // Translate Unix pipe head to PowerShell Select-Object -First
        if (/\|\s*head\b/i.test(processedSegment)) {
            processedSegment = processedSegment.replace(/\|\s*head(?:\s+-n|\s+-)?\s*(\d+)/gi, '| Select-Object -First $1');
            processedSegment = processedSegment.replace(/\|\s*head\b/gi, '| Select-Object -First 10');
        }

        // Strip trailing or piped 2>&1 on Windows (prevents PowerShell NativeCommandError on innocent stderr)
        if (/\s+2>&1(?:\s*\||$)/.test(processedSegment)) {
            processedSegment = processedSegment.replace(/\s+2>&1(?=\s*\||$)/g, '');
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
        env: effectiveEnv,
        timeoutMs: options?.timeoutMs ?? 60000,
        maxOutputBytes: options?.maxOutputBytes ?? 1024 * 1024,
        signal: options?.signal
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
