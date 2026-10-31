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
            research: input.researchFindings,
            planSummary: input.planStepsSummary,
            stateLedgerSummary: input.stateLedgerSummary,
            workspaceRoot: input.workspaceRoot
        });

        const toolCallsExecuted: Array<{ tool: string; args: any; result: any }> = [];
        const targetFilesSet = new Set<string>(input.researchFindings?.targetFiles || []);
        const evidenceList: AgentEvidence[] = [...(input.researchFindings?.evidence || [])];

        const onToolCall = async (call: any) => {
            const result = await dispatchTool(call);
            toolCallsExecuted.push({ tool: call.name, args: call.args, result });
            const resStr = typeof result === 'string' ? result : JSON.stringify(result);

            if (call.name === 'read_multiple_files') {
                const paths = call.args?.filepaths || call.args?.paths || [call.args?.filepath];
                (Array.isArray(paths) ? paths : [paths]).filter(Boolean).forEach((p: string) => {
                    targetFilesSet.add(p);
                    evidenceList.push({
                        filepath: p,
                        snippet: resStr.slice(0, 25000),
                        relevance: 'Inspected file context'
                    });
                });
            } else if (call.name === 'search_codebase') {
                evidenceList.push({
                    filepath: 'Codebase Search Query: ' + (call.args?.query || ''),
                    snippet: resStr.slice(0, 8000),
                    relevance: 'Search matches'
                });
            } else if (call.name === 'search_web' || call.name === 'research_web_docs') {
                evidenceList.push({
                    filepath: 'Live Web Documentation: ' + (call.args?.query || call.args?.library || 'Web Search'),
                    snippet: resStr.slice(0, 10000),
                    relevance: 'Latest online documentation & solutions'
                });
            } else if (call.name === 'list_directory_tree' || call.name === 'get_symbol_outline' || call.name === 'get_code_diagnostics') {
                evidenceList.push({
                    filepath: `Tool Output (${call.name})`,
                    snippet: resStr.slice(0, 6000),
                    relevance: `Workspace inspection via ${call.name}`
                });
            } else if (call.name === 'execute_terminal_command') {
                evidenceList.push({
                    filepath: `Terminal Command (${call.args?.command || 'command'})`,
                    snippet: resStr.slice(0, 8000),
                    relevance: 'CLI inspection & environment output'
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

        const combinedSummary = [
            input.researchFindings?.summary,
            completion?.text
        ].filter(Boolean).join('\n\n') || 'Research completed.';

        const research: ResearchFindings = {
            summary: combinedSummary,
            targetFiles: Array.from(targetFilesSet),
            evidence: evidenceList,
            recommendedApproach: completion?.text ? completion.text.slice(0, 400) : input.researchFindings?.recommendedApproach
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
