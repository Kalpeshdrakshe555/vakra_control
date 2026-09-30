import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentConfig } from '../config';

export class SettingsHandler {
    public static async handleSaveSettings(
        message: any, 
        workspaceRoot: string, 
        getAiMetaDir: (root: string) => string, 
        postMessage: (msg: any) => void
    ): Promise<void> {
        try {
            // Global Save logic: Save in user's home directory to share across projects and prevent GitHub leaks
            const os = require('os');
            const globalDir = path.join(os.homedir(), '.ultra-light-ai');
            if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });
            const configPath = path.join(globalDir, 'config.json');

            const isAdvancedMode = !!(message.config.mainBrain && message.config.supportBrain && message.config.supportBrain.model);

            const newConfig: AgentConfig = {
                // Preserve Legacy structure so older systems don't crash
                providers: {
                    cloud: {
                        model: message.config.mainBrain?.providerType === 'cloud' ? message.config.mainBrain.model : 'gemini-1.5-pro',
                        apiKey: message.config.mainBrain?.apiKey || '',
                        rpmLimit: 15,
                        timeoutSeconds: Number(message.config.timeoutSeconds)
                    },
                    local: {
                        model: message.config.mainBrain?.providerType === 'local' ? message.config.mainBrain.model : 'llama3',
                        endpoint: message.config.mainBrain?.endpoint || 'http://127.0.0.1:11434'
                    }
                },
                activeProvider: message.config.mainBrain?.providerType || 'cloud',

                // New Dual-Brain Config
                mainBrain: message.config.mainBrain,
                supportBrain: message.config.supportBrain,
                advancedModeEnabled: isAdvancedMode,

                maxAutonomousToolSteps: Math.min(100, Math.max(5, Number(message.config.maxAutonomousToolSteps) || 30)),

                contextLimits: {
                    maxOutputTokens: Number(message.config.maxOutputTokens || message.config.maxTokens || 8192),
                    maxContextTokens: Number(message.config.maxContextTokens || 7000),
                    historyLength: Number(message.config.historyLength || 10)
                },
                systemInstructions: message.config.systemInstructions
            };

            fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');
            
            // SMART SAVE FIX: Save workspace-specific settings to a dedicated, git-ignorable folder.
            const aiMetaDir = getAiMetaDir(workspaceRoot);
            const localConfigPath = path.join(aiMetaDir, 'workspace-config.json');
            fs.writeFileSync(localConfigPath, JSON.stringify(newConfig, null, 2), 'utf8');
            
            // Clean up legacy config files from old locations
            const legacyConfigPath = path.join(workspaceRoot, '.agent-config.json');
            if (fs.existsSync(legacyConfigPath)) {
                try { fs.unlinkSync(legacyConfigPath); } catch (e) {}
            }
            const oldVscodeConfigPath = path.join(workspaceRoot, '.vscode', 'ultra-light-ai.json');
            if (fs.existsSync(oldVscodeConfigPath)) {
                try { fs.unlinkSync(oldVscodeConfigPath); } catch (e) {}
            }

            // Save VS Code extension settings
            if (message.config.enableInlineCompletions !== undefined || message.config.enableHoverExplanations !== undefined) {
                const vsConfig = vscode.workspace.getConfiguration('ultraLightAI');
                if (message.config.enableInlineCompletions !== undefined) {
                    await vsConfig.update('enableInlineCompletions', message.config.enableInlineCompletions, vscode.ConfigurationTarget.Global);
                }
                if (message.config.enableHoverExplanations !== undefined) {
                    await vsConfig.update('enableHoverExplanations', message.config.enableHoverExplanations, vscode.ConfigurationTarget.Global);
                }
            }

            vscode.window.showInformationMessage('✨ Configuration saved successfully!');
            
            postMessage({
                command: 'settingsSaved',
                success: true,
                model: message.config.model
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to save settings: ${error?.message || error}`);
            postMessage({
                command: 'settingsSaved',
                success: false,
                error: error?.message || error
            });
        }
    }
}
