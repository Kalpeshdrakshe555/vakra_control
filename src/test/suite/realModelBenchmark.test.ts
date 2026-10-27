// src/test/suite/realModelBenchmark.test.ts
// Phase 5A: Real-Model Coding Benchmark on the configured local model (Gemma 4B).

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentOrchestrator } from '../../agents/agentOrchestrator';
import { ToolDispatcher } from '../../webview/tools/toolDispatcher';
import { InMemoryTaskPlanner } from '../../state/inMemoryTaskPlanner';
import { createConfiguredClient } from '../../router/realClients';
import { TerminalCapture } from '../../tools/terminalCapture';

suite('Phase 5A: Real-Model Coding Benchmark', function () {
    // Local 4B model inference can take up to 2-4 minutes for multi-step tasks
    this.timeout(400000);

    let tempDir: string;
    let realClient: any;
    let config: any;

    const fullTools = [
        {
            functionDeclarations: [
                {
                    name: 'read_multiple_files',
                    description: 'Reads workspace files with optional line range slicing. Max 3 files at once.',
                    parameters: {
                        type: 'object',
                        properties: {
                            filepaths: { type: 'array', items: { type: 'string' }, description: 'Array of file paths to inspect' },
                            start_line: { type: 'number', description: 'Optional starting line number (1-based)' },
                            end_line: { type: 'number', description: 'Optional ending line number (1-based)' }
                        },
                        required: ['filepaths']
                    }
                },
                {
                    name: 'list_directory_tree',
                    description: 'Explores the workspace directory structure.',
                    parameters: {
                        type: 'object',
                        properties: {
                            dir: { type: 'string', description: 'Relative directory path (e.g. "." or "src")' },
                            depth: { type: 'number', description: 'Maximum depth level (default 2)' }
                        }
                    }
                },
                {
                    name: 'write_file',
                    description: 'Writes full file content to disk. Used to create files.',
                    parameters: {
                        type: 'object',
                        properties: {
                            filepath: { type: 'string', description: 'Relative path to file' },
                            content: { type: 'string', description: 'Full file content' }
                        },
                        required: ['filepath', 'content']
                    }
                },
                {
                    name: 'edit_file',
                    description: 'Replaces exact old_text snippet with new_text in an existing file.',
                    parameters: {
                        type: 'object',
                        properties: {
                            filepath: { type: 'string', description: 'Relative path to target file' },
                            old_text: { type: 'string', description: 'Exact snippet to replace' },
                            new_text: { type: 'string', description: 'Replacement content' }
                        },
                        required: ['filepath', 'old_text', 'new_text']
                    }
                },
                {
                    name: 'execute_terminal_command',
                    description: 'Executes a non-blocking finite shell command in the workspace.',
                    parameters: {
                        type: 'object',
                        properties: {
                            command: { type: 'string', description: 'Command to run (e.g. "node test.js")' },
                            explanation: { type: 'string', description: 'Why this command is being run' }
                        },
                        required: ['command']
                    }
                },
                {
                    name: 'set_task_plan',
                    description: 'Establishes a high-level roadmap with user requirements in PLAN.md.',
                    parameters: {
                        type: 'object',
                        properties: {
                            user_requirements: { type: 'string' },
                            steps: { type: 'array', items: { type: 'string' } }
                        },
                        required: ['steps']
                    }
                },
                {
                    name: 'complete_plan_step',
                    description: 'Marks a sub-step or parent step as done in PLAN.md.',
                    parameters: {
                        type: 'object',
                        properties: {
                            sub_step_id: { type: 'string' },
                            summary: { type: 'string' }
                        },
                        required: ['summary']
                    }
                },
                {
                    name: 'finish',
                    description: 'Concludes the task when verification passes.',
                    parameters: {
                        type: 'object',
                        properties: {
                            summary: { type: 'string' }
                        },
                        required: ['summary']
                    }
                }
            ]
        }
    ];

    suiteSetup(() => {
        const configPath = path.join(os.homedir(), '.ultra-light-ai', 'config.json');
        assert.ok(fs.existsSync(configPath), 'Global config.json must exist');
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const clientRes = createConfiguredClient(config);
        realClient = clientRes.client;
        console.log(`[SuiteSetup] Real model initialized: ${clientRes.brainName}`);
    });

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vakra-real-bench-'));
        const aiDir = path.join(tempDir, '.ultra-light-ai');
        fs.mkdirSync(aiDir, { recursive: true });
        ToolDispatcher.resetSessionState();
    });

    teardown(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
        ToolDispatcher.resetSessionState();
    });

    // =========================================================================
    // Test A — Read-only understanding
    // =========================================================================
    test('Test A: Read-only understanding of authService.js', async () => {
        const authContent = `// Token-based authentication service
const crypto = require('crypto');

function generateToken(userId, secretKey) {
    if (!userId || !secretKey) {
        throw new Error('userId and secretKey are required');
    }
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: userId, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const signature = crypto.createHmac('sha256', secretKey).update(\`\${header}.\${payload}\`).digest('base64url');
    return \`\${header}.\${payload}.\${signature}\`;
}

function verifyToken(token, secretKey) {
    if (!token || !secretKey) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', secretKey).update(\`\${header}.\${payload}\`).digest('base64url');
    if (signature !== expectedSig) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

module.exports = { generateToken, verifyToken };
`;
        fs.writeFileSync(path.join(tempDir, 'authService.js'), authContent, 'utf8');

        const planner = new InMemoryTaskPlanner();
        const dispatchedTools: { role: string; name: string; args: any }[] = [];

        const orchestrator = new AgentOrchestrator({
            workspaceRoot: tempDir,
            config,
            client: realClient,
            tools: fullTools,
            taskPlanner: planner,
            postMessage: () => {},
            dispatchTool: async (call, role) => {
                dispatchedTools.push({ role, name: call.name, args: call.args });
                return await ToolDispatcher.dispatch(call, {
                    workspaceRoot: tempDir,
                    postMessage: () => {},
                    isEditSessionAutoApproved: true,
                    isTerminalSessionAutoApproved: true,
                    pendingTerminalResolvers: new Map(),
                    pendingEditResolvers: new Map(),
                    taskPlanner: planner,
                    activeRole: role
                });
            },
            userPrompt: 'explain how the generateToken function in authService.js works'
        });

        const startTime = Date.now();
        const result = await orchestrator.execute();
        const durationMs = Date.now() - startTime;

        console.log(`[Test A] Duration: ${durationMs}ms`);
        console.log(`[Test A] Dispatched Tools:`, dispatchedTools);
        console.log(`[Test A] Result Summary:`, result.text.slice(0, 300));

        // Pass Criteria Check:
        // 1. Must complete cleanly
        assert.strictEqual(result.status, 'completed', 'Test A must complete with status: completed');

        // 2. Must not modify or write any files
        const writingTools = dispatchedTools.filter(t => t.name === 'write_file' || t.name === 'edit_file');
        assert.strictEqual(writingTools.length, 0, 'Must not call write_file or edit_file for an explanation request');

        // 3. Disk file remains identical
        const diskContent = fs.readFileSync(path.join(tempDir, 'authService.js'), 'utf8');
        assert.strictEqual(diskContent, authContent, 'Source file must remain untouched');

        // 4. Must reference relevant symbols and logic in explanation
        const lowerRes = result.text.toLowerCase();
        const mentionsSymbols = lowerRes.includes('generatetoken') ||
            lowerRes.includes('userid') ||
            lowerRes.includes('secretkey') ||
            lowerRes.includes('hmac') ||
            lowerRes.includes('sha256') ||
            lowerRes.includes('base64') ||
            lowerRes.includes('payload') ||
            lowerRes.includes('header');
        assert.ok(mentionsSymbols, 'Explanation must be grounded in actual source symbols');
    });

    // =========================================================================
    // Test B — Small, verifiable bug fix
    // =========================================================================
    test('Test B: Small, verifiable bug fix in calculator.js', async () => {
        const srcDir = path.join(tempDir, 'src');
        const testDir = path.join(tempDir, 'test');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(testDir, { recursive: true });

        // Buggy implementation: adds discount instead of subtracting
        const calcContent = `function calculateDiscount(price, discountPercent) {
    if (price < 0 || discountPercent < 0 || discountPercent > 100) {
        throw new Error('Invalid price or discount');
    }
    return price + (price * discountPercent / 100);
}

module.exports = { calculateDiscount };
`;
        fs.writeFileSync(path.join(srcDir, 'calculator.js'), calcContent, 'utf8');

        const testContent = `const assert = require('assert');
const { calculateDiscount } = require('../src/calculator.js');

try {
    const discounted = calculateDiscount(100, 20);
    assert.strictEqual(discounted, 80, \`Expected 80, but got \${discounted}\`);
    console.log('PASS');
    process.exit(0);
} catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
}
`;
        fs.writeFileSync(path.join(testDir, 'calculator.test.js'), testContent, 'utf8');

        // Verify that initial test actually fails
        const initialCheck = await TerminalCapture.runAndCapture('node test/calculator.test.js', tempDir);
        assert.strictEqual(initialCheck.exitCode, 1, 'Initial test fixture must fail before fix');

        const planner = new InMemoryTaskPlanner();
        const dispatchedTools: { role: string; name: string; args: any }[] = [];

        const orchestrator = new AgentOrchestrator({
            workspaceRoot: tempDir,
            config,
            client: realClient,
            tools: fullTools,
            taskPlanner: planner,
            postMessage: () => {},
            dispatchTool: async (call, role) => {
                dispatchedTools.push({ role, name: call.name, args: call.args });
                return await ToolDispatcher.dispatch(call, {
                    workspaceRoot: tempDir,
                    postMessage: () => {},
                    isEditSessionAutoApproved: true,
                    isTerminalSessionAutoApproved: true,
                    pendingTerminalResolvers: new Map(),
                    pendingEditResolvers: new Map(),
                    taskPlanner: planner,
                    activeRole: role
                });
            },
            userPrompt: 'Fix the bug in src/calculator.js so that running "node test/calculator.test.js" passes'
        });

        const startTime = Date.now();
        const result = await orchestrator.execute();
        const durationMs = Date.now() - startTime;

        console.log(`[Test B] Duration: ${durationMs}ms`);
        console.log(`[Test B] Dispatched Tools:`, dispatchedTools);

        // Verification: Run the test command again on disk
        const finalCheck = await TerminalCapture.runAndCapture('node test/calculator.test.js', tempDir);
        console.log(`[Test B] Final test check exitCode: ${finalCheck.exitCode}, output: ${finalCheck.output}`);

        assert.strictEqual(finalCheck.exitCode, 0, 'Test command must exit with code 0 after fix');
        const modifiedContent = fs.readFileSync(path.join(srcDir, 'calculator.js'), 'utf8');
        assert.ok(modifiedContent.includes('-'), 'Calculator must subtract the discount');
    });

    // =========================================================================
    // Test C — Multi-file debugging
    // =========================================================================
    test('Test C: Multi-file debugging across orderProcessor and formatters', async () => {
        const srcDir = path.join(tempDir, 'src');
        const testDir = path.join(tempDir, 'test');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(testDir, { recursive: true });

        // Root cause file: formats address but looks up postal_code instead of postalCode
        const formattersContent = `function formatAddress(record) {
    if (!record) return '';
    return \`\${record.street}, \${record.city}, \${record.postal_code}\`;
}

module.exports = { formatAddress };
`;
        fs.writeFileSync(path.join(srcDir, 'formatters.js'), formattersContent, 'utf8');

        // Calling file: delegates to formatters.js
        const orderContent = `const { formatAddress } = require('./formatters');

function generateShippingLabel(order) {
    if (!order || !order.customer) {
        throw new Error('Invalid order');
    }
    const addressStr = formatAddress(order.shippingAddress);
    return \`ORDER-\${order.id}\\nSHIP TO: \${order.customer}\\n\${addressStr}\`;
}

module.exports = { generateShippingLabel };
`;
        fs.writeFileSync(path.join(srcDir, 'orderProcessor.js'), orderContent, 'utf8');

        const testContent = `const assert = require('assert');
const { generateShippingLabel } = require('../src/orderProcessor');

try {
    const order = {
        id: 1042,
        customer: 'Alice Smith',
        shippingAddress: {
            street: '123 Market St',
            city: 'Springfield',
            postalCode: '97477'
        }
    };
    const label = generateShippingLabel(order);
    assert.ok(label.includes('97477'), \`Expected '97477' in label, but got:\\n\${label}\`);
    assert.ok(!label.includes('undefined'), \`Must not contain 'undefined':\\n\${label}\`);
    console.log('PASS');
    process.exit(0);
} catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
}
`;
        fs.writeFileSync(path.join(testDir, 'order.test.js'), testContent, 'utf8');

        // Verify initial failure
        const initialCheck = await TerminalCapture.runAndCapture('node test/order.test.js', tempDir);
        assert.strictEqual(initialCheck.exitCode, 1, 'Initial multi-file test fixture must fail');

        const planner = new InMemoryTaskPlanner();
        const dispatchedTools: { role: string; name: string; args: any }[] = [];

        const orchestrator = new AgentOrchestrator({
            workspaceRoot: tempDir,
            config,
            client: realClient,
            tools: fullTools,
            taskPlanner: planner,
            postMessage: () => {},
            dispatchTool: async (call, role) => {
                dispatchedTools.push({ role, name: call.name, args: call.args });
                return await ToolDispatcher.dispatch(call, {
                    workspaceRoot: tempDir,
                    postMessage: () => {},
                    isEditSessionAutoApproved: true,
                    isTerminalSessionAutoApproved: true,
                    pendingTerminalResolvers: new Map(),
                    pendingEditResolvers: new Map(),
                    taskPlanner: planner,
                    activeRole: role
                });
            },
            userPrompt: 'The test "node test/order.test.js" is failing. Inspect the order processing code, trace the root cause, and fix it so the test passes.'
        });

        const startTime = Date.now();
        const result = await orchestrator.execute();
        const durationMs = Date.now() - startTime;

        console.log(`[Test C] Duration: ${durationMs}ms`);
        console.log(`[Test C] Dispatched Tools:`, dispatchedTools);

        // Verification: Run test command
        const finalCheck = await TerminalCapture.runAndCapture('node test/order.test.js', tempDir);
        console.log(`[Test C] Final test check exitCode: ${finalCheck.exitCode}, output: ${finalCheck.output}`);

        assert.strictEqual(finalCheck.exitCode, 0, 'Multi-file test must pass with exit code 0');
    });
});
