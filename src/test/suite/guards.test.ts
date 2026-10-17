import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { guardTool, LoopDetector } from '../../guards';

suite('Phase 1: Tool Guards (P1-B)', () => {
    const dummyWs = path.join(os.tmpdir(), 'vakra-guard-ws');

    test('guardTool: blocks long-running server commands', () => {
        const res1 = guardTool({ name: 'run_in_terminal', args: { command: 'python manage.py runserver 8000' } }, { workspaceRoot: dummyWs });
        assert.strictEqual(res1.allow, false);
        if (!res1.allow) assert.strictEqual(res1.code, 'SERVER_BLOCKED');

        const res2 = guardTool({ name: 'run_in_terminal', args: { command: 'npm run dev' } }, { workspaceRoot: dummyWs });
        assert.strictEqual(res2.allow, false);

        // Allowed commands: build, test
        const res3 = guardTool({ name: 'run_in_terminal', args: { command: 'npm run build' } }, { workspaceRoot: dummyWs });
        assert.strictEqual(res3.allow, true);

        const res4 = guardTool({ name: 'run_in_terminal', args: { command: 'vite build' } }, { workspaceRoot: dummyWs });
        assert.strictEqual(res4.allow, true);
    });

    test('guardTool: blocks shell redirection file writes', () => {
        const res = guardTool({ name: 'run_in_terminal', args: { command: 'echo hello > app.js' } }, { workspaceRoot: dummyWs });
        assert.strictEqual(res.allow, false);
        if (!res.allow) assert.strictEqual(res.code, 'FILE_WRITE_VIA_SHELL');

        // Allowed redirects to null
        const resNull = guardTool({ name: 'run_in_terminal', args: { command: 'npm test > /dev/null' } }, { workspaceRoot: dummyWs });
        assert.strictEqual(resNull.allow, true);
    });

    test('guardTool: blocks placeholders in write_file', () => {
        const res = guardTool({
            name: 'write_file',
            args: {
                filepath: 'app.py',
                content: 'def foo():\n    # ... existing code ...\n    return 42'
            }
        }, { workspaceRoot: dummyWs });

        assert.strictEqual(res.allow, false);
        if (!res.allow) assert.strictEqual(res.code, 'OVERWRITE_SHRINK');
    });

    test('guardTool: blocks path escapes outside workspace', () => {
        const res = guardTool({
            name: 'write_file',
            args: { filepath: '../../etc/passwd', content: 'hack' }
        }, { workspaceRoot: dummyWs });

        assert.strictEqual(res.allow, false);
        if (!res.allow) assert.strictEqual(res.code, 'PATH_ESCAPE');
    });

    test('guardTool: blocks destructive commands', () => {
        const res = guardTool({
            name: 'run_in_terminal',
            args: { command: 'rm -rf src/' }
        }, { workspaceRoot: dummyWs });

        assert.strictEqual(res.allow, false);
        if (!res.allow) assert.strictEqual(res.code, 'DESTRUCTIVE_COMMAND');
    });

    test('guardTool: LoopDetector catches immediate duplicates', () => {
        const ld = new LoopDetector();
        const call = { name: 'write_file', args: { filepath: 'test.py', content: 'x = 1' } };
        
        // First check
        const first = guardTool(call, { workspaceRoot: dummyWs, loopDetector: ld });
        assert.strictEqual(first.allow, true);

        // Record success
        ld.record({ tool: 'write_file', argsHash: LoopDetector.hashArgs(call.args), resultOk: true });

        // Second duplicate check
        const second = guardTool(call, { workspaceRoot: dummyWs, loopDetector: ld });
        assert.strictEqual(second.allow, false);
        if (!second.allow) assert.strictEqual(second.code, 'LOOP_REPEAT');
    });
});
