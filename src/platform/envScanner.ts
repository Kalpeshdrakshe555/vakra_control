// src/platform/envScanner.ts
// Ultra-fast (<30ms) runtime environment scanner.
// Provides empirical snapshot of OS, Shell, VirtualEnvs, and installed framework versions.

import * as fs from 'fs';
import * as path from 'path';

export interface EnvironmentSnapshot {
    os: 'windows' | 'linux' | 'darwin';
    osName: string;
    shell: string;
    venvPath?: string;
    venvBinDir?: string;
    pythonExe?: string;
    pythonVersion?: string;
    frameworks: string[];
    topPackages: string[];
    isDjango: boolean;
    isNode: boolean;
    managePyPath?: string;
    packageJsonPath?: string;
}

// In-memory cache for fast repeated calls within 5 seconds
let cachedSnapshot: { timestamp: number; root: string; data: EnvironmentSnapshot } | null = null;

/**
 * Rapidly scans workspace root for environment details (<30ms).
 */
export function scanEnvironment(workspaceRoot: string): EnvironmentSnapshot {
    const now = Date.now();
    if (cachedSnapshot && cachedSnapshot.root === workspaceRoot && (now - cachedSnapshot.timestamp) < 5000) {
        return cachedSnapshot.data;
    }

    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const osType: 'windows' | 'linux' | 'darwin' = isWindows ? 'windows' : (isMac ? 'darwin' : 'linux');
    const osName = isWindows ? 'Windows (win32)' : (isMac ? 'macOS (darwin)' : 'Linux (posix)');
    const shell = isWindows ? 'PowerShell 5.1/7 (Do NOT use raw Bash syntax like && without quotes or rm -rf)' : '/bin/sh';

    const frameworks: string[] = [];
    const topPackages: string[] = [];
    let venvPath: string | undefined;
    let venvBinDir: string | undefined;
    let pythonExe: string | undefined;
    let pythonVersion: string | undefined;
    let isDjango = false;
    let isNode = false;
    let managePyPath: string | undefined;
    let packageJsonPath: string | undefined;

    if (workspaceRoot && fs.existsSync(workspaceRoot)) {
        // 1. Check for Virtual Environments in workspaceRoot and subdirectories (1 level)
        const candidateVenvDirs = [workspaceRoot];
        try {
            const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    candidateVenvDirs.push(path.join(workspaceRoot, entry.name));
                }
            }
        } catch { /* ignore */ }

        const venvFolderNames = ['.venv', 'venv', 'env', '.env_py'];
        for (const baseDir of candidateVenvDirs) {
            for (const venvName of venvFolderNames) {
                const targetVenv = path.join(baseDir, venvName);
                if (fs.existsSync(targetVenv) && fs.statSync(targetVenv).isDirectory()) {
                    const binDir = isWindows
                        ? path.join(targetVenv, 'Scripts')
                        : path.join(targetVenv, 'bin');
                    const exe = isWindows
                        ? path.join(binDir, 'python.exe')
                        : path.join(binDir, 'python');

                    if (fs.existsSync(exe)) {
                        venvPath = targetVenv;
                        venvBinDir = binDir;
                        pythonExe = exe;

                        // Fast pyvenv.cfg read for version (<1ms)
                        const cfgPath = path.join(targetVenv, 'pyvenv.cfg');
                        if (fs.existsSync(cfgPath)) {
                            try {
                                const cfgText = fs.readFileSync(cfgPath, 'utf8');
                                const match = cfgText.match(/^version(?:_info)?\s*=\s*(.+)$/im);
                                if (match) {
                                    pythonVersion = match[1].trim();
                                }
                            } catch { /* ignore */ }
                        }
                        break;
                    }
                }
            }
            if (venvPath) break;
        }

        // 2. Detect Django / Python projects
        const checkManagePy = (dir: string) => {
            const mp = path.join(dir, 'manage.py');
            if (fs.existsSync(mp)) {
                isDjango = true;
                managePyPath = mp;
                if (!frameworks.includes('Django')) frameworks.push('Django');
            }
        };

        checkManagePy(workspaceRoot);
        for (const dir of candidateVenvDirs) {
            if (isDjango) break;
            checkManagePy(dir);
        }

        // Check requirements.txt or pyproject.toml
        const reqPath = path.join(workspaceRoot, 'requirements.txt');
        if (fs.existsSync(reqPath)) {
            try {
                const reqText = fs.readFileSync(reqPath, 'utf8');
                const lines = reqText.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
                for (const line of lines.slice(0, 8)) {
                    topPackages.push(line);
                    if (/django/i.test(line) && !frameworks.includes('Django')) frameworks.push('Django');
                    if (/fastapi/i.test(line) && !frameworks.includes('FastAPI')) frameworks.push('FastAPI');
                    if (/flask/i.test(line) && !frameworks.includes('Flask')) frameworks.push('Flask');
                }
            } catch { /* ignore */ }
        }

        // 3. Detect Node.js / JavaScript projects
        const pkgPath = path.join(workspaceRoot, 'package.json');
        if (fs.existsSync(pkgPath)) {
            isNode = true;
            packageJsonPath = pkgPath;
            try {
                const pkgData = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                const allDeps = { ...(pkgData.dependencies || {}), ...(pkgData.devDependencies || {}) };
                for (const [dep, ver] of Object.entries(allDeps)) {
                    if (['react', 'vue', 'next', 'vite', 'express', 'tailwindcss', 'typescript', 'svelte'].includes(dep.toLowerCase())) {
                        frameworks.push(`${dep} (${ver})`);
                    }
                    if (topPackages.length < 8) {
                        topPackages.push(`${dep}@${ver}`);
                    }
                }
            } catch { /* ignore */ }
        }
    }

    const snapshot: EnvironmentSnapshot = {
        os: osType,
        osName,
        shell,
        venvPath,
        venvBinDir,
        pythonExe,
        pythonVersion,
        frameworks,
        topPackages,
        isDjango,
        isNode,
        managePyPath,
        packageJsonPath
    };

    cachedSnapshot = { timestamp: now, root: workspaceRoot, data: snapshot };
    return snapshot;
}

/**
 * Returns a concise, formatted prompt block to ground models on the exact runtime environment.
 */
export function getEnvironmentPromptSnapshot(workspaceRoot: string): string {
    const snap = scanEnvironment(workspaceRoot);

    const lines: string[] = [
        '[LIVE RUNTIME & ENVIRONMENT SNAPSHOT]',
        `- Operating System: ${snap.osName}`,
        `- Primary Shell: ${snap.shell}`
    ];

    if (snap.venvPath) {
        const verStr = snap.pythonVersion ? ` (Python ${snap.pythonVersion})` : '';
        lines.push(`- Python VirtualEnv: Detected at '${snap.venvPath}'${verStr}`);
        lines.push(`- Python Executable: '${snap.pythonExe}'`);
        lines.push(`- NOTE: VirtualEnv bin/Scripts is automatically bound to PATH. Commands like 'python', 'pip', 'django-admin' automatically run inside this venv.`);
    } else {
        lines.push(`- Python VirtualEnv: No .venv detected yet. If starting a Python project, create a venv using 'python -m venv .venv'.`);
    }

    if (snap.frameworks.length > 0) {
        lines.push(`- Frameworks Detected: ${snap.frameworks.join(', ')}`);
    }

    if (snap.topPackages.length > 0) {
        lines.push(`- Key Project Dependencies: ${snap.topPackages.slice(0, 6).join(', ')}`);
    }

    return lines.join('\n');
}

/**
 * Clears the environment cache.
 */
export function clearEnvironmentCache(): void {
    cachedSnapshot = null;
}

