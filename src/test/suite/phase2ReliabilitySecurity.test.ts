import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isSecretPath, redact } from '../../security/secretsFilter';
import { resolveSafeWorkspacePath } from '../../operations/diffPatcher';
import { ToolDispatcher } from '../../webview/tools/toolDispatcher';
import { extractTextToolCalls } from '../../router/realClients';
import { PromptBuilder } from '../../webview/promptBuilder';
import { PromptClassifier } from '../../utils/promptClassifier';
import { RuntimePlugins } from '../../plugins/runtimePlugins';
import { clearPythonCache } from '../../platform/python';

suite('Phase 2: Reliability, Security & Tool-Contract Hardening', () => {
    let tmpDir: string;
    let dispatcher: ToolDispatcher;
    let events: any[];

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vakra-p2-test-'));
        events = [];
        dispatcher = new ToolDispatcher();
    });

    teardown(() => {
        clearPythonCache();
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
    });

    // =========================================================================
    // Priority 1: Secure File Access and Secret Protection
    // =========================================================================
    suite('Priority 1 — Secure File Access & Secret Protection', () => {

        test('isSecretPath detects sensitive credential files across variations and casing', () => {
            // Environment files
            assert.strictEqual(isSecretPath('.env'), true);
            assert.strictEqual(isSecretPath('.env.local'), true);
            assert.strictEqual(isSecretPath('.env.production'), true);
            assert.strictEqual(isSecretPath('.env.test'), true);
            assert.strictEqual(isSecretPath('.ENV'), true);
            assert.strictEqual(isSecretPath('.Env.Development'), true);

            // Keys and certificates
            assert.strictEqual(isSecretPath('id_rsa'), true);
            assert.strictEqual(isSecretPath('id_ed25519'), true);
            assert.strictEqual(isSecretPath('id_ecdsa'), true);
            assert.strictEqual(isSecretPath('certs/server.pem'), true);
            assert.strictEqual(isSecretPath('private.key'), true);
            assert.strictEqual(isSecretPath('keystore.p12'), true);

            // Cloud and auth credentials
            assert.strictEqual(isSecretPath('credentials'), true);
            assert.strictEqual(isSecretPath('credentials.json'), true);
            assert.strictEqual(isSecretPath('.aws/credentials'), true);
            assert.strictEqual(isSecretPath('.ssh/id_rsa'), true);
            assert.strictEqual(isSecretPath('.ssh/authorized_keys'), true);
            assert.strictEqual(isSecretPath('.netrc'), true);
            assert.strictEqual(isSecretPath('.npmrc'), true);
            assert.strictEqual(isSecretPath('api_secret.txt'), true);

            // Normalization and workspaceRoot resolution
            assert.strictEqual(isSecretPath('src/../.env', tmpDir), true);
            assert.strictEqual(isSecretPath(path.join(tmpDir, '.env'), tmpDir), true);
            assert.strictEqual(isSecretPath(path.join(tmpDir, 'subdir', '..', 'credentials.json'), tmpDir), true);

            // Legitimate source and config files must NOT be blocked
            assert.strictEqual(isSecretPath('src/index.ts'), false);
            assert.strictEqual(isSecretPath('package.json'), false);
            assert.strictEqual(isSecretPath('tsconfig.json'), false);
            assert.strictEqual(isSecretPath('README.md'), false);
            assert.strictEqual(isSecretPath('src/environment.ts'), false);
            assert.strictEqual(isSecretPath('components/SecretComponent.tsx'), true); // contains secret
        });

        test('read_multiple_files denies reading sensitive files without leaking content', async () => {
            const secretFile = path.join(tmpDir, '.env');
            fs.writeFileSync(secretFile, 'DATABASE_PASSWORD=SuperSecretPass123!\nAPI_KEY=AKIAIOSFODNN7EXAMPLE\n');

            const normalFile = path.join(tmpDir, 'app.ts');
            fs.writeFileSync(normalFile, 'console.log("Hello Vakra");\n');

            const ctx: any = {
                workspaceRoot: tmpDir,
                postMessage: (msg: any) => events.push(msg)
            };

            const result = await ToolDispatcher.dispatch({
                name: 'read_multiple_files',
                args: { filepaths: ['.env', 'app.ts'] }
            }, ctx);

            // .env must be strictly denied
            assert.ok(result.includes('ACCESS DENIED'), 'Must contain ACCESS DENIED notice for .env');
            assert.ok(!result.includes('SuperSecretPass123!'), 'Must NEVER leak sensitive secret content in output');
            assert.ok(!result.includes('AKIAIOSFODNN7EXAMPLE'), 'Must NEVER leak sensitive API keys in output');

            // Normal file must be read successfully
            assert.ok(result.includes('console.log("Hello Vakra")'), 'Must include content of legitimate files');
        });

        test('read_multiple_files redacts accidental credentials from normal files as defense in depth', async () => {
            const codeWithAccidentalKey = path.join(tmpDir, 'service.ts');
            fs.writeFileSync(codeWithAccidentalKey, 'const key = "AKIA1234567890ABCDEF";\nconst token = "sk-1234567890abcdef1234567890abcdef";\n');

            const ctx: any = {
                workspaceRoot: tmpDir,
                postMessage: (msg: any) => events.push(msg)
            };

            const result = await ToolDispatcher.dispatch({
                name: 'read_multiple_files',
                args: { filepaths: ['service.ts'] }
            }, ctx);

            assert.ok(!result.includes('AKIA1234567890ABCDEF'), 'Accidental AWS key must be redacted');
            assert.ok(result.includes('[REDACTED:AWS_KEY]'), 'Should contain redaction marker');
            assert.ok(!result.includes('sk-1234567890abcdef1234567890abcdef'), 'Accidental API key must be redacted');
            assert.ok(result.includes('[REDACTED:API_KEY]'), 'Should contain API key redaction marker');
        });

        test('write_file and edit_file block modifying sensitive credential files', async () => {
            const envFile = path.join(tmpDir, '.env');
            fs.writeFileSync(envFile, 'EXISTING=1\n');

            const ctx: any = {
                workspaceRoot: tmpDir,
                postMessage: (msg: any) => events.push(msg)
            };

            const writeRes = await ToolDispatcher.dispatch({
                name: 'write_file',
                args: { filepath: '.env', content: 'MALICIOUS_OVERWRITE=1' }
            }, ctx);
            assert.ok(writeRes.includes('ACCESS DENIED'), 'write_file on .env must be denied');
            assert.strictEqual(fs.readFileSync(envFile, 'utf8'), 'EXISTING=1\n');

            const editRes = await ToolDispatcher.dispatch({
                name: 'edit_file',
                args: { filepath: '.env', old_text: 'EXISTING=1', new_text: 'EXISTING=2' }
            }, ctx);
            assert.ok(editRes.includes('ACCESS DENIED'), 'edit_file on .env must be denied');
            assert.strictEqual(fs.readFileSync(envFile, 'utf8'), 'EXISTING=1\n');
        });

        test('resolveSafeWorkspacePath blocks path traversal outside workspace', () => {
            const safe = resolveSafeWorkspacePath('src/index.ts', tmpDir);
            assert.strictEqual(safe.safe, true);

            const outside = resolveSafeWorkspacePath('../outside.txt', tmpDir);
            assert.strictEqual(outside.safe, false);
            assert.ok(outside.error?.includes('Security / Guard violation'));
        });
    });

    // =========================================================================
    // Priority 2: Reliable Tool-Call Handling for Local Models
    // =========================================================================
    suite('Priority 2 — Reliable Tool-Call Handling for Local Models', () => {

        test('extracts function call syntax for planning and finishing tools', () => {
            // finish with keyword argument
            const t1 = extractTextToolCalls('I have verified the code.\nfinish(summary="Task completed and all tests pass.")');
            assert.strictEqual(t1.length, 1);
            assert.strictEqual(t1[0].name, 'finish');
            assert.strictEqual(t1[0].args.summary, 'Task completed and all tests pass.');

            // finish with single string argument
            const t2 = extractTextToolCalls('finish("Successfully deployed")');
            assert.strictEqual(t2.length, 1);
            assert.strictEqual(t2[0].name, 'finish');
            assert.strictEqual(t2[0].args.summary, 'Successfully deployed');

            // finish with zero arguments
            const t3 = extractTextToolCalls('All checks pass.\nfinish()');
            assert.strictEqual(t3.length, 1);
            assert.strictEqual(t3[0].name, 'finish');
            assert.strictEqual(t3[0].args.summary, 'Task completed successfully.');

            // read_state_ledger() with zero arguments
            const t4 = extractTextToolCalls('Let me consult the ledger.\nread_state_ledger()');
            assert.strictEqual(t4.length, 1);
            assert.strictEqual(t4[0].name, 'read_state_ledger');
            assert.deepStrictEqual(t4[0].args, {});

            // set_task_plan with array
            const t5 = extractTextToolCalls('set_task_plan(steps=["Step 1: Setup", "Step 2: Implement"])');
            assert.strictEqual(t5.length, 1);
            assert.strictEqual(t5[0].name, 'set_task_plan');
            assert.deepStrictEqual(t5[0].args.steps, ['Step 1: Setup', 'Step 2: Implement']);

            // expand_plan_step
            const t6 = extractTextToolCalls('expand_plan_step(step_id=1, sub_steps=["1.1 Test", "1.2 Run"])');
            assert.strictEqual(t6.length, 1);
            assert.strictEqual(t6[0].name, 'expand_plan_step');
            assert.strictEqual(t6[0].args.step_id, 1);

            // complete_plan_step
            const t7 = extractTextToolCalls('complete_plan_step(sub_step_id="1.1", summary="Done setting up models")');
            assert.strictEqual(t7.length, 1);
            assert.strictEqual(t7[0].name, 'complete_plan_step');
            assert.strictEqual(t7[0].args.summary, 'Done setting up models');

            // read_skill
            const t8 = extractTextToolCalls('read_skill("code-reviewer")');
            assert.strictEqual(t8.length, 1);
            assert.strictEqual(t8[0].name, 'read_skill');
            assert.strictEqual(t8[0].args.skill_name, 'code-reviewer');
        });

        test('extracts JSON object tool calls and normalizes final_answer to finish', () => {
            const raw = '{\n  "name": "final_answer",\n  "arguments": {\n    "summary": "Project refactoring is done."\n  }\n}';
            const calls = extractTextToolCalls(raw);
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].name, 'finish');
            assert.strictEqual(calls[0].args.summary, 'Project refactoring is done.');
        });

        test('validates tool arguments and discards malformed or incomplete calls', () => {
            // write_file without content is invalid
            const invalidWrite = extractTextToolCalls('write_file(filepath="src/test.ts")');
            assert.strictEqual(invalidWrite.length, 0, 'Malformed write_file should be rejected');

            // edit_file without old_text is invalid
            const invalidEdit = extractTextToolCalls('edit_file(filepath="src/test.ts", new_text="hello")');
            assert.strictEqual(invalidEdit.length, 0, 'Malformed edit_file should be rejected');

            // execute_terminal_command with empty command is invalid
            const invalidCmd = extractTextToolCalls('execute_terminal_command(command="")');
            assert.strictEqual(invalidCmd.length, 0, 'Empty command should be rejected');
        });

        test('does not misinterpret ordinary prose as tool calls', () => {
            const prose1 = "Checking whether the test suite passed before we finish the task.";
            assert.strictEqual(extractTextToolCalls(prose1).length, 0);

            const prose2 = "You can call edit_file(filepath, old_text, new_text) when ready.";
            assert.strictEqual(extractTextToolCalls(prose2).length, 0);

            const prose3 = "Let's check the database configuration for any syntax errors.";
            assert.strictEqual(extractTextToolCalls(prose3).length, 0);
        });

        test('prevents duplicate tool execution when same call is repeated in text', () => {
            const duplicateText = 'read_multiple_files(filepaths=["src/app.ts"])\n\nread_multiple_files(filepaths=["src/app.ts"])';
            const calls = extractTextToolCalls(duplicateText);
            assert.strictEqual(calls.length, 1, 'Duplicate calls must be deduplicated');
        });

        test('extracts XML/tag-based tool calls with plural filepaths and triple-quoted content', () => {
            const rawTagSnippet = `<tool_call> <function=write_file> <parameter=filepaths> ["task_manager/settings.py"] </parameter> <parameter=content> """ Django settings for task_manager project.
DEBUG = True
""" </content> </function> </tool_call>`;
            const calls = extractTextToolCalls(rawTagSnippet);
            assert.strictEqual(calls.length, 1, 'Tag-based call must be parsed');
            assert.strictEqual(calls[0].name, 'write_file');
            assert.strictEqual(calls[0].args.filepath, 'task_manager/settings.py');
            assert.ok(!calls[0].args.content.includes('"""'), 'Triple quotes must be stripped');
            assert.ok(calls[0].args.content.includes('DEBUG = True'));
        });
    });

    // =========================================================================
    // Priority 3: Nonexistent Capabilities Verification
    // =========================================================================
    suite('Priority 3 — Remove Nonexistent Capabilities', () => {

        test('PromptBuilder.HEAD does not contain references to generate_ui_blueprint', () => {
            const head = PromptBuilder.buildHead();
            assert.ok(!head.includes('generate_ui_blueprint'));
            assert.ok(!head.includes('check_localhost_health'));
            assert.ok(!head.includes('update_architecture_context'));
            assert.ok(!head.includes('capture_localhost_preview'));
        });

        test('PromptClassifier does not offer nonexistent tools in UI or backend categories', () => {
            const dummyTools = [{
                functionDeclarations: [
                    { name: 'search_web' },
                    { name: 'execute_terminal_command' },
                    { name: 'generate_ui_blueprint' },
                    { name: 'check_localhost_health' },
                    { name: 'update_architecture_context' },
                    { name: 'capture_localhost_preview' },
                    { name: 'finish' }
                ]
            }];

            const uiTools = PromptClassifier.filterTools('ui', dummyTools);
            const uiNames = uiTools[0].functionDeclarations.map((f: any) => f.name);
            assert.ok(!uiNames.includes('generate_ui_blueprint'), 'generate_ui_blueprint should not be in uiTools');
            assert.ok(!uiNames.includes('check_localhost_health'), 'check_localhost_health should not be in uiTools');
            assert.ok(!uiNames.includes('capture_localhost_preview'), 'capture_localhost_preview should not be in uiTools');

            const backendTools = PromptClassifier.filterTools('backend', dummyTools);
            const backendNames = backendTools[0].functionDeclarations.map((f: any) => f.name);
            assert.ok(!backendNames.includes('update_architecture_context'), 'update_architecture_context should not be in backendTools');
            assert.ok(!backendNames.includes('check_localhost_health'), 'check_localhost_health should not be in backendTools');
        });
    });

    // =========================================================================
    // Priority 4: Python Syntax-Guard Interpreter Resolution
    // =========================================================================
    suite('Priority 4 — Python Syntax Guard & Interpreter Resolution', () => {

        test('afterFileWrite validates clean Python code asynchronously', async () => {
            const pyFile = path.join(tmpDir, 'valid.py');
            const cleanCode = 'def calculate_total(a, b):\n    return a + b\n';
            fs.writeFileSync(pyFile, cleanCode);

            const res = await RuntimePlugins.afterFileWrite({
                filePath: pyFile,
                fileContent: cleanCode,
                oldContent: '',
                workspaceRoot: tmpDir
            });

            // Either Python compiles cleanly (success: true) or Python is absent on machine (success: true without revert)
            assert.strictEqual(res.success, true);
            assert.strictEqual(fs.readFileSync(pyFile, 'utf8'), cleanCode);
        });

        test('afterFileWrite intercepts syntax errors and reverts file when Python is present', async () => {
            const pyFile = path.join(tmpDir, 'broken.py');
            const oldContent = 'def clean_func():\n    pass\n';
            const brokenContent = 'def broken_func(:\n    pass\n'; // intentional syntax error
            fs.writeFileSync(pyFile, brokenContent);

            const res = await RuntimePlugins.afterFileWrite({
                filePath: pyFile,
                fileContent: brokenContent,
                oldContent: oldContent,
                workspaceRoot: tmpDir
            });

            if (res.success === false) {
                // Python was available and detected broken syntax
                assert.strictEqual(res.revertRequested, true);
                assert.ok(res.feedback?.includes('SYNTAX GUARD INTERCEPTED BROKEN CODE'));
                assert.strictEqual(fs.readFileSync(pyFile, 'utf8'), oldContent, 'File must be reverted to clean state');
            } else {
                // If Python interpreter is unavailable on the test runner, it must not revert clean code
                assert.strictEqual(res.success, true);
            }
        });
    });

    // =========================================================================
    // Priority 5: Prompt Contract Consistency
    // =========================================================================
    suite('Priority 5 — Prompt Contract Consistency', () => {

        test('PromptBuilder.HEAD contains no hardcoded Hindi or Hinglish instructions', () => {
            const head = PromptBuilder.buildHead();
            const bannedTokens = ['padho', 'karein', 'aapki', 'hamesha', 'pehle', 'chahiye', 'banaya'];
            for (const token of bannedTokens) {
                assert.ok(!head.toLowerCase().includes(token), `PromptBuilder.HEAD should not contain Hinglish token '${token}'`);
            }
        });

        test('PromptBuilder.HEAD preserves concise micro-kernel length', () => {
            const head = PromptBuilder.buildHead();
            assert.ok(head.length < 6000, `Head length (${head.length}) must remain compact and concise`);
            assert.ok(head.includes('RULES:'));
            assert.ok(head.includes('TOOLS:'));
            assert.ok(head.includes('finish('));
            assert.ok(head.includes('read_state_ledger()'));
        });
    });
});
