const fs = require('fs');
const path = require('path');
const os = require('os');
require('../out/test/suite/mockVscode.js');
const { createConfiguredClient } = require('../out/router/realClients.js');
const { AgentOrchestrator } = require('../out/agents/agentOrchestrator.js');
const { ToolDispatcher } = require('../out/webview/tools/toolDispatcher.js');
const { InMemoryTaskPlanner } = require('../out/state/inMemoryTaskPlanner.js');
const { TerminalCapture } = require('../out/tools/terminalCapture.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vakra-bench-c-'));
const srcDir = path.join(tempDir, 'src');
const testDir = path.join(tempDir, 'test');
fs.mkdirSync(srcDir, { recursive: true });
fs.mkdirSync(testDir, { recursive: true });

// Root cause file: formats address using postal_code instead of postalCode
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

const cfg = JSON.parse(fs.readFileSync('C:\\Users\\admin\\.ultra-light-ai\\config.json', 'utf8'));
const client = createConfiguredClient(cfg).client;
const planner = new InMemoryTaskPlanner();

const t0 = Date.now();

const orch = new AgentOrchestrator({
    workspaceRoot: tempDir,
    config: cfg,
    client: client,
    tools: [
        {
            functionDeclarations: [
                { name: 'read_multiple_files', description: 'Read files', parameters: { type: 'object', properties: { filepaths: { type: 'array', items: { type: 'string' } } }, required: ['filepaths'] } },
                { name: 'edit_file', description: 'Edit file', parameters: { type: 'object', properties: { filepath: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['filepath', 'old_text', 'new_text'] } },
                { name: 'execute_terminal_command', description: 'Run command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
                { name: 'set_task_plan', description: 'Set plan', parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] } },
                { name: 'complete_plan_step', description: 'Complete step', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
                { name: 'finish', description: 'Finish task', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } }
            ]
        }
    ],
    taskPlanner: planner,
    postMessage: (msg) => {
        if (msg.command === 'statusUpdate') console.log(`[${Date.now() - t0}ms] [STATUS]: ${msg.text}`);
    },
    dispatchTool: async (call, role) => {
        console.log(`[${Date.now() - t0}ms] [TOOL CALL]: Role=${role}, Tool=${call.name}, Args=${JSON.stringify(call.args)}`);
        const res = await ToolDispatcher.dispatch(call, {
            workspaceRoot: tempDir,
            postMessage: () => {},
            isEditSessionAutoApproved: true,
            isTerminalSessionAutoApproved: true,
            pendingTerminalResolvers: new Map(),
            pendingEditResolvers: new Map(),
            taskPlanner: planner,
            activeRole: role
        });
        console.log(`[${Date.now() - t0}ms] [TOOL RESULT]: ${typeof res === 'string' ? res.slice(0, 200) : JSON.stringify(res).slice(0, 200)}`);
        return res;
    },
    userPrompt: 'The test "node test/order.test.js" is failing. Inspect the order processing code, trace the root cause, and fix it so the test passes.'
});

console.log(`[0ms] Starting Test C execution...`);
// Verify initial failure
TerminalCapture.runAndCapture('node test/order.test.js', tempDir).then(initial => {
    console.log(`[0ms] Initial test check exitCode: ${initial.exitCode}, output: ${initial.output}`);
    return orch.execute();
}).then(async res => {
    const elapsed = Date.now() - t0;
    console.log(`[${elapsed}ms] [FINISHED] status=${res.status}`);
    console.log(`Response:`, res.text.slice(0, 300));

    const finalCheck = await TerminalCapture.runAndCapture('node test/order.test.js', tempDir);
    console.log(`[${elapsed}ms] Final test check exitCode: ${finalCheck.exitCode}, output: ${finalCheck.output}`);

    const finalFormatters = fs.readFileSync(path.join(srcDir, 'formatters.js'), 'utf8');
    console.log(`Final formatters.js on disk:\n`, finalFormatters);

    const finalOrder = fs.readFileSync(path.join(srcDir, 'orderProcessor.js'), 'utf8');
    console.log(`Final orderProcessor.js on disk:\n`, finalOrder);

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

    if (finalCheck.exitCode === 0) {
        console.log(`[RESULT]: TEST C PASSED`);
        process.exit(0);
    } else {
        console.log(`[RESULT]: TEST C FAILED`);
        process.exit(1);
    }
}).catch(err => {
    console.error(`Execution error:`, err);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    process.exit(1);
});
