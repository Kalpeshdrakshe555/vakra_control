import * as fs from 'fs';
import * as path from 'path';
import { runProcess } from './process';

export type PythonSource = 'setting' | 'venv' | 'system';

export interface ResolvedPythonSuccess {
    ok: true;
    exe: string;
    preArgs: string[];
    source: PythonSource;
    version?: string;
}

export interface ResolvedPythonFailure {
    ok: false;
    hint: string;
}

export type ResolvedPython = ResolvedPythonSuccess | ResolvedPythonFailure;

// In-memory cache for Python interpreter lookups per path
const pythonCache = new Map<string, ResolvedPythonSuccess>();

/**
 * Resolves a reliable Python interpreter path for the project.
 * Checks user setting -> project virtualenv -> system python3/python/py launcher.
 */
export async function resolvePython(
    workspaceRoot: string,
    projectDir?: string,
    userSettingPythonPath?: string
): Promise<ResolvedPython> {
    const cacheKey = `${workspaceRoot}::${projectDir || ''}::${userSettingPythonPath || ''}`;
    if (pythonCache.has(cacheKey)) {
        return pythonCache.get(cacheKey)!;
    }

    const isWindows = process.platform === 'win32';

    // 1. Check user configured python path
    if (userSettingPythonPath && userSettingPythonPath.trim()) {
        const candidate = userSettingPythonPath.trim();
        const testRes = await verifyPython(candidate, []);
        if (testRes.ok) {
            const success: ResolvedPythonSuccess = {
                ok: true,
                exe: candidate,
                preArgs: [],
                source: 'setting',
                version: testRes.version
            };
            pythonCache.set(cacheKey, success);
            return success;
        }
    }

    // 2. Check virtual environments in projectDir, then workspaceRoot
    const dirsToCheck = [projectDir, workspaceRoot].filter((d): d is string => !!d && fs.existsSync(d));
    const venvNames = ['venv', '.venv', 'env', '.env_py'];

    for (const dir of dirsToCheck) {
        for (const venvName of venvNames) {
            const venvPath = path.join(dir, venvName);
            if (!fs.existsSync(venvPath)) continue;

            const candidateExe = isWindows
                ? path.join(venvPath, 'Scripts', 'python.exe')
                : path.join(venvPath, 'bin', 'python');

            if (fs.existsSync(candidateExe)) {
                const testRes = await verifyPython(candidateExe, []);
                if (testRes.ok) {
                    const success: ResolvedPythonSuccess = {
                        ok: true,
                        exe: candidateExe,
                        preArgs: [],
                        source: 'venv',
                        version: testRes.version
                    };
                    pythonCache.set(cacheKey, success);
                    return success;
                }
            }
        }
    }

    // 3. Check system Python candidates
    const systemCandidates: Array<{ exe: string; preArgs: string[] }> = [
        { exe: 'python3', preArgs: [] },
        { exe: 'python', preArgs: [] }
    ];

    if (isWindows) {
        systemCandidates.push({ exe: 'py', preArgs: ['-3'] });
        systemCandidates.push({ exe: 'py', preArgs: [] });
    }

    for (const cand of systemCandidates) {
        const testRes = await verifyPython(cand.exe, cand.preArgs);
        if (testRes.ok) {
            const success: ResolvedPythonSuccess = {
                ok: true,
                exe: cand.exe,
                preArgs: cand.preArgs,
                source: 'system',
                version: testRes.version
            };
            pythonCache.set(cacheKey, success);
            return success;
        }
    }

    return {
        ok: false,
        hint: 'No working Python interpreter found. Please install Python or set the pythonPath setting in Vakra settings.'
    };
}

async function verifyPython(exe: string, preArgs: string[]): Promise<{ ok: boolean; version?: string }> {
    try {
        const res = await runProcess({
            exe,
            args: [...preArgs, '--version'],
            timeoutMs: 5000
        });

        if (res.ok) {
            const rawVer = (res.stdout || res.stderr).trim();
            return { ok: true, version: rawVer };
        }
    } catch {
        // Failed candidate
    }
    return { ok: false };
}

/**
 * Clears the python resolution cache (e.g. when environment changes).
 */
export function clearPythonCache(): void {
    pythonCache.clear();
}
