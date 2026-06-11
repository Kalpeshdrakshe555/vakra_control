import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as os from 'os';

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
 * Loads the agent configuration object from the workspace.
 */
export function getAgentConfig(workspaceRoot?: string): AgentConfig | null {
    if (!workspaceRoot) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            workspaceRoot = workspaceFolders[0].uri.fsPath;
        }
    }
    
    // 1. Load Global Config (Secure, cross-project, prevents GitHub leaks)
    const globalConfigPath = path.join(os.homedir(), '.ultra-light-ai', 'config.json');
    let config: AgentConfig | null = null;
    
    if (fs.existsSync(globalConfigPath)) {
        try {
            config = JSON.parse(fs.readFileSync(globalConfigPath, 'utf8')) as AgentConfig;
        } catch (error) { console.error('Failed to parse global config:', error); }
    }

    // 2. Load Workspace Override (if user manually created one for a specific project)
    if (workspaceRoot) {
        const localConfigPath = path.join(workspaceRoot, '.vscode', 'ultra-light-ai.json');
        const legacyConfigPath = path.join(workspaceRoot, '.agent-config.json');
        const workspacePath = fs.existsSync(localConfigPath) ? localConfigPath : (fs.existsSync(legacyConfigPath) ? legacyConfigPath : null);
        if (workspacePath) {
            try {
                const workspaceConfig = JSON.parse(fs.readFileSync(workspacePath, 'utf8')) as AgentConfig;
                config = config ? { ...config, ...workspaceConfig } : workspaceConfig;
            } catch (error) { console.error('Failed to parse workspace config:', error); }
        }
    }
    return config;
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

        if (geminiApiKey && !geminiApiKey.includes('your_api_key_here')) {
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

export interface BrainConfig {
    providerType: 'cloud' | 'local';
    model: string;
    apiKey: string;
    endpoint: string;
}

export interface AgentConfig {
    // Legacy fields for backward compatibility
    providers?: {
        cloud?: { model: string; apiKey: string; rpmLimit: number; timeoutSeconds?: number };
        local?: { model: string; endpoint: string };
    };
    activeProvider?: 'cloud' | 'local';

    // New Dual-Brain Architecture
    mainBrain?: BrainConfig;
    supportBrain?: BrainConfig;
    advancedModeEnabled?: boolean;

    contextLimits: { 
        maxTokens?: number; 
        maxOutputTokens?: number; 
        maxContextTokens?: number; 
        historyLength: number 
    };
    systemInstructions: string;
}

/**
 * Generates an .agent-config.json file at the workspace if it doesn't exist.
 */
export function ensureAgentConfig(workspaceRoot: string): void {
    // Create it globally to protect API keys from GitHub and share across projects
    const globalDir = path.join(os.homedir(), '.ultra-light-ai');
    if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });
    const configPath = path.join(globalDir, 'config.json');

    if (!fs.existsSync(configPath)) {
        const defaultConfig: AgentConfig = {
            mainBrain: {
                providerType: "cloud",
                model: "gemini-1.5-pro",
                apiKey: "",
                endpoint: "https://generativelanguage.googleapis.com/v1beta/models/"
            },
            supportBrain: {
                providerType: "cloud",
                model: "llama-3.1-8b-instant",
                apiKey: "",
                endpoint: "https://api.groq.com/openai"
            },
            advancedModeEnabled: false, // Default to normal mode until user configures supportBrain
            contextLimits: { maxTokens: 8192, historyLength: 10 },
            systemInstructions: "You are an AI coding agent. Always wrap your code solutions in standard markdown code blocks."
        };
        try {
            fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
        } catch (error) {
            console.error('Failed to generate agent configuration file:', error);
        }
    }
}
