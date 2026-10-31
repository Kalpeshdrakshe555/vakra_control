// src/test/suite/multiAgentWorkflow.test.ts
// Integration tests covering the complete Deterministic Multi-Agent Workflow,
// failure recovery, fast-path routing, retry limits, and cancellation.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentOrchestrator } from '../../agents/agentOrchestrator';
import { ToolDispatcher } from '../../webview/tools/toolDispatcher';
import { InMemoryTaskPlanner } from '../../state/inMemoryTaskPlanner';

suite('Phase 4: Multi-Agent Workflow & Recovery Verification', () => {
    let tempDir: string;

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vakra-multi-agent-'));
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

    test('Fast-path greeting routes directly without calling planning or coding tools', async () => {
        let toolsCalled = 0;
        const mockClient = {
            completeWithHistory: async (opts: any) => {
                if (opts.tools && opts.tools.length > 0) {
                    toolsCalled += opts.tools[0].functionDeclarations.length;
                }
                return { text: 'Hello! I am Vakra AI. How can I assist you with your project today?' };
            }
        };

        const planner = new InMemoryTaskPlanner();
        const orchestrator = new AgentOrchestrator({
            workspaceRoot: tempDir,
            config: {},
            client: mockClient,
            tools: [],
            taskPlanner: planner,
            postMessage: () => {},
            dispatchTool: async (call, role) => {
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
            userPrompt: 'Hello there!'
        });

        const res = await orchestrator.execute();
        assert.strictEqual(res.status, 'completed');
        assert.ok(res.text.includes('Hello! I am Vakra AI'));
        assert.strictEqual(toolsCalled, 0, 'Fast-path greeting must not declare or invoke tools');
    });

    test('Complete Workflow: Plan -> Research -> Coder Bug -> Verifier Failure -> Coder Recovery -> Pass -> Complete', async () => {
        const mathFile = path.join(tempDir, 'math.js');
        fs.writeFileSync(mathFile, 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n', 'utf8');

        const planner = new InMemoryTaskPlanner();
        let turnCounter = 0;

        // Multi-turn simulated provider that mimics the 4 roles:
        // Turn 1 (Planner): establishes plan with Step 1
        // Turn 2 (Researcher): reads math.js
        // Turn 3 (Coder Attempt 1): writes intentional bug (multiply returns a + b instead of a * b)
        // Turn 4 (Verifier Attempt 1): tests multiply via node command -> FAILS!
        // Turn 5 (Coder Attempt 2, Recovery): fixes multiply to a * b
        // Turn 6 (Verifier Attempt 2): re-tests multiply via node command -> PASSES (exitCode 0) and completes step!
        const mockClient = {
            completeWithHistory: async (opts: any) => {
                turnCounter++;

                if (opts.systemInstruction.includes('PLANNER')) {
                    if (opts.onToolCall) {
                        await opts.onToolCall({
                            name: 'set_task_plan',
                            args: {
                                user_requirements: 'Add multiply function to math.js and verify',
                                steps: ['Step 1: Add multiply function to math.js and verify with node test']
                            }
                        });
                    }
                    return { text: 'Established roadmap in PLAN.md.' };
                }

                if (opts.systemInstruction.includes('RESEARCHER')) {
                    if (opts.onToolCall) {
                        await opts.onToolCall({
                            name: 'read_multiple_files',
                            args: { filepaths: ['math.js'] }
                        });
                    }
                    return { text: 'Inspected math.js: found add function export.' };
                }

                if (opts.systemInstruction.includes('CODER')) {
                    if (opts.prompt.includes('PREVIOUS VERIFICATION FAILURE')) {
                        // Recovery turn (Attempt 2): fix the bug surgically!
                        if (opts.onToolCall) {
                            await opts.onToolCall({
                                name: 'edit_file',
                                args: {
                                    filepath: 'math.js',
                                    old_text: 'function multiply(a, b) { return a + b; }',
                                    new_text: 'function multiply(a, b) { return a * b; }'
                                }
                            });
                        }
                        return { text: 'Corrected multiply function to return a * b.' };
                    } else {
                        // Initial turn (Attempt 1): inject intentional buggy code!
                        if (opts.onToolCall) {
                            await opts.onToolCall({
                                name: 'write_file',
                                args: {
                                    filepath: 'math.js',
                                    content: 'function add(a, b) { return a + b; }\nfunction multiply(a, b) { return a + b; }\nmodule.exports = { add, multiply };\n'
                                }
                            });
                        }
                        return { text: 'Added multiply function with initial logic.' };
                    }
                }

                if (opts.systemInstruction.includes('VERIFIER')) {
                    // Verifier executes a node assertion command to test multiply(2, 3) === 6
                    if (opts.onToolCall) {
                        await opts.onToolCall({
                            name: 'execute_terminal_command',
                            args: {
                                command: 'node -e "const { multiply } = require(\'./math.js\'); if (multiply(2, 3) !== 6) process.exit(1);"'
                            }
                        });
                    }

                    // Check if the file on disk currently passes
                    const diskContent = fs.readFileSync(mathFile, 'utf8');
                    const isBuggy = diskContent.includes('return a + b; }');

                    if (isBuggy && !diskContent.includes('return a * b; }')) {
                        return { text: 'Verification failed: multiply(2, 3) returned 5 instead of 6.' };
                    } else {
                        if (opts.onToolCall) {
                            await opts.onToolCall({
                                name: 'complete_plan_step',
                                args: {
                                    sub_step_id: '1',
                                    summary: 'Verified multiply function passes unit assertion'
                                }
                            });
                        }
                        return { text: 'Verification passed: multiply(2, 3) === 6.' };
                    }
                }

                return { text: 'Done.' };
            }
        };

        const orchestrator = new AgentOrchestrator({
            workspaceRoot: tempDir,
            config: {},
            client: mockClient,
            tools: [],
            taskPlanner: planner,
            postMessage: () => {},
            dispatchTool: async (call, role) => {
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
            userPrompt: 'Add multiply function to math.js and verify'
        });

        const res = await orchestrator.execute();

        assert.strictEqual(res.status, 'completed');
        const finalDiskContent = fs.readFileSync(mathFile, 'utf8');
        assert.ok(finalDiskContent.includes('return a * b; }'), 'Final file on disk must have the corrected implementation');
        assert.ok(turnCounter >= 5, 'Must have traversed Planner -> Researcher -> Coder -> Verifier -> Recovery loop');
    });

    test('Retry exhaustion halts safely at max attempts when test cannot be resolved', async () => {
        const dummyFile = path.join(tempDir, 'broken.js');
        fs.writeFileSync(dummyFile, 'console.log("broken");\n', 'utf8');

        const planner = new InMemoryTaskPlanner();
        let coderAttempts = 0;

        // Provider that always fails verification
        const mockClient = {
            completeWithHistory: async (opts: any) => {
                if (opts.systemInstruction.includes('PLANNER')) {
                    if (opts.onToolCall) {
                        await opts.onToolCall({
                            name: 'set_task_plan',
                            args: { steps: ['Step 1: Fix broken feature'] }
                        });
                    }
                    return { text: 'Plan set.' };
                }

                if (opts.systemInstruction.includes('RESEARCHER')) {
                    return { text: 'Research done.' };
                }

                if (opts.systemInstruction.includes('CODER')) {
                    coderAttempts++;
                    return { text: `Applied edit attempt ${coderAttempts}` };
                }

                if (opts.systemInstruction.includes('VERIFIER')) {
                    if (opts.onToolCall) {
                        // Always run a failing command (exit code 1)
                        await opts.onToolCall({
                            name: 'execute_terminal_command',
                            args: { command: 'node -e "process.exit(1);"' }
                        });
                    }
                    return { text: 'Test assertion continuously failing with exitCode 1.' };
                }

                return { text: 'Done.' };
            }
        };

        const orchestrator = new AgentOrchestrator({
            workspaceRoot: tempDir,
            config: {},
            client: mockClient,
            tools: [],
            taskPlanner: planner,
            postMessage: () => {},
            dispatchTool: async (call, role) => {
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
            userPrompt: 'Fix broken feature'
        });

        const res = await orchestrator.execute();
        assert.strictEqual(res.status, 'failed', 'Orchestrator must halt with failed status when retries exhaust');
        assert.ok(res.text.includes('failed after 2 attempts'), 'Must state retry exhaustion explicitly');
        assert.strictEqual(coderAttempts, 2, 'Must not exceed maxAttempts = 2');
    });

    test('AbortSignal terminates orchestrator promptly', async () => {
        const abortCtrl = new AbortController();
        const planner = new InMemoryTaskPlanner();

        const mockClient = {
            completeWithHistory: async () => {
                // Abort during first model call
                abortCtrl.abort();
                return { text: 'Aborted.' };
            }
        };

        const orchestrator = new AgentOrchestrator({
            workspaceRoot: tempDir,
            config: {},
            client: mockClient,
            tools: [],
            taskPlanner: planner,
            postMessage: () => {},
            dispatchTool: async (call, role) => 'ok',
            signal: abortCtrl.signal,
            userPrompt: 'Long running task'
        });

        const res = await orchestrator.execute();
        assert.strictEqual(res.status, 'aborted');
    });

    test('Simple info question routes to Researcher only without invoking Planner or Coder', async () => {
        let plannerInvoked = false;
        let coderInvoked = false;
        let researcherInvoked = false;

        const mockClient = {
            completeWithHistory: async (opts: any) => {
                if (opts.systemInstruction.includes('PLANNER')) plannerInvoked = true;
                if (opts.systemInstruction.includes('CODER')) coderInvoked = true;
                if (opts.systemInstruction.includes('RESEARCHER')) {
                    researcherInvoked = true;
                    return { text: 'The payment service handles credit card transactions and webhooks.' };
                }
                return { text: 'Information response.' };
            }
        };

        const planner = new InMemoryTaskPlanner();
        const orchestrator = new AgentOrchestrator({
            workspaceRoot: tempDir,
            config: {},
            client: mockClient,
            tools: [],
            taskPlanner: planner,
            postMessage: () => {},
            dispatchTool: async (call, role) => 'ok',
            userPrompt: 'explain how the payment module works'
        });

        const res = await orchestrator.execute();
        assert.strictEqual(res.status, 'completed');
        assert.ok(researcherInvoked, 'Researcher role must be invoked for info query');
        assert.strictEqual(plannerInvoked, false, 'Planner must not be invoked for info query');
        assert.strictEqual(coderInvoked, false, 'Coder must not be invoked for info query');
        assert.ok(res.text.includes('payment service handles'));
    });

    test('Small, safe direct file edit modifies file and verifies cleanly', async () => {
        const configPath = path.join(tempDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({ port: 3000, debug: false }, null, 2), 'utf8');

        const planner = new InMemoryTaskPlanner();
        let editApplied = false;

        const mockClient = {
            completeWithHistory: async (opts: any) => {
                if (opts.systemInstruction.includes('PLANNER')) {
                    return { text: 'Ready.' };
                }
                if (opts.systemInstruction.includes('RESEARCHER')) {
                    return { text: 'Found config.json with port 3000.' };
                }
                if (opts.systemInstruction.includes('CODER')) {
                    if (opts.onToolCall) {
                        await opts.onToolCall({
                            name: 'edit_file',
                            args: {
                                filepath: 'config.json',
                                old_text: '"port": 3000',
                                new_text: '"port": 8080'
                            }
                        });
                        editApplied = true;
                    }
                    return { text: 'Updated port to 8080.' };
                }
                if (opts.systemInstruction.includes('VERIFIER')) {
                    if (opts.onToolCall) {
                        await opts.onToolCall({
                            name: 'execute_terminal_command',
                            args: { command: 'node -e "const c = require(\'./config.json\'); if (c.port !== 8080) process.exit(1);"' }
                        });
                    }
                    return { text: 'Port verified as 8080.' };
                }
                return { text: 'Done.' };
            }
        };

        const orchestrator = new AgentOrchestrator({
            workspaceRoot: tempDir,
            config: {},
            client: mockClient,
            tools: [],
            taskPlanner: planner,
            postMessage: () => {},
            dispatchTool: async (call, role) => {
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
            userPrompt: 'Change the port to 8080 in config.json'
        });

        const res = await orchestrator.execute();
        assert.strictEqual(res.status, 'completed');
        assert.ok(editApplied, 'Edit must be applied');
        const content = fs.readFileSync(configPath, 'utf8');
        assert.ok(content.includes('"port": 8080'));
    });

    test('Forbidden tool call is intercepted and denied by dispatcher during role execution', async () => {
        let errorReceived = '';

        const mockClient = {
            completeWithHistory: async (opts: any) => {
                if (opts.systemInstruction.includes('PLANNER')) {
                    return { text: 'Direct task.' };
                }
                if (opts.systemInstruction.includes('RESEARCHER')) {
                    return { text: 'Research done.' };
                }
                if (opts.systemInstruction.includes('CODER')) {
                    // Coder illegally attempts to call set_task_plan!
                    if (opts.onToolCall) {
                        const callRes = await opts.onToolCall({
                            name: 'set_task_plan',
                            args: { steps: ['hacked'] }
                        });
                        errorReceived = String(callRes);
                    }
                    return { text: 'Attempted command.' };
                }
                if (opts.systemInstruction.includes('VERIFIER')) {
                    if (opts.onToolCall) {
                        await opts.onToolCall({
                            name: 'execute_terminal_command',
                            args: { command: 'node -e "process.exit(0);"' }
                        });
                    }
                    return { text: 'Verified.' };
                }
                return { text: 'Done.' };
            }
        };

        const planner = new InMemoryTaskPlanner();
        const orchestrator = new AgentOrchestrator({
            workspaceRoot: tempDir,
            config: {},
            client: mockClient,
            tools: [],
            taskPlanner: planner,
            postMessage: () => {},
            dispatchTool: async (call, role) => {
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
            userPrompt: 'Test role permissions'
        });

        await orchestrator.execute();
        assert.ok(
            errorReceived.includes('Permission denied') && errorReceived.includes('set_task_plan'),
            `Dispatcher must fail closed with permission denied: ${errorReceived}`
        );
    });

    test('Approval-required action generates approval card and respects user acceptance/rejection', async () => {
        const targetFile = path.join(tempDir, 'sensitive.txt');
        fs.writeFileSync(targetFile, 'original content\n', 'utf8');

        const planner = new InMemoryTaskPlanner();
        const postedMessages: any[] = [];
        const pendingEditResolvers = new Map<string, (approved: boolean, autoApprove?: boolean) => void>();

        let userRejected = false;

        const mockClient = {
            completeWithHistory: async (opts: any) => {
                if (opts.systemInstruction.includes('PLANNER')) return { text: 'Plan.' };
                if (opts.systemInstruction.includes('RESEARCHER')) return { text: 'Research.' };
                if (opts.systemInstruction.includes('CODER')) {
                    if (opts.onToolCall) {
                        // Edit request that requires approval
                        const editRes = await opts.onToolCall({
                            name: 'edit_file',
                            args: {
                                filepath: 'sensitive.txt',
                                old_text: 'original content',
                                new_text: 'modified content'
                            }
                        });
                        if (String(editRes).includes('User rejected')) {
                            userRejected = true;
                        }
                    }
                    return { text: 'Coder turn finished.' };
                }
                if (opts.systemInstruction.includes('VERIFIER')) {
                    if (opts.onToolCall) {
                        await opts.onToolCall({
                            name: 'execute_terminal_command',
                            args: { command: 'node -e "process.exit(0);"' }
                        });
                    }
                    return { text: 'Verified.' };
                }
                return { text: 'Done.' };
            }
        };

        const orchestrator = new AgentOrchestrator({
            workspaceRoot: tempDir,
            config: {},
            client: mockClient,
            tools: [],
            taskPlanner: planner,
            postMessage: (msg) => {
                postedMessages.push(msg);
                if (msg.command === 'toolCallEvent' && msg.data?.callId) {
                    const callId = msg.data.callId;
                    setImmediate(() => {
                        const resolver = pendingEditResolvers.get(callId);
                        if (resolver) {
                            resolver(false); // User clicks REJECT
                        }
                    });
                }
            },
            dispatchTool: async (call, role) => {
                return await ToolDispatcher.dispatch(call, {
                    workspaceRoot: tempDir,
                    postMessage: (msg) => {
                        postedMessages.push(msg);
                        if (msg.command === 'toolCallEvent' && msg.data?.callId) {
                            const callId = msg.data.callId;
                            setImmediate(() => {
                                const resolver = pendingEditResolvers.get(callId);
                                if (resolver) {
                                    resolver(false); // User clicks REJECT
                                }
                            });
                        }
                    },
                    isEditSessionAutoApproved: false, // APPROVAL REQUIRED!
                    isTerminalSessionAutoApproved: true,
                    pendingTerminalResolvers: new Map(),
                    pendingEditResolvers: pendingEditResolvers,
                    taskPlanner: planner,
                    activeRole: role
                });
            },
            userPrompt: 'Modify sensitive.txt'
        });

        await orchestrator.execute();

        // 1. Approval card event was posted to webview
        const approvalCard = postedMessages.find(m => m.command === 'toolCallEvent' && m.tool === 'edit_file');
        assert.ok(approvalCard, 'Approval card event must be posted to webview');
        assert.strictEqual(approvalCard.data.isAutoApproved, false);

        // 2. User rejection was honored
        assert.strictEqual(userRejected, true, 'User rejection must be reported to the agent');

        // 3. File content on disk was NOT changed
        const diskContent = fs.readFileSync(targetFile, 'utf8');
        assert.strictEqual(diskContent, 'original content\n', 'File content must remain unchanged when rejected');
    });

    test('Cancellation during pending approval aborts cleanly and leaves file untouched', async () => {
        const targetFile = path.join(tempDir, 'pending_abort.txt');
        fs.writeFileSync(targetFile, 'initial data\n', 'utf8');

        const abortCtrl = new AbortController();
        const planner = new InMemoryTaskPlanner();
        const pendingEditResolvers = new Map<string, (approved: boolean, autoApprove?: boolean) => void>();

        const mockClient = {
            completeWithHistory: async (opts: any) => {
                if (opts.systemInstruction.includes('PLANNER')) return { text: 'Plan.' };
                if (opts.systemInstruction.includes('RESEARCHER')) return { text: 'Research.' };
                if (opts.systemInstruction.includes('CODER')) {
                    if (opts.onToolCall) {
                        return await opts.onToolCall({
                            name: 'edit_file',
                            args: {
                                filepath: 'pending_abort.txt',
                                old_text: 'initial data',
                                new_text: 'cancelled data'
                            }
                        });
                    }
                    return { text: 'Coder done.' };
                }
                return { text: 'Done.' };
            }
        };

        const orchestrator = new AgentOrchestrator({
            workspaceRoot: tempDir,
            config: {},
            client: mockClient,
            tools: [],
            taskPlanner: planner,
            postMessage: (msg) => {
                if (msg.command === 'toolCallEvent' && msg.data?.callId) {
                    setImmediate(() => {
                        abortCtrl.abort();
                    });
                }
            },
            dispatchTool: async (call, role) => {
                return await ToolDispatcher.dispatch(call, {
                    workspaceRoot: tempDir,
                    postMessage: (msg) => {
                        if (msg.command === 'toolCallEvent' && msg.data?.callId) {
                            setImmediate(() => {
                                abortCtrl.abort();
                            });
                        }
                    },
                    signal: abortCtrl.signal,
                    isEditSessionAutoApproved: false,
                    isTerminalSessionAutoApproved: true,
                    pendingTerminalResolvers: new Map(),
                    pendingEditResolvers: pendingEditResolvers,
                    taskPlanner: planner,
                    activeRole: role
                });
            },
            signal: abortCtrl.signal,
            userPrompt: 'Update pending_abort.txt'
        });

        const res = await orchestrator.execute();
        assert.strictEqual(res.status, 'aborted');
        const diskContent = fs.readFileSync(targetFile, 'utf8');
        assert.strictEqual(diskContent, 'initial data\n', 'File must remain untouched when cancelled during approval');
    });
});
