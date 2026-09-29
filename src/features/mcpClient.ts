import * as fs from 'fs';
import * as path from 'path';

export interface McpServerConfig {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export class McpClientManager {
    public static getConfigPath(workspaceRoot: string): string {
        return path.join(workspaceRoot, '.ultra-light-ai', 'mcp_config.json');
    }

    public static loadConfig(workspaceRoot: string): McpServerConfig[] {
        const configPath = this.getConfigPath(workspaceRoot);
        if (!fs.existsSync(configPath)) {
            // Create default template if missing
            const template: McpServerConfig[] = [
                {
                    name: "sample-filesystem-mcp",
                    command: "npx",
                    args: ["-y", "@modelcontextprotocol/server-filesystem", workspaceRoot]
                }
            ];
            try {
                const dir = path.dirname(configPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(configPath, JSON.stringify(template, null, 2), 'utf8');
            } catch (e) {
                console.error("Failed to write default MCP config", e);
            }
            return template;
        }

        try {
            const raw = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(raw);
        } catch (e) {
            console.error("Failed to parse mcp_config.json", e);
            return [];
        }
    }
}
