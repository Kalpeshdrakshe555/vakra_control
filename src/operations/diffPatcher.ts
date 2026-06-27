import * as fs from 'fs';
import * as vscode from 'vscode';
import { FileVersioning } from './fileVersioning';

/**
 * Extracts and applies code updates to the target file.
 * Returns true on success, false on failure.
 */
export function applyDiff(filePath: string, llmResponse: string): boolean {
    try {
        let fileText = '';
        if (fs.existsSync(filePath)) {
            fileText = fs.readFileSync(filePath, 'utf8');
        }

        if (llmResponse.includes('<<<<<<< SEARCH') && llmResponse.includes('>>>>>>> REPLACE')) {
            const blockRegex = /<<<<<<<\s*SEARCH\r?\n?([\s\S]*?)\r?\n?=======\r?\n?([\s\S]*?)\r?\n?>>>>>>>\s*REPLACE/g;
            let match;
            let blocksFound = false;
            
            while ((match = blockRegex.exec(llmResponse)) !== null) {
                blocksFound = true;
                const searchStr = match[1];
                const replaceStr = match[2];
                
                const patchResult = applyRobustSearchReplace(fileText, searchStr, replaceStr);
                if (patchResult.success) {
                    fileText = patchResult.result;
                } else {
                    blocksFound = false;
                }
            }
            if (blocksFound) {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
                if (workspaceFolder) {
                    FileVersioning.saveSnapshot(workspaceFolder.uri.fsPath, filePath, fs.readFileSync(filePath, 'utf8'));
                }
                fs.writeFileSync(filePath, fileText, 'utf8');
                return true;
            } else {
                console.error(`Malformed Search/Replace block in ${filePath}`);
                return false;
            }
        }

        const regex = /```[\w]*\r?\n([\s\S]*?)```/;
        const match = llmResponse.match(regex);
        
        let contentToWrite = llmResponse;
        if (match && match[1]) {
            contentToWrite = match[1];
        }
        
        // Safety check for accidental file wipe via partial code snippet
        if (fileText.length > 0 && contentToWrite.length < fileText.length * 0.5) {
            console.warn(`Safety Abort: AI tried to overwrite ${filePath} with a code block < 50% of the original file size. Aborting overwrite.`);
            return false;
        }
        
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
        if (workspaceFolder && fileText.length > 0) {
            FileVersioning.saveSnapshot(workspaceFolder.uri.fsPath, filePath, fileText);
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

/**
 * Robustly attempts to find and replace a block of code, falling back through 5 tiers of leniency.
 * 1. Exact Match
 * 2. Normalized Line Endings
 * 3. Trimmed Match
 * 4. Indentation & Empty Line Agnostic Match
 * 5. First & Last Line Anchor Match
 */
export function applyRobustSearchReplace(fileText: string, searchStr: string, replaceStr: string): { success: boolean, result: string } {
    // Helper to normalize tabs to 4 spaces and trim trailing whitespace
    const normalize = (str: string) => str.replace(/\t/g, '    ').split(/\r?\n/).map(l => l.trimRight()).join('\n');
    
    // Tier 0: Empty SEARCH = Full file overwrite (Model creating a new file or wiping one)
    if (searchStr.trim().length === 0) {
        return { success: true, result: replaceStr };
    }

    const normFileText = normalize(fileText);
    const normSearchStr = normalize(searchStr);

    // Tier 1: Exact Match (Normalized)
    if (normFileText.includes(normSearchStr)) {
        // We replace in the ORIGINAL fileText to preserve user's tabs if possible, 
        // but since we matched normalized, we might have to use normalized if original doesn't match
        if (fileText.includes(searchStr)) {
            return { success: true, result: fileText.replace(searchStr, replaceStr) };
        } else {
             // Tab/Space mismatch occurred, replace on normalized version
             return { success: true, result: normFileText.replace(normSearchStr, replaceStr) };
        }
    }

    // Tier 2: Normalized Line Endings Only
    const searchNoR = searchStr.replace(/\r\n/g, '\n');
    const fileNoR = fileText.replace(/\r\n/g, '\n');
    if (fileNoR.includes(searchNoR)) {
        return { success: true, result: fileNoR.replace(searchNoR, replaceStr.replace(/\r\n/g, '\n')) };
    }

    // Tier 3: Trimmed Match
    if (fileText.includes(searchStr.trim())) {
        return { success: true, result: fileText.replace(searchStr.trim(), replaceStr.trim()) };
    }

    // Tier 4: Line-by-Line Indentation & Empty Line Agnostic Match
    const searchLines = normSearchStr.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const fileLines = normFileText.split('\n');
    const origFileLines = fileText.split(/\r?\n/);
    
    if (searchLines.length === 0) {
         return { success: false, result: fileText };
    }

    let bestMatchStart = -1;
    let bestMatchEnd = -1;

    for (let i = 0; i < fileLines.length; i++) {
        let searchIdx = 0;
        let fileIdx = i;

        while (fileIdx < fileLines.length && searchIdx < searchLines.length) {
            const fLine = fileLines[fileIdx].trim();
            if (fLine.length === 0) {
                fileIdx++;
                continue;
            }
            if (fLine === searchLines[searchIdx]) {
                searchIdx++;
                fileIdx++;
            } else {
                break;
            }
        }

        if (searchIdx === searchLines.length) {
            bestMatchStart = i;
            bestMatchEnd = fileIdx - 1;
            break;
        }
    }

    if (bestMatchStart !== -1 && bestMatchEnd !== -1) {
        const pre = origFileLines.slice(0, bestMatchStart).join('\n');
        const post = origFileLines.slice(bestMatchEnd + 1).join('\n');
        const result = (pre ? pre + '\n' : '') + replaceStr + (post ? '\n' + post : '');
        return { success: true, result };
    }

    // Tier 5: Sliding Window Fallback (Score-based)
    if (searchLines.length > 1) {
        let bestScore = 0;
        let bestStart = -1;
        let bestEnd = -1;

        // Try to find a block in the file that matches the most search lines
        for (let i = 0; i < fileLines.length - searchLines.length + 1; i++) {
            let currentScore = 0;
            // Check a window of lines up to 2x the search size to account for added/removed empty lines
            const windowSize = Math.min(fileLines.length - i, searchLines.length * 2);
            let searchIdx = 0;
            let lastMatchedFileIdx = i;

            for (let w = 0; w < windowSize && searchIdx < searchLines.length; w++) {
                if (fileLines[i + w].trim() === searchLines[searchIdx]) {
                    currentScore++;
                    searchIdx++;
                    lastMatchedFileIdx = i + w;
                } else if (fileLines[i + w].trim() === '') {
                     // ignore empty lines in file
                } else {
                     // mismatch, keep looking for this search line further in the window
                }
            }

            if (currentScore > bestScore) {
                bestScore = currentScore;
                bestStart = i;
                bestEnd = lastMatchedFileIdx;
            }
        }

        // If we matched at least 60% of the lines in the SEARCH block
        if (bestScore / searchLines.length >= 0.6) {
             const pre = origFileLines.slice(0, bestStart).join('\n');
             const post = origFileLines.slice(bestEnd + 1).join('\n');
             const result = (pre ? pre + '\n' : '') + replaceStr + (post ? '\n' + post : '');
             return { success: true, result };
        }
    }

    return { success: false, result: fileText };
}
