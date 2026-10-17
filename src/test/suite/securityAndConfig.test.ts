import * as assert from 'assert';
import { redact, isSecretPath } from '../../security/secretsFilter';
import { sanitizeProfile, DEFAULT_MODEL_PROFILE } from '../../config/modelProfile';

suite('Phase 1: Security & Config (P1-D, P1-E)', () => {

    test('secretsFilter: isSecretPath flags secret files and directories', () => {
        assert.strictEqual(isSecretPath('.env'), true);
        assert.strictEqual(isSecretPath('.env.production'), true);
        assert.strictEqual(isSecretPath('certs/server.pem'), true);
        assert.strictEqual(isSecretPath('id_rsa'), true);
        assert.strictEqual(isSecretPath('db.sqlite3'), true);
        assert.strictEqual(isSecretPath('.git/config'), true);
        assert.strictEqual(isSecretPath('node_modules/express/index.js'), true);

        // Safe files
        assert.strictEqual(isSecretPath('src/index.ts'), false);
        assert.strictEqual(isSecretPath('package.json'), false);
        assert.strictEqual(isSecretPath('README.md'), false);
    });

    test('secretsFilter: redact replaces keys, JWTs and generic assignments', () => {
        const text = `
            AWS_KEY = AKIA1234567890ABCDEF
            OPENAI_KEY = sk-1234567890abcdef1234567890abcdef
            API_KEY: 'supersecretvalue123'
            token = "mysecrettoken123"
            Normal word token without value is fine.
        `;

        const res = redact(text);
        assert.ok(res.text.includes('[REDACTED:AWS_KEY]'));
        assert.ok(res.text.includes('[REDACTED:API_KEY]'));
        assert.ok(res.text.includes('[REDACTED:SECRET]'));
        assert.ok(res.text.includes('Normal word token without value is fine.'));
        assert.ok(res.redactions.length >= 3);
    });

    test('modelProfile: sanitizeProfile handles invalid inputs and clamps bounds', () => {
        const empty = sanitizeProfile(null);
        assert.strictEqual(empty.model, DEFAULT_MODEL_PROFILE.model);
        assert.strictEqual(empty.maxFilesPerStep, DEFAULT_MODEL_PROFILE.maxFilesPerStep);

        const outOfBounds = sanitizeProfile({
            maxFilesPerStep: 9999,
            maxLinesPerFile: 10,
            writeMode: 'invalid'
        });

        assert.strictEqual(outOfBounds.maxFilesPerStep, 10); // clamped to 10
        assert.strictEqual(outOfBounds.maxLinesPerFile, 50); // clamped to 50 minimum
        assert.strictEqual(outOfBounds.writeMode, 'extension'); // fallback
    });
});
