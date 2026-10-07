import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PatchApplier } from './patchApplier';
import { FileVersioning } from '../../operations/fileVersioning';
import { SettingsHandler } from '../settingsHandler';
import { TerminalCapture } from '../../tools/terminalCapture';
import { SessionMemory } from '../../state/sessionMemory';
import { getAgentConfig } from '../../config';

export interface DispatchContext {
    workspaceRoot: string;
    conversationHistory: any;
    taskPlanner: any;
    postMessage: (msg: any) => void;
    handleChatMessageStream: (msg: any) => Promise<void>;
    handleRunInTerminal: (cmd: string) => Promise<void>;
    handleRequestWorkspaceFiles: (query: string) => Promise<void>;
    isEditSessionAutoApproved: boolean;
    isTerminalSessionAutoApproved: boolean;
    setEditSessionAutoApproved: (val: boolean) => void;
    setTerminalSessionAutoApproved: (val: boolean) => void;
    pendingTerminalResolvers: Map<string, (approvedOrResult: any, autoApproveSession?: boolean, command?: string) => void>;
    pendingEditResolvers?: Map<string, (approved: boolean, autoApproveSession?: boolean) => void>;
    getAiMetaDir: (root: string) => string;
    abortCurrentStream?: () => void;
}

export class MessageDispatcher {
    public static async dispatch(message: any, ctx: DispatchContext): Promise<void> {
        const { workspaceRoot, postMessage, conversationHistory, taskPlanner } = ctx;

        switch (message.command) {
            case 'ready': {
                const config = getAgentConfig(workspaceRoot);
                const vsConfig = vscode.workspace.getConfiguration('ultraLightAI');
                postMessage({
                    command: 'loadSettings',
                    config: {
                        mainBrain: config?.mainBrain,
                        providers: config?.providers,
                        activeProvider: config?.activeProvider,
                        timeoutSeconds: config?.providers?.cloud?.timeoutSeconds || 60,
                        systemInstructions: config?.systemInstructions || 'You are an AI coding agent.',
                        maxOutputTokens: config?.contextLimits?.maxOutputTokens || 8192,
                        maxContextTokens: config?.contextLimits?.maxContextTokens || 7000,
                        historyLength: config?.contextLimits?.historyLength || 10,
                        maxAutonomousToolSteps: config?.maxAutonomousToolSteps || 30,
                        enableInlineCompletions: vsConfig.get('enableInlineCompletions', false),
                        enableHoverExplanations: vsConfig.get('enableHoverExplanations', false)
                    }
                });

                postMessage({
                    command: 'syncSessionAutoApply',
                    autoApply: ctx.isEditSessionAutoApproved
                });

                const messages = conversationHistory.getAllMessages();
                if (messages && messages.length > 0) {
                    postMessage({ command: 'restoreHistory', messages });
                }
                break;
            }

            case 'sendChatStream': {
                await ctx.handleChatMessageStream(message);
                break;
            }

            case 'stopGeneration':
            case 'abortStream': {
                if (ctx.abortCurrentStream) {
                    ctx.abortCurrentStream();
                }
                // UI locally resets cleanly; do not emit redundant error chunks
                return;
            }

            case 'rollbackChat': {
                if (message.timestamp) {
                    const messages = conversationHistory.getAllMessages();
                    const targetIdx = messages.findIndex((m: any) => m.timestamp === message.timestamp);
                    let revertedCount = 0;

                    if (targetIdx !== -1) {
                        const msgsToRevert = messages.slice(targetIdx);
                        const fileToOldestContent = new Map<string, string | null>();

                        for (const msg of msgsToRevert) {
                            if ((msg as any).fileBackups) {
                                for (const backup of (msg as any).fileBackups) {
                                    if (!fileToOldestContent.has(backup.filepath)) {
                                        fileToOldestContent.set(backup.filepath, backup.content);
                                    }
                                }
                            }
                        }

                        for (const [filepath, content] of fileToOldestContent.entries()) {
                            try {
                                if (content === null) {
                                    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
                                    revertedCount++;
                                } else {
                                    fs.writeFileSync(filepath, content, 'utf8');
                                    revertedCount++;
                                }
                            } catch (e) {
                                console.error('Rollback file error:', filepath, e);
                            }
                        }

                        const userMsg = messages[targetIdx];
                        if (userMsg && userMsg.role === 'user') {
                            postMessage({
                                command: 'injectChat',
                                text: userMsg.text
                            });
                        }
                    }

                    const success = conversationHistory.rollbackToTimestamp(message.timestamp);
                    if (success) {
                        postMessage({
                            command: 'restoreHistory',
                            messages: conversationHistory.getAllMessages()
                        });
                        postMessage({
                            command: 'statusUpdate',
                            text: `⏪ Rollback complete: Reverted ${revertedCount} file(s) and restored prompt.`
                        });
                        vscode.window.showInformationMessage(`⏪ Chat rolled back. Restored previous workspace state.`);
                    }
                }
                break;
            }

            case 'deleteChat': {
                if (message.timestamp) {
                    const success = conversationHistory.deleteMessageByTimestamp(message.timestamp);
                    if (success) {
                        postMessage({
                            command: 'restoreHistory',
                            messages: conversationHistory.getAllMessages()
                        });
                    }
                }
                break;
            }

            case 'setSessionAutoApplyEdits': {
                const active = !!message.autoApply;
                ctx.setEditSessionAutoApproved(active);
                ctx.setTerminalSessionAutoApproved(active);
                postMessage({
                    command: 'statusUpdate',
                    text: active ? '⚡ Auto-apply active: All file edits will apply automatically.' : 'Manual approval restored for file edits.'
                });
                break;
            }

            case 'applyWorkspaceEdits': {
                await PatchApplier.applyEdits(message, workspaceRoot, conversationHistory, postMessage);
                break;
            }

            case 'previewDiff': {
                await PatchApplier.previewDiff(message.file, workspaceRoot);
                break;
            }

            case 'resolveTerminalApproval': {
                const { callId, action, cmd } = message;
                const finalCmd = (cmd || '').replace(/^[\$#>]\s*/, '').trim();

                if (action === 'always') {
                    ctx.setTerminalSessionAutoApproved(true);
                }

                const resolver = ctx.pendingTerminalResolvers.get(callId);
                if (resolver) {
                    ctx.pendingTerminalResolvers.delete(callId);
                    if (action === 'skip') {
                        resolver(`[COMMAND SKIPPED BY USER]\nCommand: '${finalCmd}' was skipped.`);
                    } else {
                        postMessage({ command: 'statusUpdate', text: `⚡ Running: ${finalCmd}...` });
                        TerminalCapture.runAndCapture(finalCmd, workspaceRoot).then(res => {
                            if (workspaceRoot) SessionMemory.getInstance(workspaceRoot).recordToolResult('execute_terminal_command', { command: finalCmd }, res.output || (res.error ? 'Error' : '') || '', res.exitCode === 0);
                            postMessage({
                                command: 'terminalCommandCompleted',
                                callId,
                                exitCode: res.exitCode,
                                error: res.error,
                                output: res.output,
                                commandText: finalCmd
                            });
                            resolver(`[TERMINAL EXECUTION ${res.error ? 'FAILED' : 'SUCCESS'}]\nExit Code: ${res.exitCode}\nOutput: ${res.output || '(No output)'}`);
                        });
                    }
                }
                break;
            }

            case 'runAndCapture': {
                if (message.autoApproveSession) {
                    ctx.setTerminalSessionAutoApproved(true);
                }
                if (workspaceRoot && message.cmd) {
                    const isDaemon = TerminalCapture.isDaemonCommand(message.cmd);
                    if (isDaemon) {
                        await ctx.handleRunInTerminal(message.cmd);
                        postMessage({ command: 'statusUpdate', text: `🚀 Started dev server: ${message.cmd}` });
                        return;
                    }
                    TerminalCapture.runAndCapture(message.cmd, workspaceRoot).then(res => {
                        postMessage({
                            command: 'statusUpdate',
                            text: res.error ? `⚠️ Command failed (Exit: ${res.exitCode})` : `✅ Command completed (Exit: 0)`
                        });
                        postMessage({
                            command: 'injectChatAndSend',
                            text: `[TERMINAL EXECUTION ${res.error ? 'FAILED' : 'SUCCESS'}]\nCommand: \`${message.cmd}\`\nOutput:\n\`\`\`\n${res.output || '(No output)'}\n\`\`\``
                        });
                    });
                }
                break;
            }

            case 'requestWorkspaceFiles': {
                await ctx.handleRequestWorkspaceFiles(message.query || '');
                break;
            }

            case 'saveSettings': {
                await SettingsHandler.handleSaveSettings(message, workspaceRoot, ctx.getAiMetaDir, postMessage);
                break;
            }

            case 'getSessions': {
                postMessage({
                    command: 'showSessions',
                    sessions: conversationHistory.getAllSessionsSummary(),
                    currentSessionId: conversationHistory.getActiveSessionId()
                });
                break;
            }

            case 'newSession': {
                conversationHistory.createNewSession();
                postMessage({
                    command: 'showSessions',
                    sessions: conversationHistory.getAllSessionsSummary(),
                    currentSessionId: conversationHistory.getActiveSessionId()
                });
                postMessage({ command: 'restoreHistory', messages: [] });
                break;
            }

            case 'switchSession': {
                if (message.id) {
                    conversationHistory.switchSession(message.id);
                    postMessage({
                        command: 'showSessions',
                        sessions: conversationHistory.getAllSessionsSummary(),
                        currentSessionId: conversationHistory.getActiveSessionId()
                    });
                    postMessage({ command: 'restoreHistory', messages: conversationHistory.getAllMessages() });
                }
                break;
            }

            case 'deleteSession': {
                if (message.id) {
                    conversationHistory.deleteSession(message.id);
                    postMessage({
                        command: 'showSessions',
                        sessions: conversationHistory.getAllSessionsSummary(),
                        currentSessionId: conversationHistory.getActiveSessionId()
                    });
                    postMessage({ command: 'restoreHistory', messages: conversationHistory.getAllMessages() });
                }
                break;
            }

            case 'openMcpConfig': {
                if (workspaceRoot) {
                    const aiDir = path.join(workspaceRoot, '.ultra-light-ai');
                    if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir, { recursive: true });
                    const mcpFile = path.join(aiDir, 'mcp.json');
                    if (!fs.existsSync(mcpFile)) {
                        const template = {
                            mcpServers: {
                                filesystem: {
                                    command: "npx",
                                    args: ["-y", "@modelcontextprotocol/server-filesystem", workspaceRoot]
                                }
                            }
                        };
                        fs.writeFileSync(mcpFile, JSON.stringify(template, null, 2), 'utf8');
                    }
                    const doc = await vscode.workspace.openTextDocument(mcpFile);
                    await vscode.window.showTextDocument(doc);
                } else {
                    vscode.window.showWarningMessage('Please open a workspace folder to configure MCP.');
                }
                break;
            }

            case 'openPluginsScript': {
                if (workspaceRoot) {
                    const aiDir = path.join(workspaceRoot, '.ultra-light-ai');
                    if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir, { recursive: true });
                    const pluginFile = path.join(aiDir, 'plugins.js');
                    if (!fs.existsSync(pluginFile)) {
                        const template = `// Ultra Light AI - Custom Workspace Plugins\n// Export an array of custom tool objects to extend the agent's capabilities.\nmodule.exports = [\n  {\n    name: 'workspace_health',\n    description: 'Checks custom health rules for this workspace',\n    parameters: '{\"verbose\": boolean}',\n    async execute(argsStr, workspaceRoot) {\n      return 'All workspace systems healthy.';\n    }\n  }\n];\n`;
                        fs.writeFileSync(pluginFile, template, 'utf8');
                    }
                    const doc = await vscode.workspace.openTextDocument(pluginFile);
                    await vscode.window.showTextDocument(doc);
                } else {
                    vscode.window.showWarningMessage('Please open a workspace folder to configure plugins.');
                }
                break;
            }

            case 'rollbackFile': {
                if (workspaceRoot && message.filepath) {
                    const fullPath = path.isAbsolute(message.filepath) ? message.filepath : path.join(workspaceRoot, message.filepath);
                    const content = FileVersioning.getLatestSnapshot(workspaceRoot, fullPath);
                    if (content !== null) {
                        fs.writeFileSync(fullPath, content, 'utf8');
                        vscode.window.showInformationMessage(`✅ Rolled back ${path.basename(fullPath)}`);
                        postMessage({ command: 'fileRolledBack', filepath: message.filepath, cardId: message.cardId });
                    } else if (fs.existsSync(fullPath)) {
                        fs.unlinkSync(fullPath);
                        vscode.window.showInformationMessage(`🗑️ Deleted ${path.basename(fullPath)}`);
                        postMessage({ command: 'fileRolledBack', filepath: message.filepath, cardId: message.cardId, deleted: true });
                    }
                }
                break;
            }

            case 'reset': {
                conversationHistory.clear();
                taskPlanner.clear();
                postMessage({ command: 'chatCleared' });
                break;
            }

            case 'openFile': {
                if (workspaceRoot && message.filepath) {
                    const fullPath = path.resolve(workspaceRoot, message.filepath);
                    if (fs.existsSync(fullPath)) {
                        const doc = await vscode.workspace.openTextDocument(fullPath);
                        await vscode.window.showTextDocument(doc);
                    }
                }
                break;
            }

            case 'copyToClipboard': {
                await vscode.env.clipboard.writeText(message.text || '');
                break;
            }

            case 'runInTerminal': {
                await ctx.handleRunInTerminal(message.text || message.cmd);
                break;
            }

            default:
                break;
        }
    }
}
