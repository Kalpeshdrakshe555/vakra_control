import * as vscode from 'vscode';
import { SidebarProvider } from '../webview/sidebarProvider';

export class TerminalErrorInterceptor {
    private static recentErrors: Set<string> = new Set();
    private static terminalBuffers: Map<vscode.Terminal, string> = new Map();
    private static timeoutMap: Map<vscode.Terminal, NodeJS.Timeout> = new Map();

    public static activate(context: vscode.ExtensionContext, sidebarProvider: SidebarProvider) {
        try {
            const win = vscode.window as any;
            if (win && 'onDidWriteTerminalData' in win && typeof win.onDidWriteTerminalData === 'function') {
                context.subscriptions.push(
                    win.onDidWriteTerminalData((e: { terminal: vscode.Terminal, data: string }) => {
                        this.handleTerminalData(e.terminal, e.data, sidebarProvider);
                    })
                );

                context.subscriptions.push(
                    vscode.window.onDidCloseTerminal((terminal: vscode.Terminal) => {
                        this.terminalBuffers.delete(terminal);
                        const timeout = this.timeoutMap.get(terminal);
                        if (timeout) clearTimeout(timeout);
                        this.timeoutMap.delete(terminal);
                    })
                );
            }
        } catch {
            // Proposed API terminalDataWriteEvent is restricted in stable VS Code; safe fallback to copySelection
        }
    }

    private static handleTerminalData(terminal: vscode.Terminal, data: string, sidebarProvider: SidebarProvider) {
        // Strip ANSI escape codes
        const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        
        let buffer = this.terminalBuffers.get(terminal) || '';
        buffer += cleanData;
        if (buffer.length > 5000) buffer = buffer.slice(-5000);
        this.terminalBuffers.set(terminal, buffer);

        const existingTimeout = this.timeoutMap.get(terminal);
        if (existingTimeout) clearTimeout(existingTimeout);

        const newTimeout = setTimeout(() => {
            this.analyzeBuffer(terminal, buffer, sidebarProvider);
        }, 1000);

        this.timeoutMap.set(terminal, newTimeout);
    }

    private static async analyzeBuffer(terminal: vscode.Terminal, buffer: string, sidebarProvider: SidebarProvider) {
        // Clear buffer early
        this.terminalBuffers.set(terminal, '');

        // Regex to catch standard Python, Node, Go, Rust, C++ errors
        const errorRegex = /(Traceback \(most recent call last\):[\s\S]*?|Exception:[\s\S]*?|[A-Z][a-zA-Z0-9_]*Error:[\s\S]*?|fatal error:[\s\S]*?|panic:[\s\S]*?)(?:\r?\n\r?\n|\r?\n$|$)/i;
        const match = buffer.match(errorRegex);

        if (match) {
            const errorText = match[0].trim();
            if (errorText.length < 15 || errorText.length > 3000) return; // Skip trivial or excessively large matches

            // Hash or simple exact match to prevent spamming the exact same error within 5 minutes
            const errorSnippet = errorText.substring(0, 100);
            if (this.recentErrors.has(errorSnippet)) return;
            
            this.recentErrors.add(errorSnippet);
            setTimeout(() => this.recentErrors.delete(errorSnippet), 5 * 60 * 1000);

            // Pop up the notification
            const action = await vscode.window.showErrorMessage(`🚨 Terminal Error Detected`, 'Ask Ultra Light AI');
            if (action === 'Ask Ultra Light AI') {
                await vscode.commands.executeCommand('ultra-light-ai.openSidebar');
                
                // Small delay to ensure Webview is ready
                setTimeout(() => {
                    sidebarProvider.postMessageToWebview({
                        command: 'fillInput',
                        text: `I got this error in the terminal, please help me fix it:\n\`\`\`\n${errorText}\n\`\`\``
                    });
                }, 800);
            }
        }
    }
}
