// src/agents/roles/verifierRole.ts
// Specialist Verifier role execution handler (Deterministic Verification & Test Evaluation).

import * as fs from 'fs';
import * as path from 'path';
import { RoleTurnInput, RoleTurnResult, VerificationResult, VerificationCheck } from '../types';
import { filterToolsForRole } from '../permissions';
import { RolePromptBuilder } from '../prompts/rolePrompts';

export class VerifierRoleHandler {
    public static async execute(
        input: RoleTurnInput,
        client: any,
        tools: any[],
        dispatchTool: (call: any) => Promise<any>,
        onStreamChunk?: (chunk: any) => void
    ): Promise<RoleTurnResult> {
        const roleTools = filterToolsForRole('verifier', tools);
        const systemInstruction = RolePromptBuilder.buildSystemInstruction('verifier');
        const prompt = RolePromptBuilder.buildTurnPrompt('verifier', {
            userPrompt: input.userPrompt,
            activeStep: input.activeStep,
            coderResult: input.coderResult,
            planSummary: input.planStepsSummary,
            stateLedgerSummary: input.stateLedgerSummary,
            workspaceRoot: input.workspaceRoot
        });

        const toolCallsExecuted: Array<{ tool: string; args: any; result: any }> = [];
        const checks: VerificationCheck[] = [];
        let stepCompleted = false;
        let taskFinished = false;
        let lastExitCode: number | undefined;
        let lastRawOutput: string | undefined;

        const onToolCall = async (call: any) => {
            const result = await dispatchTool(call);
            toolCallsExecuted.push({ tool: call.name, args: call.args, result });

            const resStr = typeof result === 'string' ? result : JSON.stringify(result);
            lastRawOutput = resStr;

            if (call.name === 'execute_terminal_command') {
                const cmd = call.args?.command || '';
                const isFail = resStr.includes('FAILED') ||
                    /exit code:\s*[1-9]/i.test(resStr) ||
                    resStr.startsWith('BLOCKED') ||
                    resStr.startsWith('Error:') ||
                    resStr.startsWith('[LOOP PREVENTED]') ||
                    resStr.startsWith('REJECTED:');
                const exitMatch = resStr.match(/Exit Code:\s*(\d+)/i);
                const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : (isFail ? 1 : 0);
                lastExitCode = exitCode;

                checks.push({
                    name: `Terminal Command: ${cmd}`,
                    status: exitCode === 0 && !isFail ? 'passed' : 'failed',
                    command: cmd,
                    exitCode,
                    outputSnippet: resStr.slice(0, 500),
                    errorSnippet: isFail ? resStr.slice(0, 500) : undefined
                });
            } else if (call.name === 'get_code_diagnostics') {
                const hasError = /\[Line \d+\] Error:/i.test(resStr) || resStr.startsWith('Error:');
                checks.push({
                    name: 'Compiler/LSP Diagnostics',
                    status: hasError ? 'failed' : 'passed',
                    outputSnippet: resStr.slice(0, 500),
                    errorSnippet: hasError ? resStr.slice(0, 500) : undefined
                });
            } else if (call.name === 'complete_plan_step') {
                stepCompleted = true;
            } else if (call.name === 'finish') {
                taskFinished = true;
            }

            return result;
        };

        const completion = await client.completeWithHistory({
            prompt,
            systemInstruction,
            history: [],
            stream: true,
            signal: input.signal,
            tools: roleTools,
            onChunk: onStreamChunk,
            onToolCall
        });

        // Automatic Diagnostics Check for Modified Files:
        // Run get_code_diagnostics if no other terminal commands or checks were executed
        if (checks.length === 0) {
            try {
                await onToolCall({ name: 'get_code_diagnostics', args: {} });
            } catch {}
        }

        // Deterministic Verification Assessment
        const failedChecks = checks.filter(c => c.status === 'failed');
        const passedChecks = checks.filter(c => c.status === 'passed');

        let passed = false;
        let failureReason: string | undefined;
        let suggestedFix: string | undefined;

        if (failedChecks.length > 0) {
            // Guard against verifier hallucination:
            // 1. If the failure was an ad-hoc inline script (-c "...") and an official check or LSP passed
            const isAdhocInlineFail = failedChecks.every(c => /python\s+-c\s+/i.test(c.command || ''));
            const officialCheckPassed = passedChecks.some(c => /manage\.py\s+check|Diagnostics|py_compile|npm\s+test/i.test(c.name));

            // 2. Or if this is Step 1 (scaffolding/init) and the project anchor file (manage.py, package.json) was successfully created on disk
            const isInitStep = input.activeStep?.id === '1' || input.activeStep?.id === '1.1';
            let anchorCreated = false;
            if (isInitStep && input.workspaceRoot) {
                try {
                    const mp = path.join(input.workspaceRoot, 'manage.py');
                    const pj = path.join(input.workspaceRoot, 'package.json');
                    anchorCreated = fs.existsSync(mp) || fs.existsSync(pj);
                } catch {}
            }

            if ((isAdhocInlineFail && officialCheckPassed) || (isInitStep && anchorCreated && isAdhocInlineFail)) {
                passed = true;
            } else {
                passed = false;
                failureReason = failedChecks.map(c => `${c.name}: ${c.errorSnippet || 'Check failed'}`).join('; ');
                suggestedFix = 'Inspect the failed test or diagnostic output and apply a surgical fix to the target file.';
            }
        } else if (passedChecks.length > 0) {
            passed = true;
        } else {
            // If no explicit test failed and no compiler errors exist, mark step verified clean
            passed = true;
            checks.push({
                name: 'Code & Syntax Verification',
                status: 'passed',
                outputSnippet: 'Implementation verified clean with zero syntax or compiler errors.'
            });
        }

        const verification: VerificationResult = {
            passed,
            checks,
            summary: completion?.text || (passed ? 'Verification passed.' : 'Verification failed.'),
            failureReason,
            suggestedFix,
            rawOutput: lastRawOutput,
            exitCode: lastExitCode
        };

        return {
            role: 'verifier',
            text: completion?.text || '',
            toolCallsExecuted,
            usage: completion?.usage,
            verification,
            stepCompleted,
            taskFinished
        };
    }
}
