// src/agents/roles/researcherRole.ts
// Specialist Researcher role execution handler (Read-Only Evidence Gathering).

import { RoleTurnInput, RoleTurnResult, ResearchFindings, AgentEvidence } from '../types';
import { filterToolsForRole } from '../permissions';
import { RolePromptBuilder } from '../prompts/rolePrompts';

export class ResearcherRoleHandler {
    public static async execute(
        input: RoleTurnInput,
        client: any,
        tools: any[],
        dispatchTool: (call: any) => Promise<any>,
        onStreamChunk?: (chunk: any) => void
    ): Promise<RoleTurnResult> {
        const roleTools = filterToolsForRole('researcher', tools);
        const systemInstruction = RolePromptBuilder.buildSystemInstruction('researcher');
        const prompt = RolePromptBuilder.buildTurnPrompt('researcher', {
            userPrompt: input.userPrompt,
            activeStep: input.activeStep,
            planSummary: input.planStepsSummary,
            stateLedgerSummary: input.stateLedgerSummary,
            workspaceRoot: input.workspaceRoot
        });

        const toolCallsExecuted: Array<{ tool: string; args: any; result: any }> = [];
        const targetFilesSet = new Set<string>();
        const evidenceList: AgentEvidence[] = [];

        const onToolCall = async (call: any) => {
            const result = await dispatchTool(call);
            toolCallsExecuted.push({ tool: call.name, args: call.args, result });

            if (call.name === 'read_multiple_files') {
                const paths = call.args?.filepaths || call.args?.paths || [call.args?.filepath];
                (Array.isArray(paths) ? paths : [paths]).filter(Boolean).forEach((p: string) => {
                    targetFilesSet.add(p);
                    evidenceList.push({
                        filepath: p,
                        snippet: typeof result === 'string' ? result.slice(0, 400) : '',
                        relevance: 'Inspected file context'
                    });
                });
            } else if (call.name === 'search_codebase') {
                evidenceList.push({
                    filepath: 'Codebase Search Query: ' + (call.args?.query || ''),
                    snippet: typeof result === 'string' ? result.slice(0, 400) : '',
                    relevance: 'Search matches'
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

        const research: ResearchFindings = {
            summary: completion?.text || 'Research completed.',
            targetFiles: Array.from(targetFilesSet),
            evidence: evidenceList,
            recommendedApproach: completion?.text ? completion.text.slice(0, 300) : undefined
        };

        return {
            role: 'researcher',
            text: completion?.text || '',
            toolCallsExecuted,
            usage: completion?.usage,
            research
        };
    }
}
