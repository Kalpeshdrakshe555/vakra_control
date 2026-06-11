import * as fs from 'fs';
import * as vscode from 'vscode';

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
    // Tier 1: Exact Match
    if (fileText.includes(searchStr)) {
        return { success: true, result: fileText.replace(searchStr, replaceStr) };
    }

    // Tier 2: Normalized Line Endings
    const normSearch = searchStr.replace(/\r\n/g, '\n');
    const normFile = fileText.replace(/\r\n/g, '\n');
    if (normFile.includes(normSearch)) {
        return { success: true, result: normFile.replace(normSearch, replaceStr.replace(/\r\n/g, '\n')) };
    }

    // Tier 3: Trimmed Match
    if (fileText.includes(searchStr.trim())) {
        return { success: true, result: fileText.replace(searchStr.trim(), replaceStr.trim()) };
    }

    // Tier 4: Line-by-Line Indentation & Empty Line Agnostic Match
    const searchLines = searchStr.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const fileLines = fileText.split(/\r?\n/);
    
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
        const pre = fileLines.slice(0, bestMatchStart).join('\n');
        const post = fileLines.slice(bestMatchEnd + 1).join('\n');
        const result = (pre ? pre + '\n' : '') + replaceStr + (post ? '\n' + post : '');
        return { success: true, result };
    }

    // Tier 5: Fallback to First and Last line matching (with intermediate validation)
    if (searchLines.length > 1) {
        const firstLine = searchLines[0];
        const lastLine = searchLines[searchLines.length - 1];
        
        let startIdx = -1;
        let endIdx = -1;
        for (let i = 0; i < fileLines.length; i++) {
            if (fileLines[i].trim() === firstLine) {
                startIdx = i;
                break;
            }
        }
        if (startIdx !== -1) {
            for (let i = startIdx; i < fileLines.length; i++) {
                if (fileLines[i].trim() === lastLine) {
                    endIdx = i;
                    break;
                }
            }
        }
        
        if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx && (endIdx - startIdx) < searchLines.length * 3) {
            // H2 FIX: Validate that at least 40% of intermediate search lines also match
            const fileLinesInRange = fileLines.slice(startIdx, endIdx + 1).map(l => l.trim()).filter(l => l.length > 0);
            const intermediateSearchLines = searchLines.slice(1, -1);
            let matchedCount = 0;
            for (const sl of intermediateSearchLines) {
                if (fileLinesInRange.includes(sl)) matchedCount++;
            }
            const matchRatio = intermediateSearchLines.length > 0 ? matchedCount / intermediateSearchLines.length : 1;
            
            if (matchRatio >= 0.4) {
                const pre = fileLines.slice(0, startIdx).join('\n');
                const post = fileLines.slice(endIdx + 1).join('\n');
                const result = (pre ? pre + '\n' : '') + replaceStr + (post ? '\n' + post : '');
                return { success: true, result };
            }
        }
    }

    return { success: false, result: fileText };
}
