import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ToolDispatcher } from '../../webview/tools/toolDispatcher';
import { ToolRegistry } from '../../tools/toolRegistry';
import { InMemoryTaskPlanner } from '../../state/inMemoryTaskPlanner';

suite('Phase 3: Architecture Consolidation & End-to-End Workflow Verification', () => {
    let testWorkspace: string;
    let postedMessages: any[] = [];
    let planner: InMemoryTaskPlanner;

    const createTestContext = (overrides?: Partial<any>) => {
        return {
            workspaceRoot: testWorkspace,
            postMessage: (msg: any) => {
                postedMessages.push(msg);
            },
            isEditSessionAutoApproved: true,
            isTerminalSessionAutoApproved: true,
            pendingTerminalResolvers: new Map(),
            pendingEditResolvers: new Map(),
            taskPlanner: planner,
            recordFileBackup: () => {},
            config: {
                maxAutonomousToolSteps: 20
            },
            ...overrides
        };
    };

    setup(() => {
        testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vakra-phase3-'));
        postedMessages = [];
        planner = new InMemoryTaskPlanner(undefined, (msg) => postedMessages.push(msg));
        ToolDispatcher.resetSessionState();
        ToolDispatcher.clearFailedCommand();
        ToolRegistry.registerEssentialTools();
    });

    teardown(() => {
        ToolDispatcher.resetSessionState();
        ToolDispatcher.clearFailedCommand();
        try {
            fs.rmSync(testWorkspace, { recursive: true, force: true });
        } catch {}
    });

    suite('Complete Autonomous Coding Workflow', () => {
        test('simulates end-to-end multi-turn inspect -> sanitize -> edit -> test -> finish workflow', async () => {
            // Setup initial workspace file
            const calcFile = path.join(testWorkspace, 'calculator.js');
            fs.writeFileSync(calcFile, 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n', 'utf8');

            const ctx = createTestContext();

            // Set up a plan with 2 steps
            await ToolDispatcher.dispatch({
                name: 'set_task_plan',
                arguments: {
                    steps: [
                        { id: 1, title: 'Fix add function' },
                        { id: 2, title: 'Verify with test' }
                    ]
                }
            }, ctx);

            // Step 1: Model requests inspection of workspace file
            const readRes = await ToolDispatcher.dispatch({
                name: 'read_multiple_files',
                arguments: {
                    filepaths: ['calculator.js']
                }
            }, ctx);

            assert.ok(readRes.includes('calculator.js'), 'Read result must include filename');
            assert.ok(readRes.includes('function add(a, b)'), 'Read result must contain file content');

            // Step 2: Model requests file modification
            const editRes = await ToolDispatcher.dispatch({
                name: 'edit_file',
                arguments: {
                    filepath: 'calculator.js',
                    old_text: 'return a - b;',
                    new_text: 'return a + b;'
                }
            }, ctx);

            assert.ok(editRes.includes('Successfully edited') || editRes.includes('applied'), 'Edit must report success');
            const updatedContent = fs.readFileSync(calcFile, 'utf8');
            assert.ok(updatedContent.includes('return a + b;'), 'File on disk must reflect edited content');

            // Mark step 1 complete
            await ToolDispatcher.dispatch({
                name: 'complete_plan_step',
                arguments: { step_id: 1 }
            }, ctx);

            // Step 3: Model executes test command
            const testCmd = 'node -e "const { add } = require(\'./calculator.js\'); if (add(2, 3) !== 5) process.exit(1);"';

            const termRes = await ToolDispatcher.dispatch({
                name: 'execute_terminal_command',
                arguments: {
                    command: testCmd
                }
            }, ctx);

            assert.ok(termRes.includes('Exit Code: 0'), 'Validation test must succeed with exit code 0');

            // Mark step 2 complete
            await ToolDispatcher.dispatch({
                name: 'complete_plan_step',
                arguments: { step_id: 2 }
            }, ctx);

            // Step 4: Model completes task using finish protocol
            const finishRes = await ToolDispatcher.dispatch({
                name: 'finish',
                arguments: {
                    summary: 'Fixed addition bug in calculator and verified with automated test.'
                }
            }, ctx);

            assert.strictEqual(finishRes, 'Fixed addition bug in calculator and verified with automated test.', 'Finish protocol must return completion summary');
        });
    });

    suite('Security & Protection Guards', () => {
        test('denies sensitive credential files from inspection', async () => {
            const secretFile = path.join(testWorkspace, '.env');
            fs.writeFileSync(secretFile, 'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE\n', 'utf8');

            const ctx = createTestContext();
            const readRes = await ToolDispatcher.dispatch({
                name: 'read_multiple_files',
                arguments: {
                    filepaths: ['.env']
                }
            }, ctx);

            assert.ok(readRes.includes('ACCESS DENIED'), 'Must deny sensitive file read');
            assert.ok(!readRes.includes('AKIAIOSFODNN7EXAMPLE'), 'Must not leak secret contents in output');
        });

        test('redacts secrets found inside allowed code files', async () => {
            const codeFile = path.join(testWorkspace, 'config.js');
            fs.writeFileSync(codeFile, 'const apiKey = "sk-1234567890abcdef1234567890abcdef";\n', 'utf8');

            const ctx = createTestContext();
            const readRes = await ToolDispatcher.dispatch({
                name: 'read_multiple_files',
                arguments: {
                    filepaths: ['config.js']
                }
            }, ctx);

            assert.ok(readRes.includes('[REDACTED:API_KEY]'), 'Must redact token pattern');
            assert.ok(!readRes.includes('sk-1234567890abcdef1234567890abcdef'), 'Original secret must be masked');
        });

        test('prevents path traversal out of workspace', async () => {
            const ctx = createTestContext();
            const readRes = await ToolDispatcher.dispatch({
                name: 'read_multiple_files',
                arguments: {
                    filepaths: ['../../etc/passwd']
                }
            }, ctx);

            assert.ok(readRes.includes('outside workspace') || readRes.includes('ACCESS DENIED'), 'Must block path traversal');
        });
    });

    suite('Tool Failure and Verification Strictness', () => {
        test('blocks finish protocol when previous command failed', async () => {
            const ctx = createTestContext();

            // Run a command that fails
            const failCmd = 'node -e "process.exit(1)"';
            await ToolDispatcher.dispatch({
                name: 'execute_terminal_command',
                arguments: { command: failCmd }
            }, ctx);

            assert.strictEqual(ToolDispatcher.getLastFailedCommand(), failCmd);

            // Attempt finish
            const finishRes = await ToolDispatcher.dispatch({
                name: 'finish',
                arguments: { summary: 'Done everything' }
            }, ctx);

            assert.ok(typeof finishRes === 'string' && finishRes.startsWith('REJECTED:'), 'Finish must be rejected');
            assert.ok(finishRes.includes("Cannot finish task because command"), 'Rejection must explain failure reason');
        });

        test('blocks finish protocol when plan steps remain incomplete', async () => {
            const ctx = createTestContext();

            await ToolDispatcher.dispatch({
                name: 'set_task_plan',
                arguments: {
                    steps: [
                        { id: 1, title: 'Step 1' },
                        { id: 2, title: 'Step 2' }
                    ]
                }
            }, ctx);

            const finishRes = await ToolDispatcher.dispatch({
                name: 'finish',
                arguments: { summary: 'Done' }
            }, ctx);

            assert.ok(typeof finishRes === 'string' && finishRes.startsWith('REJECTED:'));
            assert.ok(finishRes.includes('plan steps are incomplete:'));
        });

        test('gracefully handles malformed tool arguments', async () => {
            const ctx = createTestContext();

            // Malformed read_multiple_files
            const readRes = await ToolDispatcher.dispatch({
                name: 'read_multiple_files',
                arguments: {}
            }, ctx);
            assert.ok(readRes.includes("Error: 'paths' must be an array of file paths."));

            // Malformed write_file
            const writeRes = await ToolDispatcher.dispatch({
                name: 'write_file',
                arguments: { filepath: '' }
            }, ctx);
            assert.ok(writeRes.includes('Error: filepath is required.') || writeRes.includes('Invalid path:'));

            // Malformed edit_file
            const editRes = await ToolDispatcher.dispatch({
                name: 'edit_file',
                arguments: { filepath: 'test.js' }
            }, ctx);
            assert.ok(editRes.includes("Error: Both 'old_text' and 'new_text' strings are required"));

            // Malformed execute_terminal_command
            const termRes = await ToolDispatcher.dispatch({
                name: 'execute_terminal_command',
                arguments: {}
            }, ctx);
            assert.ok(termRes.includes('Error: command is required.'));
        });

        test('returns structured error for unknown tools', async () => {
            const ctx = createTestContext();
            const unknownRes = await ToolDispatcher.dispatch({
                name: 'nonexistent_speculative_tool',
                arguments: { foo: 'bar' }
            }, ctx);

            assert.strictEqual(unknownRes, "Error: Unknown or unsupported tool 'nonexistent_speculative_tool'.");
        });

        test('dispatches list_directory_tree via consolidated ToolRegistry path', async () => {
            const subDir = path.join(testWorkspace, 'src');
            fs.mkdirSync(subDir);
            fs.writeFileSync(path.join(subDir, 'index.ts'), 'export const x = 1;', 'utf8');

            const ctx = createTestContext();
            const treeRes = await ToolDispatcher.dispatch({
                name: 'list_directory_tree',
                arguments: { dir: '.', depth: 2 }
            }, ctx);

            assert.ok(treeRes.includes('Directory Tree for'), 'Must return visual tree');
            assert.ok(treeRes.includes('index.ts'), 'Tree must include workspace files');
        });
    });

    suite('Cancellation Lifecycle', () => {
        test('cancels edit_file when signal is aborted', async () => {
            const testFile = path.join(testWorkspace, 'abort_test.js');
            fs.writeFileSync(testFile, 'initial content\n', 'utf8');

            const abortController = new AbortController();
            abortController.abort(); // already aborted

            const ctx = createTestContext({
                signal: abortController.signal
            });

            const editRes = await ToolDispatcher.dispatch({
                name: 'edit_file',
                arguments: {
                    filepath: 'abort_test.js',
                    old_text: 'initial content',
                    new_text: 'modified content'
                }
            }, ctx);

            assert.ok(editRes.includes('Operation aborted') || editRes.includes('cancelled'), 'Edit must report cancellation');
            assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'initial content\n', 'File must remain unmodified');
        });

        test('cancels terminal command when signal is aborted', async () => {
            const abortController = new AbortController();
            abortController.abort();

            const ctx = createTestContext({
                signal: abortController.signal
            });

            const termRes = await ToolDispatcher.dispatch({
                name: 'execute_terminal_command',
                arguments: {
                    command: 'node -e "while(true){}"'
                }
            }, ctx);

            assert.ok(termRes.includes('aborted') || termRes.includes('cancelled') || termRes.includes('Exit Code: -1'), 'Command must abort');
        });
    });
});
