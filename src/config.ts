import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Loads a .env file from the specified path and returns parsed key-value pairs.
 */
function loadEnvFile(envPath: string): Record<string, string> {
    const envVars: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
        try {
            const content = fs.readFileSync(envPath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) {
                    continue;
                }
                const firstEqualIndex = trimmed.indexOf('=');
                if (firstEqualIndex === -1) {
                    continue;
                }
                const key = trimmed.slice(0, firstEqualIndex).trim();
                let val = trimmed.slice(firstEqualIndex + 1).trim();
                // Strip surrounding quotes
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                envVars[key] = val;
            }
        } catch (error) {
            console.error(`Failed to read env file at ${envPath}:`, error);
        }
    }
    return envVars;
}

/**
 * Loads the agent configuration object from the workspace if it exists.
 */
export function getAgentConfig(workspaceRoot?: string): AgentConfig | null {
    if (!workspaceRoot) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            workspaceRoot = workspaceFolders[0].uri.fsPath;
        }
    }
    if (workspaceRoot) {
        const configPath = path.join(workspaceRoot, '.agent-config.json');
        if (fs.existsSync(configPath)) {
            try {
                const content = fs.readFileSync(configPath, 'utf8');
                return JSON.parse(content) as AgentConfig;
            } catch (error) {
                console.error('Failed to parse .agent-config.json:', error);
            }
        }
    }
    return null;
}

/**
 * Retrieves Gemini API Keys from configuration, env files, or falls back to a hardcoded key.
 */
export function getGeminiApiKeys(workspaceRoot?: string, extensionPath?: string): string[] {
    // 1. Try loading from .agent-config.json
    const config = getAgentConfig(workspaceRoot);
    if (config?.providers?.cloud?.apiKey) {
        const keys = config.providers.cloud.apiKey.split(',').map(k => k.trim()).filter(Boolean);
        if (keys.length > 0) {
            return keys;
        }
    }

    // 2. Try loading from env files
    let keys: string[] = [];
    const searchDirs: string[] = [];
    if (workspaceRoot) {
        searchDirs.push(workspaceRoot);
    }
    if (extensionPath) {
        searchDirs.push(extensionPath);
    }

    for (const dir of searchDirs) {
        const rootEnvPath = path.join(dir, '.env');
        const srcEnvPath = path.join(dir, 'src', '.env');

        const rootEnv = loadEnvFile(rootEnvPath);
        const srcEnv = loadEnvFile(srcEnvPath);

        const geminiApiKey = srcEnv['gemini_api_key'] || srcEnv['GEMINI_API_KEY'] || 
                             rootEnv['gemini_api_key'] || rootEnv['GEMINI_API_KEY'];

        if (geminiApiKey) {
            keys = geminiApiKey.split(',').map(k => k.trim()).filter(Boolean);
            break;
        }
    }

    if (keys.length > 0) {
        return keys;
    }

    // 3. No fallback key provided for security reasons.
    return [];
}


export function getGeminiModel(workspaceRoot?: string): string {
    // 1. Try loading from .agent-config.json
    const config = getAgentConfig(workspaceRoot);
    if (config?.providers?.cloud?.model) {
        return config.providers.cloud.model.trim();
    }

    // 2. Try loading from environment variables
    if (!workspaceRoot) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            workspaceRoot = workspaceFolders[0].uri.fsPath;
        }
    }
    if (workspaceRoot) {
        const rootEnvPath = path.join(workspaceRoot, '.env');
        const srcEnvPath = path.join(workspaceRoot, 'src', '.env');

        const rootEnv = loadEnvFile(rootEnvPath);
        const srcEnv = loadEnvFile(srcEnvPath);

        const envModel = srcEnv['GEMINI_MODEL'] || srcEnv['gemini_model'] ||
                         rootEnv['GEMINI_MODEL'] || rootEnv['gemini_model'];
        if (envModel) {
            return envModel.trim();
        }
    }

    // 3. Default fallback
    return 'gemma-4-31b-it';
}

/**
 * Retrieves the API timeout duration in milliseconds.
 */
export function getGeminiTimeout(workspaceRoot?: string): number {
    const config = getAgentConfig(workspaceRoot);
    if (config?.providers?.cloud?.timeoutSeconds) {
        return config.providers.cloud.timeoutSeconds * 1000;
    }

    if (!workspaceRoot) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            workspaceRoot = workspaceFolders[0].uri.fsPath;
        }
    }
    if (workspaceRoot) {
        const rootEnvPath = path.join(workspaceRoot, '.env');
        const srcEnvPath = path.join(workspaceRoot, 'src', '.env');

        const rootEnv = loadEnvFile(rootEnvPath);
        const srcEnv = loadEnvFile(srcEnvPath);

        const envTimeout = srcEnv['GEMINI_TIMEOUT_SECONDS'] || srcEnv['gemini_timeout_seconds'] ||
                           rootEnv['GEMINI_TIMEOUT_SECONDS'] || rootEnv['gemini_timeout_seconds'];
        if (envTimeout) {
            const parsed = parseInt(envTimeout, 10);
            if (!isNaN(parsed) && parsed > 0) {
                return parsed * 1000;
            }
        }
    }

    // Default to 60 seconds
    return 60000;
}


export const CONFIG = {
    MAX_CONTEXT_TOKENS: 6000,
    SYSTEM_PROMPT_TOKENS: 150,
    USER_PROMPT_TOKENS: 200,
    COOLDOWN_DELAY_MS: 5000,
    CIRCUIT_BREAKER_DURATION_MS: 15 * 60 * 1000,
} as const;

export interface AgentConfig {
    providers: {
        cloud: { model: string; apiKey: string; rpmLimit: number; timeoutSeconds?: number };
        local?: { model: string; endpoint: string };
    };
    activeProvider: 'cloud' | 'local';
    contextLimits: { maxTokens: number; historyLength: number };
    systemInstructions: string;
}

/**
 * Generates an .agent-config.json file at the root of the workspace if it doesn't exist.
 */
export function ensureAgentConfig(workspaceRoot: string): void {
    const configPath = path.join(workspaceRoot, '.agent-config.json');
    if (!fs.existsSync(configPath)) {
        const defaultConfig: AgentConfig = {
            providers: {
                cloud: { 
                    model: "gemma-4-31b-it", 
                    apiKey: "", 
                    rpmLimit: 15,
                    timeoutSeconds: 60
                }
            },
            activeProvider: "cloud",
            contextLimits: { maxTokens: 8000, historyLength: 10 },
            systemInstructions: "You are an AI coding agent. Always wrap your code solutions in standard markdown code blocks."
        };
        try {
            fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
            
            // Auto-add to .gitignore
            const gitignorePath = path.join(workspaceRoot, '.gitignore');
            let gitignoreContent = '';
            if (fs.existsSync(gitignorePath)) {
                gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            }
            if (!gitignoreContent.includes('.agent-config.json')) {
                fs.appendFileSync(gitignorePath, '\n# Ultra Light AI\n.agent-config.json\n.chat-history.json\n');
            }
        } catch (error) {
            console.error('Failed to generate agent configuration file:', error);
        }
    }
}
