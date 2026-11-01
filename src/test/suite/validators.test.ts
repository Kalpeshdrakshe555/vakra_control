import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { validateFile, formatValidationReport, ProjectIntegrityChecker } from '../../validators';

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

    test('ProjectIntegrityChecker: detects unregistered Django apps and empty template dirs', () => {
        const djangMock = fs.mkdtempSync(path.join(os.tmpdir(), 'vakra-django-mock-'));
        try {
            fs.writeFileSync(path.join(djangMock, 'manage.py'), '# django manage.py');
            const configDir = path.join(djangMock, 'config');
            fs.mkdirSync(configDir);
            fs.writeFileSync(path.join(configDir, 'settings.py'), `
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
]
TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
    }
]
`);
            // Create products app
            const productsDir = path.join(djangMock, 'products');
            fs.mkdirSync(productsDir);
            fs.writeFileSync(path.join(productsDir, 'apps.py'), 'class ProductsConfig: pass');
            fs.writeFileSync(path.join(productsDir, 'models.py'), 'class Product: pass');

            // Create templates dir
            const tmplDir = path.join(djangMock, 'templates');
            fs.mkdirSync(tmplDir);
            fs.writeFileSync(path.join(tmplDir, 'products.html'), '<h1>Products</h1>');

            // Create colliding auth app
            const authDir = path.join(djangMock, 'auth');
            fs.mkdirSync(authDir);
            fs.writeFileSync(path.join(authDir, 'apps.py'), 'class AuthConfig: pass');

            const issues = ProjectIntegrityChecker.checkWorkspace(djangMock);
            assert.ok(issues.some(i => i.code === 'UNREGISTERED_APP' && i.message.includes('products')));
            assert.ok(issues.some(i => i.code === 'UNREGISTERED_TEMPLATES_DIR'));
            assert.ok(issues.some(i => i.code === 'RESERVED_APP_NAME' && i.message.includes('auth')));

            const formatted = ProjectIntegrityChecker.formatReport(issues, 2);
            assert.ok(formatted.includes('[PROJECT INTEGRITY CHECK'));
            assert.ok(formatted.includes('Suggested Fix:'));
        } finally {
            try { fs.rmSync(djangMock, { recursive: true, force: true }); } catch {}
        }
    });
});
