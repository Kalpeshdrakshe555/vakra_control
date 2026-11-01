// src/agents/roles/plannerRole.ts
// Specialist Planner role execution handler.

import { RoleTurnInput, RoleTurnResult } from '../types';
import { filterToolsForRole } from '../permissions';
import { RolePromptBuilder } from '../prompts/rolePrompts';

export class PlannerRoleHandler {
    public static async execute(
        input: RoleTurnInput,
        client: any,
        tools: any[],
        dispatchTool: (call: any) => Promise<any>,
        onStreamChunk?: (chunk: any) => void
    ): Promise<RoleTurnResult> {
        const roleTools = filterToolsForRole('planner', tools);
        const systemInstruction = RolePromptBuilder.buildSystemInstruction('planner');
        const prompt = RolePromptBuilder.buildTurnPrompt('planner', {
            userPrompt: input.userPrompt,
            modelName: input.modelName,
            repoMap: input.planStepsSummary,
            workspaceRoot: input.workspaceRoot
        });

        const toolCallsExecuted: Array<{ tool: string; args: any; result: any }> = [];
        let planCreated = false;

        const onToolCall = async (call: any) => {
            const result = await dispatchTool(call);
            toolCallsExecuted.push({ tool: call.name, args: call.args, result });
            if (call.name === 'set_task_plan' || call.name === 'expand_plan_step') {
                planCreated = true;
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

        return {
            role: 'planner',
            text: completion?.text || '',
            toolCallsExecuted,
            usage: completion?.usage,
            planCreated
        };
    }
}
