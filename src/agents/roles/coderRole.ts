// src/agents/roles/coderRole.ts
// Specialist Coder role execution handler (Surgical File Creation and Modification).

import { RoleTurnInput, RoleTurnResult, CoderResult, CodeChangeSpec } from '../types';
import { filterToolsForRole } from '../permissions';
import { RolePromptBuilder } from '../prompts/rolePrompts';

export class CoderRoleHandler {
    public static async execute(
        input: RoleTurnInput,
        client: any,
        tools: any[],
        dispatchTool: (call: any) => Promise<any>,
        onStreamChunk?: (chunk: any) => void
    ): Promise<RoleTurnResult> {
        const roleTools = filterToolsForRole('coder', tools);
        const systemInstruction = RolePromptBuilder.buildSystemInstruction('coder');
        const prompt = RolePromptBuilder.buildTurnPrompt('coder', {
            userPrompt: input.userPrompt,
            activeStep: input.activeStep,
            research: input.researchFindings,
            previousFailure: input.previousFailure,
            planSummary: input.planStepsSummary,
            stateLedgerSummary: input.stateLedgerSummary,
            workspaceRoot: input.workspaceRoot
        });

        const toolCallsExecuted: Array<{ tool: string; args: any; result: any }> = [];
        const changes: CodeChangeSpec[] = [];

        const onToolCall = async (call: any) => {
            const result = await dispatchTool(call);
            toolCallsExecuted.push({ tool: call.name, args: call.args, result });

            if (call.name === 'write_file') {
                changes.push({
                    filepath: call.args?.filepath || 'unknown',
                    action: 'create',
                    reason: 'File written by Coder',
                    diffSnippet: typeof result === 'string' ? result.slice(0, 300) : ''
                });
            } else if (call.name === 'edit_file') {
                changes.push({
                    filepath: call.args?.filepath || 'unknown',
                    action: 'edit',
                    reason: 'File edited by Coder',
                    diffSnippet: typeof result === 'string' ? result.slice(0, 300) : ''
                });
            } else if (call.name === 'execute_terminal_command') {
                changes.push({
                    filepath: 'CLI Command',
                    action: 'create',
                    reason: `Executed: ${call.args?.command || 'command'}`,
                    diffSnippet: typeof result === 'string' ? result.slice(0, 300) : ''
                });
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

        const codeResult: CoderResult = {
            summary: completion?.text || 'Code changes applied.',
            changes,
            blueprint: {
                targetFiles: changes.map(c => c.filepath),
                logicAddedOrModified: completion?.text ? completion.text.slice(0, 300) : 'Implementation applied.'
            }
        };

        return {
            role: 'coder',
            text: completion?.text || '',
            toolCallsExecuted,
            usage: completion?.usage,
            codeResult
        };
    }
}
