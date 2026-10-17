import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    parseReply,
    checkReply,
    applyEdits,
    splitReplyIntoTasks,
    TaskExecutor,
    buildWrapper
} from '../../brain';
import { DEFAULT_MODEL_PROFILE } from '../../config/modelProfile';

suite('Phase 2: Protocol Parser & Task Execution (P2-A to P2-F)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vakra-p2-test-'));

    teardown(() => {
        // Clean temporary test workspace
    });

    test('protocolWrapper: buildWrapper generates limits and platform instructions', () => {
        const wrapper = buildWrapper(DEFAULT_MODEL_PROFILE, { os: 'Windows', shell: 'PowerShell 5.1' });
        assert.ok(wrapper.includes('[OUTPUT PROTOCOL: FOLLOW EXACTLY]'));
        assert.ok(wrapper.includes(`At most ${DEFAULT_MODEL_PROFILE.maxFilesPerStep} file(s)`));
        assert.ok(wrapper.includes('PowerShell'));
    });

    test('protocolParser: parseReply extracts files, edits, commands, and verify blocks', () => {
        const sampleReply = `
TYPE: FIX
STEP: 1 - Initialize Cart
MANIFEST: 2
- src/cart.ts
- src/index.ts

===FILE: src/cart.ts===
export interface CartItem {
    id: string;
    qty: number;
}
===END FILE===

===EDIT: src/index.ts===
<<<<<<< SEARCH
import { User } from './user';
=======
import { User } from './user';
import { CartItem } from './cart';
>>>>>>> REPLACE
===END EDIT===

===COMMANDS===
npm install
===END COMMANDS===

===VERIFY===
npm test
===END VERIFY===

NEXT_PLANNED: Add Checkout
===END OF RESPONSE===
`;

        const parsed = parseReply(sampleReply);
        assert.strictEqual(parsed.type, 'FIX');
        assert.strictEqual(parsed.stepNo, 1);
        assert.strictEqual(parsed.manifest.length, 2);
        assert.strictEqual(parsed.files.length, 1);
        assert.strictEqual(parsed.files[0].path, 'src/cart.ts');
        assert.ok(parsed.files[0].content.includes('CartItem'));
        assert.strictEqual(parsed.files[0].complete, true);

        assert.strictEqual(parsed.edits.length, 1);
        assert.strictEqual(parsed.edits[0].path, 'src/index.ts');
        assert.strictEqual(parsed.edits[0].blocks.length, 1);
        assert.strictEqual(parsed.edits[0].complete, true);

        assert.strictEqual(parsed.commands.length, 1);
        assert.strictEqual(parsed.commands[0], 'npm install');

        assert.strictEqual(parsed.verify.length, 1);
        assert.strictEqual(parsed.verify[0], 'npm test');
        assert.strictEqual(parsed.hasEndMarker, true);
    });

    test('violationChecker: detects truncation, manifest mismatch, and placeholders', () => {
        const incompleteReply = `
TYPE: FIX
MANIFEST: 2
- file1.py
- file2.py
===FILE: file1.py===
def foo():
    # ... existing code ...
    pass
===END FILE===
`;
        const parsed = parseReply(incompleteReply);
        const violations = checkReply(parsed, DEFAULT_MODEL_PROFILE);

        const codes = violations.map(v => v.code);
        assert.ok(codes.includes('TRUNCATED'), 'Missing END OF RESPONSE should trigger TRUNCATED');
        assert.ok(codes.includes('MISSING_FILES'), 'file2.py missing should trigger MISSING_FILES');
        assert.ok(codes.includes('PLACEHOLDER'), 'existing code placeholder should trigger PLACEHOLDER');
    });

    test('editApplier: applies exact and indentation-tolerant search/replace blocks', () => {
        const original = `
function greet() {
    console.log("hello");
}
`;
        const blocks = [
            {
                search: 'console.log("hello");',
                replace: 'console.log("hello vakra");'
            }
        ];

        const res = applyEdits(original, blocks);
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.applied, 1);
        assert.ok(res.newContent!.includes('hello vakra'));
    });

    test('taskSplitter: splits parsed reply into task queue preserving order', () => {
        const sample = `
TYPE: FIX
===FILE: a.ts===
const a = 1;
===END FILE===
===COMMANDS===
echo 1
echo 2
===END COMMANDS===
===VERIFY===
echo verify
===END VERIFY===
===END OF RESPONSE===
`;
        const parsed = parseReply(sample);
        const queue = splitReplyIntoTasks(parsed, DEFAULT_MODEL_PROFILE);

        assert.strictEqual(queue.size(), 3);
        const t1 = queue.next();
        assert.strictEqual(t1?.kind, 'write');
        const t2 = queue.next();
        assert.strictEqual(t2?.kind, 'command');
        const t3 = queue.next();
        assert.strictEqual(t3?.kind, 'verify');
    });

    test('taskExecutor: executes write and edit tasks with validation', async () => {
        const executor = new TaskExecutor({
            workspaceRoot: tmpDir,
            profile: DEFAULT_MODEL_PROFILE
        });

        // 1. Write task
        const writeTask = {
            id: 't1',
            kind: 'write' as const,
            path: 'hello.json',
            content: JSON.stringify({ message: 'vakra rocks' }, null, 2)
        };

        const writeOutcome = await executor.run(writeTask);
        assert.strictEqual(writeOutcome.ok, true);
        assert.ok(fs.existsSync(path.join(tmpDir, 'hello.json')));

        // 2. Edit task
        const editTask = {
            id: 't2',
            kind: 'edit' as const,
            path: 'hello.json',
            blocks: [
                {
                    search: '"message": "vakra rocks"',
                    replace: '"message": "vakra supercharged"'
                }
            ]
        };

        const editOutcome = await executor.run(editTask);
        assert.strictEqual(editOutcome.ok, true);
        const updated = fs.readFileSync(path.join(tmpDir, 'hello.json'), 'utf8');
        assert.ok(updated.includes('vakra supercharged'));
    });
});
