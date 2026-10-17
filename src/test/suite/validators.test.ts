import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { validateFile, formatValidationReport } from '../../validators';

suite('Phase 1: Post-Write Validators (P1-C)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vakra-val-'));

    teardown(() => {
        // cleanup files in tmpDir
    });

    test('validateFile: valid JSON passes and invalid JSON fails with line/col', async () => {
        const validJson = path.join(tmpDir, 'valid.json');
        fs.writeFileSync(validJson, JSON.stringify({ a: 1, b: "test" }));
        const resValid = await validateFile(validJson, { workspaceRoot: tmpDir });
        assert.strictEqual(resValid.length, 1);
        assert.strictEqual(resValid[0].ok, true);

        const invalidJson = path.join(tmpDir, 'invalid.json');
        fs.writeFileSync(invalidJson, '{\n  "a": 1,\n  "b": \n}');
        const resInvalid = await validateFile(invalidJson, { workspaceRoot: tmpDir });
        assert.strictEqual(resInvalid.length, 1);
        assert.strictEqual(resInvalid[0].ok, false);
        assert.ok(resInvalid[0].line !== undefined);
    });

    test('validateFile: CSS brace balance detection', async () => {
        const validCss = path.join(tmpDir, 'valid.css');
        fs.writeFileSync(validCss, 'body { color: red; } .box { width: 100px; }');
        const resValid = await validateFile(validCss, { workspaceRoot: tmpDir });
        assert.strictEqual(resValid[0].ok, true);

        const invalidCss = path.join(tmpDir, 'invalid.css');
        fs.writeFileSync(invalidCss, 'body { color: red; .box { width: 100px; }');
        const resInvalid = await validateFile(invalidCss, { workspaceRoot: tmpDir });
        assert.strictEqual(resInvalid[0].ok, false);
    });

    test('formatValidationReport produces readable output on syntax errors', () => {
        const report = formatValidationReport('cart/views.py', [
            {
                ok: false,
                validator: 'python-ast',
                line: 12,
                column: 5,
                message: 'unexpected indent',
                snippet: ' >> 12 |   items = cart.items.all()'
            }
        ]);

        assert.ok(report.includes('[VALIDATION]'));
        assert.ok(report.includes('views.py: SYNTAX ERROR line 12 col 5'));
        assert.ok(report.includes('items = cart.items.all()'));
    });
});
