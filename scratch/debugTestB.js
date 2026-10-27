const fs = require('fs');
const path = require('path');
const os = require('os');
require('../out/test/suite/mockVscode.js');
const { createConfiguredClient } = require('../out/router/realClients.js');
const { AgentOrchestrator } = require('../out/agents/agentOrchestrator.js');
const { ToolDispatcher } = require('../out/webview/tools/toolDispatcher.js');
const { InMemoryTaskPlanner } = require('../out/state/inMemoryTaskPlanner.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vakra-debug-b-'));
const srcDir = path.join(tempDir, 'src');
const testDir = path.join(tempDir, 'test');
fs.mkdirSync(srcDir, { recursive: true });
fs.mkdirSync(testDir, { recursive: true });

fs.writeFileSync(
    path.join(srcDir, 'calculator.js'),
    `function calculateDiscount(price, discountPercent) {\n    return price + (price * discountPercent / 100);\n}\nmodule.exports = { calculateDiscount };\n`,
    'utf8'
);

fs.writeFileSync(
    path.join(testDir, 'calculator.test.js'),
    `const assert = require('assert');\nconst { calculateDiscount } = require('../src/calculator.js');\nconst res = calculateDiscount(100, 20);\nassert.strictEqual(res, 80);\nconsole.log('PASS');\n`,
    'utf8'
);

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
        console.log(`[${Date.now() - t0}ms] [TOOL RESULT]: ${typeof res === 'string' ? res.slice(0, 150) : JSON.stringify(res).slice(0, 150)}`);
        return res;
    },
    userPrompt: 'Fix the bug in src/calculator.js so that running "node test/calculator.test.js" passes'
});

console.log(`[0ms] Starting execution...`);
orch.execute().then(res => {
    console.log(`[${Date.now() - t0}ms] [FINISHED] status=${res.status}`);
    console.log(`Response:`, res.text.slice(0, 300));
    const finalCalc = fs.readFileSync(path.join(srcDir, 'calculator.js'), 'utf8');
    console.log(`Final calculator.js on disk:`, finalCalc);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    process.exit(0);
}).catch(err => {
    console.error(`Execution error:`, err);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    process.exit(1);
});
