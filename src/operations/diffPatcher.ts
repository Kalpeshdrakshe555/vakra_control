import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Extracts and applies code updates to the target file.
 * Returns true on success, false on failure.
 */
export function applyDiff(filePath: string, llmResponse: string): boolean {
    try {
        const regex = /```[\w]*\n([\s\S]*?)```/;
        const match = llmResponse.match(regex);
        
        let contentToWrite = llmResponse;
        if (match && match[1]) {
            contentToWrite = match[1];
        }
        
        fs.writeFileSync(filePath, contentToWrite, 'utf8');
        return true;
    } catch (error) {
        console.error(`Failed to apply diff updates to ${filePath}:`, error);
        return false;
    }
}

/**
 * Safely applies the extracted code to the active editor.
 * Replaces selection if one exists, otherwise inserts at cursor.
 */
export async function applyDiffToActiveFile(extractedCode: string): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        throw new Error('No active text editor. Please open a file first.');
    }

    const document = editor.document;
    const selection = editor.selection;

    const success = await editor.edit(editBuilder => {
        if (!selection.isEmpty) {
            // Replace selected text
            editBuilder.replace(selection, extractedCode);
        } else {
            // Insert at cursor
            editBuilder.insert(selection.active, extractedCode);
        }
    });

    return success;
}
