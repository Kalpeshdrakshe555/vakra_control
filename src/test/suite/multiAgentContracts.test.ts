// src/test/suite/multiAgentContracts.test.ts
// Unit tests covering Multi-Agent State Transitions, Role Permission Policies, and Budget Bounds.

import * as assert from 'assert';
import { AgentRoleType } from '../../agents/types';
import {
    isToolAllowedForRole,
    filterToolsForRole,
    validateRoleToolCall,
    ROLE_ALLOWED_TOOLS,
    ROLE_PROHIBITED_TOOLS
} from '../../agents/permissions';
import { RolePromptBuilder } from '../../agents/prompts/rolePrompts';
import { ToolDispatcher } from '../../webview/tools/toolDispatcher';
import { LoopDetector } from '../../guards/loopDetector';

suite('Phase 4: Multi-Agent Role Permissions & Contract Hardening', () => {

    test('Role Permission Matrix: Allowed and Prohibited Tools', () => {
        // Planner
        assert.strictEqual(isToolAllowedForRole('planner', 'set_task_plan'), true);
        assert.strictEqual(isToolAllowedForRole('planner', 'expand_plan_step'), true);
        assert.strictEqual(isToolAllowedForRole('planner', 'write_file'), false);
        assert.strictEqual(isToolAllowedForRole('planner', 'edit_file'), false);
        assert.strictEqual(isToolAllowedForRole('planner', 'execute_terminal_command'), true);
        assert.strictEqual(isToolAllowedForRole('planner', 'finish'), false);

        // Researcher (Evidence Gathering & Environment Inspection)
        assert.strictEqual(isToolAllowedForRole('researcher', 'read_multiple_files'), true);
        assert.strictEqual(isToolAllowedForRole('researcher', 'search_codebase'), true);
        assert.strictEqual(isToolAllowedForRole('researcher', 'list_directory_tree'), true);
        assert.strictEqual(isToolAllowedForRole('researcher', 'get_symbol_outline'), true);
        assert.strictEqual(isToolAllowedForRole('researcher', 'search_web'), true);
        assert.strictEqual(isToolAllowedForRole('researcher', 'write_file'), false);
        assert.strictEqual(isToolAllowedForRole('researcher', 'edit_file'), false);
        assert.strictEqual(isToolAllowedForRole('researcher', 'execute_terminal_command'), true);
        assert.strictEqual(isToolAllowedForRole('researcher', 'finish'), false);

        // Coder (Surgical Writer, Terminal Scaffolding / Code Modification)
        assert.strictEqual(isToolAllowedForRole('coder', 'write_file'), true);
        assert.strictEqual(isToolAllowedForRole('coder', 'edit_file'), true);
        assert.strictEqual(isToolAllowedForRole('coder', 'execute_terminal_command'), true);
        assert.strictEqual(isToolAllowedForRole('coder', 'complete_plan_step'), false);
        assert.strictEqual(isToolAllowedForRole('coder', 'finish'), false);

        // Verifier (Evaluator, Terminal / Diagnostics / Complete Authority)
        assert.strictEqual(isToolAllowedForRole('verifier', 'execute_terminal_command'), true);
        assert.strictEqual(isToolAllowedForRole('verifier', 'get_code_diagnostics'), true);
        assert.strictEqual(isToolAllowedForRole('verifier', 'complete_plan_step'), true);
        assert.strictEqual(isToolAllowedForRole('verifier', 'finish'), true);
        assert.strictEqual(isToolAllowedForRole('verifier', 'write_file'), false);
        assert.strictEqual(isToolAllowedForRole('verifier', 'edit_file'), false);
    });

    test('filterToolsForRole strips prohibited tools from provider schema', () => {
        const fullToolDeclarations = [
            {
                functionDeclarations: [
                    { name: 'read_multiple_files' },
                    { name: 'write_file' },
                    { name: 'edit_file' },
                    { name: 'execute_terminal_command' },
                    { name: 'set_task_plan' },
                    { name: 'complete_plan_step' },
                    { name: 'finish' }
                ]
            }
        ];

        // Planner schema
        const plannerTools = filterToolsForRole('planner', fullToolDeclarations);
        const plannerNames = plannerTools[0].functionDeclarations.map((f: any) => f.name);
        assert.ok(plannerNames.includes('set_task_plan'));
        assert.ok(!plannerNames.includes('write_file'));
        assert.ok(plannerNames.includes('execute_terminal_command'));
        assert.ok(!plannerNames.includes('finish'));

        // Coder schema
        const coderTools = filterToolsForRole('coder', fullToolDeclarations);
        const coderNames = coderTools[0].functionDeclarations.map((f: any) => f.name);
        assert.ok(coderNames.includes('write_file'));
        assert.ok(coderNames.includes('edit_file'));
        assert.ok(coderNames.includes('execute_terminal_command'));
        assert.ok(!coderNames.includes('complete_plan_step'));
        assert.ok(!coderNames.includes('finish'));

        // Verifier schema
        const verifierTools = filterToolsForRole('verifier', fullToolDeclarations);
        const verifierNames = verifierTools[0].functionDeclarations.map((f: any) => f.name);
        assert.ok(verifierNames.includes('execute_terminal_command'));
        assert.ok(verifierNames.includes('complete_plan_step'));
        assert.ok(verifierNames.includes('finish'));
        assert.ok(!verifierNames.includes('write_file'));
        assert.ok(!verifierNames.includes('edit_file'));
    });

    test('validateRoleToolCall rejects prohibited and malformed calls with structured error', () => {
        // Coder attempting to execute planning command
        const coderPlanCheck = validateRoleToolCall('coder', 'set_task_plan', { steps: ['Step 1'] });
        assert.strictEqual(coderPlanCheck.allowed, false);
        assert.ok(coderPlanCheck.error?.includes("Tool 'set_task_plan' is prohibited for agent role 'coder'"));

        // Researcher attempting to write a file
        const researchWriteCheck = validateRoleToolCall('researcher', 'write_file', { filepath: 'foo.ts', content: 'code' });
        assert.strictEqual(researchWriteCheck.allowed, false);
        assert.ok(researchWriteCheck.error?.includes("Tool 'write_file' is prohibited for agent role 'researcher'"));

        // Verifier attempting to edit a file
        const verifierEditCheck = validateRoleToolCall('verifier', 'edit_file', { filepath: 'foo.ts', old_text: 'a', new_text: 'b' });
        assert.strictEqual(verifierEditCheck.allowed, false);
        assert.ok(verifierEditCheck.error?.includes("Tool 'edit_file' is prohibited for agent role 'verifier'"));

        // Malformed Coder edit_file (missing old_text / new_text)
        const malformedEdit = validateRoleToolCall('coder', 'edit_file', { filepath: 'foo.ts' });
        assert.strictEqual(malformedEdit.allowed, false);
        assert.ok(malformedEdit.error?.includes('Malformed edit_file'));

        // Valid Coder edit_file
        const validEdit = validateRoleToolCall('coder', 'edit_file', { filepath: 'foo.ts', old_text: 'x', new_text: 'y' });
        assert.strictEqual(validEdit.allowed, true);
    });

    test('ToolDispatcher dual-layer enforcement blocks prohibited role tool calls at dispatch', async () => {
        const dummyContext: any = {
            workspaceRoot: 'd:/vs_code_coding_agent/vakra_control',
            postMessage: () => {},
            isEditSessionAutoApproved: true,
            isTerminalSessionAutoApproved: true,
            pendingTerminalResolvers: new Map(),
            pendingEditResolvers: new Map(),
            taskPlanner: { getSteps: () => [] },
            activeRole: 'coder' as AgentRoleType
        };

        // Coder attempting to execute set_task_plan through dispatcher
        const res = await ToolDispatcher.dispatch(
            { name: 'set_task_plan', args: { steps: ['Step 1'] } },
            dummyContext
        );
        assert.ok(typeof res === 'string');
        assert.ok(res.startsWith('Error: Permission denied: Tool \'set_task_plan\' is prohibited for agent role \'coder\''));

        // Researcher attempting to write file through dispatcher
        const res2 = await ToolDispatcher.dispatch(
            { name: 'write_file', args: { filepath: 'test.txt', content: 'hello' } },
            { ...dummyContext, activeRole: 'researcher' as AgentRoleType }
        );
        assert.ok(typeof res2 === 'string');
        assert.ok(res2.startsWith('Error: Permission denied: Tool \'write_file\' is prohibited for agent role \'researcher\''));
    });

    test('LoopDetector catches identical repeated tool calls across multi-turn handoffs', () => {
        const detector = new LoopDetector();
        const callA = { tool: 'read_multiple_files', argsHash: LoopDetector.hashArgs({ paths: ['src/a.ts'] }) };
        
        // Turn 1: initial call allowed, then recorded
        const check1 = detector.check(callA);
        assert.strictEqual(check1.repeat, false);
        detector.record({ ...callA, resultOk: true });

        // Turn 2: repeat call flagged
        const check2 = detector.check(callA);
        assert.strictEqual(check2.repeat, true);
        assert.ok(check2.message?.includes('You already executed tool'));

        // Turn 3: different arguments allowed
        const callB = { tool: 'read_multiple_files', argsHash: LoopDetector.hashArgs({ paths: ['src/b.ts'] }) };
        const check3 = detector.check(callB);
        assert.strictEqual(check3.repeat, false);
    });

    test('RolePromptBuilder constructs compact, role-bounded system instructions', () => {
        const plannerInstruction = RolePromptBuilder.buildSystemInstruction('planner');
        assert.ok(plannerInstruction.includes('PLANNER'));
        assert.ok(plannerInstruction.includes('set_task_plan'));
        assert.ok(plannerInstruction.includes('FORBIDDEN from writing, editing, or modifying code'));

        const researcherInstruction = RolePromptBuilder.buildSystemInstruction('researcher');
        assert.ok(researcherInstruction.includes('RESEARCHER'));
        assert.ok(researcherInstruction.includes('strictly READ-ONLY'));

        const coderInstruction = RolePromptBuilder.buildSystemInstruction('coder');
        assert.ok(coderInstruction.includes('CODER'));
        assert.ok(coderInstruction.includes('FORBIDDEN from running terminal verification'));

        const verifierInstruction = RolePromptBuilder.buildSystemInstruction('verifier');
        assert.ok(verifierInstruction.includes('VERIFIER'));
        assert.ok(verifierInstruction.includes('EMPIRICAL PROOF ONLY'));
    });
});
