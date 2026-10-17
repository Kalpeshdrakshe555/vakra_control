import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

export interface RunProcessOptions {
    exe: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
    stdinText?: string;
}

export interface ProcessResult {
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    combined: string;
    timedOut: boolean;
    durationMs: number;
    error?: string;
}

/**
 * Safely kills a process and all its child processes across platforms.
 */
export async function killTree(pid: number): Promise<void> {
    if (!pid || pid <= 0) return;

    if (process.platform === 'win32') {
        try {
            const killer = spawn('taskkill', ['/pid', pid.toString(), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore'
            });
            await new Promise<void>((resolve) => {
                killer.on('close', () => resolve());
                killer.on('error', () => resolve());
            });
        } catch {
            try { process.kill(pid); } catch { /* ignore */ }
        }
    } else {
        try {
            // Detached process group on Unix: kill the negative PID
            process.kill(-pid, 'SIGKILL');
        } catch {
            try {
                process.kill(pid, 'SIGKILL');
            } catch { /* ignore */ }
        }
    }
}

/**
 * Runs a command as an isolated sub-process with bounded output and clean cancellation/timeout tree-killing.
 */
export async function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
    const startTime = Date.now();
    let exe = options.exe;
    let args = options.args ? [...options.args] : [];
    const cwd = options.cwd || process.cwd();
    const env = options.env || { ...process.env };
    const timeoutMs = options.timeoutMs ?? 60000;
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024; // 1 MB limit

    // Windows compatibility: On Windows, npm, npx, yarn, pnpm are .cmd/.bat scripts.
    // Node.js spawn() without shell cannot execute batch scripts directly (EINVAL or ENOENT).
    // If running these tools on Windows, execute via cmd or resolve to .cmd.
    let useShell = false;
    if (process.platform === 'win32') {
        const baseName = path.basename(exe).toLowerCase();
        const winShims = ['npm', 'npx', 'yarn', 'pnpm', 'pip', 'cargo'];
        if (winShims.includes(baseName) || winShims.map(s => `${s}.cmd`).includes(baseName)) {
            useShell = true;
        }
    }

    return new Promise<ProcessResult>((resolve) => {
        let child: ChildProcess;
        let timedOut = false;
        let timer: NodeJS.Timeout | null = null;

        let stdoutBuf = '';
        let stderrBuf = '';
        let combinedBuf = '';
        let settled = false;

        const appendOutput = (str: string, isErr: boolean) => {
            if (combinedBuf.length < maxOutputBytes) {
                combinedBuf += str;
                if (isErr) stderrBuf += str;
                else stdoutBuf += str;
            }
        };

        try {
            child = spawn(exe, args, {
                cwd,
                env,
                shell: useShell,
                windowsHide: true,
                // On Unix, detach child so process group can be killed together
                detached: process.platform !== 'win32'
            });
        } catch (err: any) {
            return resolve({
                ok: false,
                exitCode: -1,
                stdout: '',
                stderr: err?.message || String(err),
                combined: err?.message || String(err),
                timedOut: false,
                durationMs: Date.now() - startTime,
                error: err?.message || String(err)
            });
        }

        if (options.stdinText && child.stdin) {
            try {
                child.stdin.write(options.stdinText);
                child.stdin.end();
            } catch { /* ignore stdin error */ }
        }

        if (timeoutMs > 0) {
            timer = setTimeout(async () => {
                timedOut = true;
                if (child.pid) {
                    await killTree(child.pid);
                }
            }, timeoutMs);
        }

        child.stdout?.on('data', (chunk) => {
            appendOutput(chunk.toString('utf8'), false);
        });

        child.stderr?.on('data', (chunk) => {
            appendOutput(chunk.toString('utf8'), true);
        });

        const finish = (code: number | null, err?: any) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);

            const durationMs = Date.now() - startTime;
            const ok = code === 0 && !timedOut;

            resolve({
                ok,
                exitCode: code,
                stdout: stdoutBuf,
                stderr: stderrBuf,
                combined: combinedBuf,
                timedOut,
                durationMs,
                error: err?.message || (timedOut ? `Process timed out after ${timeoutMs}ms` : undefined)
            });
        };

        child.on('close', (code) => finish(code));
        child.on('error', (err) => finish(-1, err));
    });
}
