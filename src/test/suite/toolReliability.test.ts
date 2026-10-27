import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import './mockVscode';
import { ToolDispatcher, ToolExecutionContext } from '../../webview/tools/toolDispatcher';
import { ToolRegistry } from '../../tools/toolRegistry';
import { TerminalCapture } from '../../tools/terminalCapture';
import { runProcess } from '../../platform/process';

suite('Phase 1: Critical Tool Reliability Fixes', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vakra-reliability-test-'));
        ToolRegistry.registerEssentialTools();
        ToolDispatcher.clearFailedCommand();
    });

    teardown(() => {
        TerminalCapture.cancelActive();
        ToolDispatcher.clearFailedCommand();
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* ignore */ }
    });

    function createMockContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
        return {
            workspaceRoot: tmpDir,
            postMessage: () => {},
            isEditSessionAutoApproved: false,
            isTerminalSessionAutoApproved: false,
            pendingTerminalResolvers: new Map(),
            pendingEditResolvers: new Map(),
            taskPlanner: null,
            ...overrides
        };
    }

    // =========================================================================
    // Issue 1: edit_file approval enforcement
    // =========================================================================
    suite('1. edit_file Approval Enforcement', () => {
        test('requires approval and does NOT modify file when rejected', async () => {
            const testFile = path.join(tmpDir, 'sample.txt');
            fs.writeFileSync(testFile, 'initial content\nline 2', 'utf8');

            const pendingEditResolvers = new Map<string, (approved: boolean, autoApprove?: boolean) => void>();
            let eventEmitted: any = null;

            const ctx = createMockContext({
                pendingEditResolvers,
                isEditSessionAutoApproved: false,
                postMessage: (msg) => {
                    if (msg.command === 'toolCallEvent' && msg.tool === 'edit_file') {
                        eventEmitted = msg;
                    }
                }
            });

            const editPromise = ToolDispatcher.dispatch({
                name: 'edit_file',
                args: {
                    filepath: 'sample.txt',
                    old_text: 'initial content',
                    new_text: 'updated content'
                }
            }, ctx);

            // Wait a tick for dispatch to register the resolver
            await new Promise(r => setTimeout(r, 10));

            // Verify event was emitted with isAutoApproved: false
            assert.ok(eventEmitted, 'toolCallEvent should be emitted');
            assert.strictEqual(eventEmitted.data.isAutoApproved, false);

            // Verify file on disk has NOT been modified yet
            assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'initial content\nline 2');

            // Find resolver and reject
            assert.strictEqual(pendingEditResolvers.size, 1);
            const resolver = Array.from(pendingEditResolvers.values())[0];
            resolver(false);

            const result = await editPromise;
            assert.ok(result.includes('User rejected edit operation'), `Expected rejection message, got: ${result}`);

            // Verify file on disk is still unchanged
            assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'initial content\nline 2');
        });

        test('applies edit to disk when user approves', async () => {
            const testFile = path.join(tmpDir, 'sample.txt');
            fs.writeFileSync(testFile, 'hello world\nline 2', 'utf8');

            const pendingEditResolvers = new Map<string, (approved: boolean, autoApprove?: boolean) => void>();
            const ctx = createMockContext({
                pendingEditResolvers,
                isEditSessionAutoApproved: false
            });

            const editPromise = ToolDispatcher.dispatch({
                name: 'edit_file',
                args: {
                    filepath: 'sample.txt',
                    old_text: 'hello world',
                    new_text: 'hello vakra'
                }
            }, ctx);

            await new Promise(r => setTimeout(r, 10));
            assert.strictEqual(pendingEditResolvers.size, 1);
            const resolver = Array.from(pendingEditResolvers.values())[0];
            resolver(true);

            const result = await editPromise;
            assert.ok(result.includes('Successfully edited file: sample.txt'), `Result: ${result}`);
            assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'hello vakra\nline 2');
        });

        test('applies immediately without waiting when session is auto-approved', async () => {
            const testFile = path.join(tmpDir, 'sample.txt');
            fs.writeFileSync(testFile, 'auto approve test\nline 2', 'utf8');

            const pendingEditResolvers = new Map<string, (approved: boolean, autoApprove?: boolean) => void>();
            let eventEmitted: any = null;

            const ctx = createMockContext({
                pendingEditResolvers,
                isEditSessionAutoApproved: true,
                postMessage: (msg) => {
                    if (msg.command === 'toolCallEvent' && msg.tool === 'edit_file') {
                        eventEmitted = msg;
                    }
                }
            });

            const result = await ToolDispatcher.dispatch({
                name: 'edit_file',
                args: {
                    filepath: 'sample.txt',
                    old_text: 'auto approve test',
                    new_text: 'immediate edit'
                }
            }, ctx);

            assert.strictEqual(pendingEditResolvers.size, 0, 'Should not add resolver when auto-approved');
            assert.ok(eventEmitted, 'toolCallEvent should be emitted');
            assert.strictEqual(eventEmitted.data.isAutoApproved, true);
            assert.ok(result.includes('Successfully edited file'));
            assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'immediate edit\nline 2');
        });

        test('cancels edit when abort signal is triggered', async () => {
            const testFile = path.join(tmpDir, 'sample.txt');
            fs.writeFileSync(testFile, 'initial content', 'utf8');

            const abortCtrl = new AbortController();
            const pendingEditResolvers = new Map<string, (approved: boolean, autoApprove?: boolean) => void>();
            const ctx = createMockContext({
                pendingEditResolvers,
                signal: abortCtrl.signal,
                isEditSessionAutoApproved: false
            });

            const editPromise = ToolDispatcher.dispatch({
                name: 'edit_file',
                args: {
                    filepath: 'sample.txt',
                    old_text: 'initial content',
                    new_text: 'should not apply'
                }
            }, ctx);

            await new Promise(r => setTimeout(r, 10));
            abortCtrl.abort();

            const result = await editPromise;
            assert.strictEqual(result, 'Operation cancelled by user.');
            assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'initial content');
        });

        test('cancels edit immediately when signal is already aborted', async () => {
            const testFile = path.join(tmpDir, 'pre_abort.txt');
            fs.writeFileSync(testFile, 'pre-existing content', 'utf8');

            const abortCtrl = new AbortController();
            abortCtrl.abort();

            const pendingEditResolvers = new Map<string, (approved: boolean, autoApprove?: boolean) => void>();
            const ctx = createMockContext({
                pendingEditResolvers,
                signal: abortCtrl.signal,
                isEditSessionAutoApproved: false
            });

            const result = await ToolDispatcher.dispatch({
                name: 'edit_file',
                args: {
                    filepath: 'pre_abort.txt',
                    old_text: 'pre-existing content',
                    new_text: 'modified content'
                }
            }, ctx);

            assert.strictEqual(result, 'Operation cancelled by user.');
            assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'pre-existing content');
            assert.strictEqual(pendingEditResolvers.size, 0);
        });

        test('returns validation error on missing old_text or new_text', async () => {
            const ctx = createMockContext();
            const res1 = await ToolDispatcher.dispatch({
                name: 'edit_file',
                args: { filepath: 'test.txt', old_text: 'only old' }
            }, ctx);
            assert.ok(res1.includes("Both 'old_text' and 'new_text' strings are required"));

            const res2 = await ToolDispatcher.dispatch({
                name: 'edit_file',
                args: { filepath: 'test.txt', new_text: 'only new' }
            }, ctx);
            assert.ok(res2.includes("Both 'old_text' and 'new_text' strings are required"));
        });
    });

    // =========================================================================
    // Issue 2: search_codebase implementation
    // =========================================================================
    suite('2. search_codebase Implementation', () => {
        test('search_codebase is registered in ToolRegistry and executes cleanly', async () => {
            const dummyFile = path.join(tmpDir, 'sample_code.ts');
            fs.writeFileSync(dummyFile, 'export function calculateTotal(a: number, b: number): number { return a + b; }', 'utf8');

            const result = await ToolRegistry.executeTool('search_codebase', JSON.stringify({ query: 'calculateTotal' }), tmpDir);
            assert.ok(typeof result === 'string');
            assert.ok(!result.includes('Tool search_codebase not found'), 'Tool should be registered');
        });

        test('search_codebase returns error when query is missing', async () => {
            const ctx = createMockContext();
            const res = await ToolDispatcher.dispatch({
                name: 'search_codebase',
                args: {}
            }, ctx);
            assert.ok(res.includes("'query' parameter is required"));
        });

        test('search_codebase dispatches cleanly via ToolDispatcher', async () => {
            const ctx = createMockContext();
            const res = await ToolDispatcher.dispatch({
                name: 'search_codebase',
                args: { query: 'nonExistentSymbol12345' }
            }, ctx);

            assert.ok(typeof res === 'string');
            assert.ok(!res.includes('Tool search_codebase not found'));
            assert.ok(res.includes('No matches found for query') || res.includes('nonExistentSymbol12345'));
        });

        test('search_codebase uses provided ctx.ragEngine', async () => {
            const mockRagEngine = {
                searchWithSnippets: (query: string) => [
                    { filepath: 'src/mock.ts', snippet: `// src/mock.ts\nexport const ${query} = 42;`, score: 10 }
                ]
            };

            const ctx = createMockContext({ ragEngine: mockRagEngine });
            const res = await ToolDispatcher.dispatch({
                name: 'search_codebase',
                args: { query: 'customSymbol' }
            }, ctx);

            assert.ok(res.includes('src/mock.ts'));
            assert.ok(res.includes('customSymbol'));
        });
    });

    // =========================================================================
    // Issue 3: finish false completion prevention
    // =========================================================================
    suite('3. finish Verification Enforcement', () => {
        test('rejects finish tool call when previous command has failed', async () => {
            const ctx = createMockContext();
            ToolDispatcher.setLastFailedCommand('npm test');

            const res = await ToolDispatcher.dispatch({
                name: 'finish',
                args: { summary: 'Completed all work!' }
            }, ctx);

            assert.ok(res.startsWith('REJECTED: Cannot finish task because command \'npm test\' failed.'));
            assert.ok(res.includes('You must diagnose the error'));
        });

        test('rejects finish tool call when task planner has incomplete steps', async () => {
            const mockTaskPlanner = {
                getSteps: () => [
                    { id: 1, title: 'Write code', status: 'done' },
                    { id: 2, title: 'Verify test suite', status: 'pending' }
                ]
            };
            const ctx = createMockContext({ taskPlanner: mockTaskPlanner });
            ToolDispatcher.clearFailedCommand();

            const res = await ToolDispatcher.dispatch({
                name: 'finish',
                args: { summary: 'Done with task!' }
            }, ctx);

            assert.ok(res.startsWith('REJECTED: Cannot finish task because the following plan steps are incomplete:'));
            assert.ok(res.includes('Step 2: Verify test suite [pending]'));
        });

        test('succeeds finish tool call when no command has failed and all plan steps done', async () => {
            const mockTaskPlanner = {
                getSteps: () => [
                    { id: 1, title: 'Write code', status: 'done' },
                    { id: 2, title: 'Verify test suite', status: 'done' }
                ]
            };
            const ctx = createMockContext({ taskPlanner: mockTaskPlanner });
            ToolDispatcher.clearFailedCommand();

            const res = await ToolDispatcher.dispatch({
                name: 'finish',
                args: { summary: 'All steps verified.' }
            }, ctx);

            assert.strictEqual(res, 'All steps verified.');
        });

        test('resetSessionState clears failed command and session counters', () => {
            ToolDispatcher.setLastFailedCommand('cargo test');
            assert.strictEqual(ToolDispatcher.getLastFailedCommand(), 'cargo test');
            ToolDispatcher.resetSessionState();
            assert.strictEqual(ToolDispatcher.getLastFailedCommand(), null);
        });
    });

    // =========================================================================
    // Issue 4: Process termination and cancellation
    // =========================================================================
    suite('4. Process Termination & Cancellation', () => {
        test('runProcess terminates promptly with AbortSignal', async function() {
            this.timeout(5000);
            const abortCtrl = new AbortController();

            const isWin = process.platform === 'win32';
            const exe = isWin ? 'powershell.exe' : 'node';
            const args = isWin ? ['-Command', 'Start-Sleep -Seconds 10'] : ['-e', 'setTimeout(()=>{}, 10000)'];

            setTimeout(() => abortCtrl.abort(), 150);

            const startTime = Date.now();
            const res = await runProcess({
                exe,
                args,
                signal: abortCtrl.signal,
                timeoutMs: 10000
            });

            const elapsed = Date.now() - startTime;
            assert.ok(elapsed < 2000, `Process should have terminated promptly on abort, took ${elapsed}ms`);
            assert.strictEqual(res.ok, false);
            assert.strictEqual(res.cancelled, true);
        });

        test('runProcess returns immediately if signal is already aborted', async () => {
            const abortCtrl = new AbortController();
            abortCtrl.abort();

            const isWin = process.platform === 'win32';
            const exe = isWin ? 'powershell.exe' : 'node';
            const args = isWin ? ['-Command', 'Start-Sleep -Seconds 10'] : ['-e', 'setTimeout(()=>{}, 10000)'];

            const res = await runProcess({
                exe,
                args,
                signal: abortCtrl.signal
            });

            assert.strictEqual(res.ok, false);
            assert.strictEqual(res.cancelled, true);
            assert.strictEqual(res.durationMs, 0);
        });

        test('TerminalCapture.cancelActive terminates running commands', async function() {
            this.timeout(5000);
            const isWin = process.platform === 'win32';
            const longCmd = isWin ? 'powershell.exe -Command "Start-Sleep -Seconds 10"' : 'node -e "setTimeout(()=>{}, 10000)"';

            setTimeout(() => {
                TerminalCapture.cancelActive();
            }, 150);

            const startTime = Date.now();
            const res = await TerminalCapture.runAndCapture(longCmd, tmpDir);
            const elapsed = Date.now() - startTime;

            assert.ok(elapsed < 2000, `Command should terminate on cancelActive, took ${elapsed}ms`);
            assert.strictEqual(res.error, true);
            assert.ok(res.output.includes('cancelled') || res.exitCode !== 0);
        });
    });

    // =========================================================================
    // Issue 5: Long-running development-server blocking
    // =========================================================================
    suite('5. Long-Running Server Command Blocking', () => {
        test('TerminalCapture.isDaemonCommand detects dev servers and continuous processes', () => {
            assert.strictEqual(TerminalCapture.isDaemonCommand('python manage.py runserver'), true);
            assert.strictEqual(TerminalCapture.isDaemonCommand('python manage.py runserver 8000'), true);
            assert.strictEqual(TerminalCapture.isDaemonCommand('npm run dev'), true);
            assert.strictEqual(TerminalCapture.isDaemonCommand('npm start'), true);
            assert.strictEqual(TerminalCapture.isDaemonCommand('npm run serve'), true);
            assert.strictEqual(TerminalCapture.isDaemonCommand('yarn dev'), true);
            assert.strictEqual(TerminalCapture.isDaemonCommand('pnpm dev'), true);
            assert.strictEqual(TerminalCapture.isDaemonCommand('vite'), true);
            assert.strictEqual(TerminalCapture.isDaemonCommand('npx vite'), true);
            assert.strictEqual(TerminalCapture.isDaemonCommand('flask run'), true);
            assert.strictEqual(TerminalCapture.isDaemonCommand('uvicorn main:app --reload'), true);
            assert.strictEqual(TerminalCapture.isDaemonCommand('next dev'), true);
            assert.strictEqual(TerminalCapture.isDaemonCommand('nodemon server.js'), true);
        });

        test('TerminalCapture.isDaemonCommand allows non-blocking verification commands', () => {
            assert.strictEqual(TerminalCapture.isDaemonCommand('npm test'), false);
            assert.strictEqual(TerminalCapture.isDaemonCommand('npm run build'), false);
            assert.strictEqual(TerminalCapture.isDaemonCommand('vite build'), false);
            assert.strictEqual(TerminalCapture.isDaemonCommand('python manage.py check'), false);
            assert.strictEqual(TerminalCapture.isDaemonCommand('python -m unittest'), false);
            assert.strictEqual(TerminalCapture.isDaemonCommand('git status'), false);
            assert.strictEqual(TerminalCapture.isDaemonCommand('node script.js'), false);
        });

        test('TerminalCapture.runAndCapture blocks daemon commands immediately without freezing', async () => {
            const startTime = Date.now();
            const res = await TerminalCapture.runAndCapture('npm run dev', tmpDir);
            const elapsed = Date.now() - startTime;

            assert.ok(elapsed < 500, `Daemon command check should return immediately, took ${elapsed}ms`);
            assert.strictEqual(res.error, true);
            assert.strictEqual(res.exitCode, 1);
            assert.ok(res.output.includes('BLOCKED'));
        });

        test('execute_terminal_command in ToolDispatcher blocks daemon commands', async () => {
            const ctx = createMockContext({ isTerminalSessionAutoApproved: true });
            const res = await ToolDispatcher.dispatch({
                name: 'execute_terminal_command',
                args: { command: 'vite' }
            }, ctx);

            assert.ok(res.includes('BLOCKED:'));
            assert.ok(res.includes('continuous/daemon process'));
        });

        test('TerminalCapture.runAndCapture executes normal finite command and returns exitCode 0 and output', async () => {
            const echoCmd = process.platform === 'win32' ? 'node -e "console.log(\'finite test ok\')"' : 'echo "finite test ok"';
            const res = await TerminalCapture.runAndCapture(echoCmd, tmpDir);

            assert.strictEqual(res.exitCode, 0);
            assert.strictEqual(res.error, false);
            assert.ok(res.output.includes('finite test ok'));
        });
    });
});
