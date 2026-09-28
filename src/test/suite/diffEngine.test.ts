import * as assert from 'assert';
import { DiffValidator } from '../../operations/diffValidator';
import { findByContextAnchors, applyRobustSearchReplace } from '../../operations/diffPatcher';

suite('Diff Engine & Validation Test Suite', () => {

    test('DiffValidator blocks placeholders and lazy ellipsis', () => {
        const forbiddenCases = [
            "// ...",
            "# ...",
            "/* ... */",
            "// existing code",
            "# rest of code",
            "... existing implementation",
            "function foo() {\n  // ...\n}",
            "def bar():\n  # rest of code\n",
            "   " // empty
        ];

        for (const code of forbiddenCases) {
            const res = DiffValidator.validateReplacementContent(code);
            assert.strictEqual(res.valid, false, `Expected invalid for: ${code}`);
            assert.ok(res.reason, "Expected reason for rejection");
        }
    });

    test('DiffValidator allows marked deletions and valid code', () => {
        const allowedDeletion = DiffValidator.validateReplacementContent("// intentional deletion");
        assert.strictEqual(allowedDeletion.valid, true);

        const validCode = DiffValidator.validateReplacementContent("export const port = 8080;\nexport function start() { return port; }");
        assert.strictEqual(validCode.valid, true);
    });

    test('findByContextAnchors finds multi-line structural anchors', () => {
        const origLines = [
            "import express from 'express';",
            "const app = express();",
            "const PORT = 3000;",
            "",
            "app.get('/api/health', (req, res) => {",
            "    res.json({ status: 'ok' });",
            "});",
            "",
            "app.listen(PORT, () => {",
            "    console.log('Server running');",
            "});"
        ];

        const searchLines = [
            "app.get('/api/health', (req, res) => {",
            "    res.json({ status: 'ok' });",
            "});"
        ];

        const anchorRes = findByContextAnchors(origLines, searchLines);
        assert.strictEqual(anchorRes.matched, true);
        assert.strictEqual(anchorRes.startIndex, 4);
        assert.strictEqual(anchorRes.endIndex, 6);
    });

    test('applyRobustSearchReplace replaces code via Context Anchors', () => {
        const originalFile = [
            "const a = 1;",
            "function compute() {",
            "    const x = 10;",
            "    const y = 20;",
            "    return x + y;",
            "}",
            "export default compute;"
        ].join('\n');

        // Middle has slight mismatch in search block
        const searchBlock = [
            "function compute() {",
            "    const x = 10;",
            "    const mismatched = 999;",
            "    return x + y;",
            "}"
        ].join('\n');

        const replaceBlock = [
            "function compute() {",
            "    const x = 10;",
            "    const y = 30;",
            "    return x * y;",
            "}"
        ].join('\n');

        const patchRes = applyRobustSearchReplace(originalFile, searchBlock, replaceBlock);
        assert.strictEqual(patchRes.success, true);
        assert.ok(patchRes.result.includes("const y = 30;"));
        assert.ok(patchRes.result.includes("return x * y;"));
    });

    test('applyRobustSearchReplace aborts and returns reason when placeholder is in replace block', () => {
        const originalFile = "function hello() { return 'world'; }";
        const searchBlock = "function hello() { return 'world'; }";
        const lazyReplace = "function hello() {\n    // ...\n}";

        const patchRes = applyRobustSearchReplace(originalFile, searchBlock, lazyReplace);
        assert.strictEqual(patchRes.success, false);
        assert.ok(patchRes.error?.includes("Lazy placeholder"));
    });
});
