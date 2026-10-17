import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    splitSequence,
    cleanOutput,
    readTextNormalizedSync,
    writeTextPreservingEolSync,
    runProcess,
    runCommandSequence
} from '../../platform';

suite('Phase 1: Platform Utilities (P1-A)', () => {

    test('commandSequence: splitSequence correctly handles quotes and escapes', () => {
        const cmd = 'cd backend && python manage.py check; echo "a && b"';
        const segments = splitSequence(cmd);
        assert.strictEqual(segments.length, 3);
        assert.strictEqual(segments[0], 'cd backend');
        assert.strictEqual(segments[1], 'python manage.py check');
        assert.strictEqual(segments[2], 'echo "a && b"');

        // Single quote test
        const singleQuote = "echo 'foo && bar' && ls -la";
        const sqSegments = splitSequence(singleQuote);
        assert.strictEqual(sqSegments.length, 2);
        assert.strictEqual(sqSegments[0], "echo 'foo && bar'");
        assert.strictEqual(sqSegments[1], "ls -la");

        // Escaped quote test
        const escaped = 'echo "hello \\" world" && echo done';
        const escSegments = splitSequence(escaped);
        assert.strictEqual(escSegments.length, 2);
        assert.strictEqual(escSegments[1], 'echo done');
    });

    test('output: cleanOutput strips ANSI and normalizes formatting', () => {
        const raw = '\x1b[32mSuccess!\x1b[0m\r\n\r\n\r\n\r\nDone.';
        const cleaned = cleanOutput(raw);
        assert.ok(!cleaned.includes('\x1b[32m'), 'ANSI color should be removed');
        assert.ok(!cleaned.includes('\x1b[0m'), 'ANSI reset should be removed');
        assert.ok(cleaned.includes('Success!'));
        assert.ok(cleaned.includes('Done.'));
        // 4 consecutive newlines should be collapsed
        assert.ok(!cleaned.includes('\n\n\n'));
    });

    test('output: cleanOutput handles carriage return overwrites', () => {
        const raw = 'Downloading 10%\rDownloading 50%\rDownloading 100%\nCompleted';
        const cleaned = cleanOutput(raw);
        assert.ok(cleaned.includes('Downloading 100%'));
        assert.ok(cleaned.includes('Completed'));
    });

    test('output: cleanOutput truncates to tail lines', () => {
        const lines = Array.from({ length: 150 }, (_, i) => `Line ${i + 1}`).join('\n');
        const cleaned = cleanOutput(lines, { maxLines: 50 });
        assert.ok(cleaned.includes('[... 100 earlier lines omitted ...]'));
        assert.ok(cleaned.includes('Line 150'));
        assert.ok(!cleaned.includes('Line 20\n'));
    });

    test('eol: readTextNormalizedSync and writeTextPreservingEolSync work symmetrically', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vakra-test-'));
        const testFile = path.join(tmpDir, 'test.txt');

        try {
            // Write CRLF
            writeTextPreservingEolSync(testFile, 'line 1\nline 2', '\r\n');
            const resCrlf = readTextNormalizedSync(testFile);
            assert.strictEqual(resCrlf.eol, '\r\n');
            assert.strictEqual(resCrlf.text, 'line 1\nline 2');

            // Write LF
            writeTextPreservingEolSync(testFile, 'line 1\nline 2', '\n');
            const resLf = readTextNormalizedSync(testFile);
            assert.strictEqual(resLf.eol, '\n');
            assert.strictEqual(resLf.text, 'line 1\nline 2');
        } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });

    test('process: runProcess executes and bounds output', async () => {
        const isWin = process.platform === 'win32';
        const exe = isWin ? 'cmd.exe' : 'echo';
        const args = isWin ? ['/c', 'echo hello vakra'] : ['hello vakra'];

        const res = await runProcess({
            exe,
            args,
            timeoutMs: 5000
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.exitCode, 0);
        assert.ok(res.stdout.includes('hello vakra'));
    });

    test('process: timeout properly aborts execution', async function() {
        this.timeout(10000);
        const isWin = process.platform === 'win32';
        const exe = isWin ? 'powershell.exe' : 'node';
        const args = isWin ? ['-Command', 'Start-Sleep -Seconds 10'] : ['-e', 'setTimeout(()=>{}, 10000)'];

        const res = await runProcess({
            exe,
            args,
            timeoutMs: 1000
        });

        assert.strictEqual(res.timedOut, true);
        assert.strictEqual(res.ok, false);
    });

    test('commandSequence: in-process cd tracking changes working directory', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vakra-cd-test-'));
        const subDir = path.join(tmpDir, 'subfolder');
        fs.mkdirSync(subDir);

        try {
            const seqRes = await runCommandSequence('cd subfolder', tmpDir);
            assert.strictEqual(seqRes.ok, true);
            assert.strictEqual(path.normalize(seqRes.finalCwd), path.normalize(subDir));
        } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });
});
