// src/agents/roles/verifierRole.ts
// Specialist Verifier role execution handler (Deterministic Verification & Test Evaluation).

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

        // Deterministic Verification Assessment
        const failedChecks = checks.filter(c => c.status === 'failed');
        const passedChecks = checks.filter(c => c.status === 'passed');

        let passed = false;
        let failureReason: string | undefined;
        let suggestedFix: string | undefined;

        if (failedChecks.length > 0) {
            passed = false;
            failureReason = failedChecks.map(c => `${c.name}: ${c.errorSnippet || 'Check failed'}`).join('; ');
            suggestedFix = 'Inspect the failed test or diagnostic output and apply a surgical fix to the target file.';
        } else if (passedChecks.length > 0) {
            passed = true;
        } else {
            // Missing verification evidence = unverified, not passed!
            // Strictly enforce empirical proof: model cannot self-authorize completion without running checks
            passed = false;
            failureReason = 'No verification command or diagnostics check was executed. Step remains unverified.';
            suggestedFix = 'Run an empirical test or check command (execute_terminal_command or get_code_diagnostics) to verify the change.';
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
