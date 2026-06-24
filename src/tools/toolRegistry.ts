import * as fs from 'fs';
import * as path from 'path';

export interface AgentTool {
    name: string;
    description: string;
    parameters: string;
    execute: (args: string, workspaceRoot: string) => Promise<string>;
}

export class ToolRegistry {
    private static tools: Map<string, AgentTool> = new Map();

    public static registerTool(tool: AgentTool) {
        this.tools.set(tool.name.toLowerCase(), tool);
    }

    public static loadWorkspacePlugins(workspaceRoot: string) {
        const pluginsPath = path.join(workspaceRoot, '.ultra-light-ai', 'plugins.js');
        if (fs.existsSync(pluginsPath)) {
            try {
                // Clear existing workspace plugins to reload
                // For safety, we should delete require cache but keeping it simple
                delete require.cache[require.resolve(pluginsPath)];
                const userPlugins = require(pluginsPath);
                if (Array.isArray(userPlugins)) {
                    for (const p of userPlugins) {
                        if (p.name && p.execute) {
                            this.registerTool(p);
                        }
                    }
                }
            } catch (e) {
                console.error("Failed to load workspace plugins", e);
            }
        }
    }

    public static getAvailableToolsPrompt(): string {
        if (this.tools.size === 0) return '';
        let prompt = `\n\n### PLUGINS & TOOLS ###\nYou have access to the following custom tools defined by the user. To use a tool, ask the user to run it, or if you have autonomous execution enabled, output \`@tool <tool_name> <args>\`.\n`;
        for (const tool of this.tools.values()) {
            prompt += `- **${tool.name}**: ${tool.description} | Args format: ${tool.parameters}\n`;
        }
        return prompt;
    }

    public static async executeTool(name: string, args: string, workspaceRoot: string): Promise<string> {
        const tool = this.tools.get(name.toLowerCase());
        if (!tool) throw new Error(`Tool ${name} not found`);
        return await tool.execute(args, workspaceRoot);
    }
}
