import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { applyRobustSearchReplace, resolveSafeWorkspacePath } from '../../operations/diffPatcher';
import { DiffValidator } from '../../operations/diffValidator';
import { FileVersioning } from '../../operations/fileVersioning';
import { SessionMemory } from '../../state/sessionMemory';
import { TerminalCapture } from '../../tools/terminalCapture';
import { ProjectScanner } from '../../indexer/projectScanner';

export class PatchApplier {
    public static async applyPatchWithTiers(
        fileText: string,
        searchStr: string,
        replaceStr: string,
        filepath: string,
        isPreview: boolean = false
    ): Promise<{ success: boolean; text: string; error?: string }> {
        if (!filepath.toLowerCase().endsWith('.md')) {
            searchStr = searchStr.replace(/^\s*```[a-zA-Z]*\r?\n/g, '').replace(/\r?\n```\s*$/g, '');
            replaceStr = replaceStr.replace(/^\s*```[a-zA-Z]*\r?\n/g, '').replace(/\r?\n```\s*$/g, '');
        }

        const val = DiffValidator.validateReplacementContent(replaceStr);
        if (!val.valid) {
            return { success: false, text: fileText, error: val.reason };
        }

        const patchResult = applyRobustSearchReplace(fileText, searchStr, replaceStr);
        if (patchResult.success) {
            return { success: true, text: patchResult.result || (patchResult as any).patched || fileText };
        }

        const escapeRegex = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const relaxedRegex = new RegExp(escapeRegex(searchStr).replace(/\s+/g, '\\s+'), 'g');
        if (relaxedRegex.test(fileText)) {
            return { success: true, text: fileText.replace(relaxedRegex, replaceStr) };
        }

        const searchLines = searchStr.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (searchLines.length >= 2) {
            const firstLine = searchLines[0];
            const lastLine = searchLines[searchLines.length - 1];
            const fileLines = fileText.split('\n');

            const startIdx = fileLines.findIndex(l => l.includes(firstLine));
            if (startIdx !== -1) {
                const endIdx = fileLines.findIndex((l, idx) => idx > startIdx && l.includes(lastLine));
                if (endIdx !== -1) {
                    fileLines.splice(startIdx, endIdx - startIdx + 1, ...replaceStr.split('\n'));
                    return { success: true, text: fileLines.join('\n') };
                }
            }
        }

        const validation = DiffValidator.validatePatch(fileText, searchStr);
        const errorMsg = patchResult.error || validation.reason || `Search block could not be matched safely in ${path.basename(filepath)}.`;
        return { success: false, text: fileText, error: errorMsg };
    }

    public static async previewDiff(fileInfo: any, workspaceRoot: string): Promise<void> {
        try {
            const rawRelPath = (fileInfo.filepath || '').replace(/\\/g, '/');
            const safeName = rawRelPath.split('/').pop() || 'temp_diff_file';

            const fullPath = path.isAbsolute(fileInfo.filepath) 
                ? fileInfo.filepath 
                : path.resolve(workspaceRoot, rawRelPath);

            let originalContent = '';
            const snapshot = FileVersioning.getLatestSnapshot(workspaceRoot, fullPath);
            if (snapshot !== null) {
                originalContent = snapshot;
            } else if (fileInfo.oldContent !== undefined) {
                originalContent = fileInfo.oldContent;
            }

            let newContent = '';
            if (fs.existsSync(fullPath)) {
                newContent = fs.readFileSync(fullPath, 'utf8');
            } else if (fileInfo.content !== undefined) {
                newContent = fileInfo.content;
            }

            const os = require('os');
            const tempDir = os.tmpdir();
            const originalFile = path.join(tempDir, `orig_${Date.now()}_${safeName}`);
            const modifiedFile = path.join(tempDir, `mod_${Date.now()}_${safeName}`);

            fs.writeFileSync(originalFile, originalContent || '', 'utf8');
            fs.writeFileSync(modifiedFile, newContent || '', 'utf8');

            await vscode.commands.executeCommand(
                'vscode.diff',
                vscode.Uri.file(originalFile),
                vscode.Uri.file(modifiedFile),
                `Diff: ${safeName} (Original ↔ Current)`
            );
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to preview diff: ${e.message}`);
        }
    }

    public static async applyEdits(
        message: any,
        workspaceRoot: string,
        conversationHistory: any,
        postMessage: (msg: any) => void
    ): Promise<void> {
        try {
            const edit = new vscode.WorkspaceEdit();
            const createdFiles: string[] = [];
            const fileGroups: { [key: string]: string[] } = {};

            for (const file of message.files) {
                if (!fileGroups[file.filepath]) fileGroups[file.filepath] = [];
                fileGroups[file.filepath].push(file.content);
            }

            for (const [filepath, contents] of Object.entries(fileGroups)) {
                const safeCheck = resolveSafeWorkspacePath(filepath, workspaceRoot, true);
                if (!safeCheck.safe) {
                    throw new Error(safeCheck.error || `Security violation: '${filepath}' is outside workspace.`);
                }
                const fullPath = safeCheck.resolvedPath;
                const fileUri = vscode.Uri.file(fullPath);

                let fileText = '';
                if (fs.existsSync(fullPath)) {
                    const document = await vscode.workspace.openTextDocument(fileUri);
                    fileText = document.getText();
                    conversationHistory.addFileBackupToLatestMessage(fullPath, fileText);
                } else {
                    conversationHistory.addFileBackupToLatestMessage(fullPath, null);
                    edit.createFile(fileUri, { ignoreIfExists: true });
                }

                for (const content of contents) {
                    if (content.includes('<<<<<<< SEARCH') && content.includes('>>>>>>> REPLACE')) {
                        const blockRegex = /<<<<<<<\s*SEARCH\r?\n?([\s\S]*?)\r?\n?=======\r?\n?([\s\S]*?)\r?\n?>>>>>>>\s*REPLACE/g;
                        let match;
                        while ((match = blockRegex.exec(content)) !== null) {
                            const searchStr = match[1];
                            const replaceStr = match[2];
                            const patchResult = await this.applyPatchWithTiers(fileText, searchStr, replaceStr, filepath, false);
                            if (patchResult.success) {
                                fileText = patchResult.text;
                            } else {
                                throw new Error(patchResult.error || `Search block mismatch in ${filepath}`);
                            }
                        }
                    } else {
                        let cleanContent = content.trim();
                        const blockMatch = cleanContent.match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```$/);
                        if (blockMatch && blockMatch[1]) {
                            cleanContent = blockMatch[1].trim();
                        }
                        const val = DiffValidator.validateReplacementContent(cleanContent);
                        if (!val.valid) {
                            throw new Error(`Validation failed for ${filepath}:${val.reason}`);
                        }
                        fileText = cleanContent;
                    }
                }

                if (fs.existsSync(fullPath)) {
                    const document = await vscode.workspace.openTextDocument(fileUri);
                    const fullRange = new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length)
                    );
                    edit.replace(fileUri, fullRange, fileText);
                } else {
                    edit.insert(fileUri, new vscode.Position(0, 0), fileText);
                }
                createdFiles.push(filepath);
            }

            for (const filepath of Object.keys(fileGroups)) {
                const safeCheck = resolveSafeWorkspacePath(filepath, workspaceRoot, false);
                const fullPath = safeCheck.safe ? safeCheck.resolvedPath : path.join(workspaceRoot, filepath);
                if (fs.existsSync(fullPath)) {
                    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
                    FileVersioning.saveSnapshot(workspaceRoot, fullPath, document.getText());
                }
            }

            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                throw new Error("VS Code failed to apply workspace edits.");
            }

            for (const filepath of createdFiles) {
                const fullPath = path.join(workspaceRoot, filepath);
                if (fs.existsSync(fullPath)) {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    SessionMemory.recordFileApplied(workspaceRoot, filepath, content);
                }
            }

            vscode.window.showInformationMessage(`✨ Applied & saved ${message.files.length} file(s)!`);
            postMessage({
                command: 'statusUpdate',
                text: `✅ Saved ${createdFiles.length} file(s):${createdFiles.join(', ')}`
            });

            if (message.autoProceed) {
                const filesList = createdFiles.map(f => `- \`${f}\``).join('\n');
                postMessage({
                    command: 'injectChatAndSend',
                    text: `[SYSTEM: FILES SAVED TO DISK]\nSuccessfully applied and saved ${createdFiles.length} file(s):\n${filesList}\n\nPlease proceed to verify or continue next plan step.`
                });
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to apply workspace edits: ${error?.message || error}`);
            postMessage({
                command: 'applyFailed',
                error: error?.message || 'Unknown error'
            });
        }
    }
}
