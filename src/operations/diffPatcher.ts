import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileVersioning } from './fileVersioning';
import { DiffValidator } from './diffValidator';

/**
 * 2-line Context Anchor matcher:
 * Extracts the first 2 and last 2 non-empty lines from the SEARCH block as structural anchors.
 * Matches these anchors against originalLines (whitespace-trimmed).
 * If matched, returns the range to replace between top and bottom anchors atomically.
 */
export function findByContextAnchors(
    originalLines: string[],
    searchLines: string[]
): { matched: boolean; startIndex: number; endIndex: number } {
    const cleanSearchLines = searchLines.map(l => l.trim()).filter(l => l.length > 0);
    if (cleanSearchLines.length < 2 || originalLines.length < 2) {
        return { matched: false, startIndex: -1, endIndex: -1 };
    }

    const trimmedOrigLines = originalLines.map(l => l.trim());

    if (cleanSearchLines.length < 4) {
        // When there are only 2 or 3 lines, use first and last line as single-line anchors
        const topAnchor = cleanSearchLines[0];
        const bottomAnchor = cleanSearchLines[cleanSearchLines.length - 1];

        for (let i = 0; i < trimmedOrigLines.length; i++) {
            if (trimmedOrigLines[i] === topAnchor) {
                for (let j = i + 1; j < trimmedOrigLines.length; j++) {
                    if (trimmedOrigLines[j] === bottomAnchor) {
                        if (j - i <= cleanSearchLines.length + 50) {
                            return { matched: true, startIndex: i, endIndex: j };
                        }
                    }
                }
            }
        }
        return { matched: false, startIndex: -1, endIndex: -1 };
    }

    // Extract first 2 and last 2 non-empty lines as structural anchors
    const topAnchor1 = cleanSearchLines[0];
    const topAnchor2 = cleanSearchLines[1];
    const bottomAnchor1 = cleanSearchLines[cleanSearchLines.length - 2];
    const bottomAnchor2 = cleanSearchLines[cleanSearchLines.length - 1];

    for (let i = 0; i < trimmedOrigLines.length - 1; i++) {
        if (trimmedOrigLines[i] === topAnchor1 && trimmedOrigLines[i + 1] === topAnchor2) {
            // Top 2 anchors matched at i, i+1. Search for bottom anchors after top
            for (let j = i + 2; j < trimmedOrigLines.length - 1; j++) {
                if (trimmedOrigLines[j] === bottomAnchor1 && trimmedOrigLines[j + 1] === bottomAnchor2) {
                    return { matched: true, startIndex: i, endIndex: j + 1 };
                }
            }
        }
    }

    return { matched: false, startIndex: -1, endIndex: -1 };
}

/**
 * Computes Levenshtein similarity between two trimmed strings (0.0 to 1.0).
 */
function computeLevenshteinSimilarity(str1: string, str2: string): number {
    const s1 = str1.trim();
    const s2 = str2.trim();
    if (s1 === s2) return 1.0;
    if (!s1.length || !s2.length) return 0.0;

    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1.0;

    if (Math.abs(s1.length - s2.length) / maxLen > 0.3) {
        return 0.0;
    }

    const d: number[] = [];
    for (let i = 0; i <= s2.length; i++) {
        d[i] = i;
    }

    for (let i = 1; i <= s1.length; i++) {
        let prev = i;
        for (let j = 1; j <= s2.length; j++) {
            let val = d[j - 1];
            if (s1[i - 1] !== s2[j - 1]) {
                val = Math.min(d[j - 1], prev, d[j]) + 1;
            }
            d[j - 1] = prev;
            prev = val;
        }
        d[s2.length] = prev;
    }

    return 1 - (d[s2.length] / maxLen);
}

/**
 * Strict Path Resolution & Directory Guard:
 * Resolves a target path strictly relative to vscode.workspace.workspaceFolders[0].uri.
 * Prevents path hallucinations / traversal outside workspace root.
 * Automatically creates missing parent directories only after confirming the path is within the workspace boundary.
 */
export function resolveSafeWorkspacePath(
    targetPath: string, 
    customWorkspaceRoot?: string,
    createDirsIfMissing: boolean = true
): { safe: boolean; resolvedPath: string; error?: string } {
    let workspaceRoot = customWorkspaceRoot;
    if (!workspaceRoot && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    if (!workspaceRoot) {
        return { safe: true, resolvedPath: path.resolve(targetPath) };
    }

    const normalizedRoot = path.resolve(workspaceRoot);
    const resolved = path.isAbsolute(targetPath) 
        ? path.resolve(targetPath)
        : path.resolve(normalizedRoot, targetPath);

    const isWindows = process.platform === 'win32';
    const rootCmp = isWindows ? normalizedRoot.toLowerCase() : normalizedRoot;
    const resolvedCmp = isWindows ? resolved.toLowerCase() : resolved;

    if (!resolvedCmp.startsWith(rootCmp)) {
        return {
            safe: false,
            resolvedPath: resolved,
            error: `Security / Guard violation: Path '${targetPath}' resolves outside workspace boundary '${workspaceRoot}'.`
        };
    }

    if (createDirsIfMissing) {
        const parentDir = path.dirname(resolved);
        if (!fs.existsSync(parentDir)) {
            try {
                fs.mkdirSync(parentDir, { recursive: true });
            } catch (err: any) {
                return {
                    safe: false,
                    resolvedPath: resolved,
                    error: `Failed to create parent directory '${parentDir}': ${err.message}`
                };
            }
        }
    }

    return { safe: true, resolvedPath: resolved };
}

/**
 * Extracts and applies code updates to the target file.
 * Returns true on success, false on failure.
 */
export function applyDiff(filePath: string, llmResponse: string): boolean {
    try {
        const safeCheck = resolveSafeWorkspacePath(filePath, undefined, true);
        if (!safeCheck.safe) {
            console.error(`Diff patch rejected for path ${filePath}: ${safeCheck.error}`);
            return false;
        }
        const resolvedPath = safeCheck.resolvedPath;

        let fileText = '';
        if (fs.existsSync(resolvedPath)) {
            fileText = fs.readFileSync(resolvedPath, 'utf8');
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(resolvedPath));
        const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(resolvedPath);

        // Pre-save snapshot before attempting any patch
        if (fileText.length > 0) {
            FileVersioning.saveSnapshot(workspaceRoot, resolvedPath, fileText);
        }

        if (llmResponse.includes('<<<<<<< SEARCH') && llmResponse.includes('>>>>>>> REPLACE')) {
            const blockRegex = /<<<<<<<\s*SEARCH\r?\n?([\s\S]*?)\r?\n?=======\r?\n?([\s\S]*?)\r?\n?>>>>>>>\s*REPLACE/g;
            let match;
            let blocksFound = false;
            let currentText = fileText;
            
            while ((match = blockRegex.exec(llmResponse)) !== null) {
                blocksFound = true;
                const searchStr = match[1];
                const replaceStr = match[2];

                // Validate replacement content to prevent placeholders or accidental wiping
                const validation = DiffValidator.validateReplacementContent(replaceStr);
                if (!validation.valid) {
                    console.error(`Validation failed for ${resolvedPath}: ${validation.reason}`);
                    return false;
                }
                
                const patchResult = applyRobustSearchReplace(currentText, searchStr, replaceStr);
                if (patchResult.success) {
                    currentText = patchResult.result;
                } else {
                    console.error(`Patch failed for ${resolvedPath}: ${patchResult.error || 'Search block not found'}`);
                    return false;
                }
            }
            if (blocksFound) {
                fs.writeFileSync(resolvedPath, currentText, 'utf8');
                return true;
            } else {
                console.error(`Malformed Search/Replace block in ${resolvedPath}`);
                return false;
            }
        }

        const regex = /```[\w]*\r?\n([\s\S]*?)```/;
        const match = llmResponse.match(regex);
        
        let contentToWrite = llmResponse;
        if (match && match[1]) {
            contentToWrite = match[1];
        }

        // Validate replacement content
        const validation = DiffValidator.validateReplacementContent(contentToWrite);
        if (!validation.valid) {
            console.error(`Validation failed for ${resolvedPath}: ${validation.reason}`);
            return false;
        }
        
        // Safety check for accidental file wipe via partial code snippet
        if (fileText.length > 0 && contentToWrite.length < fileText.length * 0.5) {
            console.warn(`Safety Abort: AI tried to overwrite ${resolvedPath} with a code block < 50% of the original file size. Aborting overwrite.`);
            return false;
        }
        
        fs.writeFileSync(resolvedPath, contentToWrite, 'utf8');
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
 * Robustly attempts to find and replace a block of code, falling back through 5 tiers of leniency:
 * 1. Exact Match
 * 2. Trimmed Line Match
 * 3. Normalized Indentation Match
 * 4. Context Anchor Match (2 top and 2 bottom structural anchors)
 * 5. Bounded Fuzzy Match (threshold >= 0.85)
 */
export function applyRobustSearchReplace(
    fileText: string, 
    searchStr: string, 
    replaceStr: string
): { success: boolean; result: string; error?: string } {
    // Validate replacement content first to catch placeholders or accidental wipes
    const validation = DiffValidator.validateReplacementContent(replaceStr);
    if (!validation.valid) {
        return { success: false, result: fileText, error: validation.reason };
    }

    // Helper to normalize tabs to 4 spaces and trim trailing whitespace
    const normalize = (str: string) => str.replace(/\t/g, '    ').split(/\r?\n/).map(l => l.trimRight()).join('\n');
    
    // Tier 0: Empty SEARCH = Full file overwrite (Model creating a new file or wiping one)
    if (searchStr.trim().length === 0) {
        return { success: true, result: replaceStr };
    }

    const normFileText = normalize(fileText);
    const normSearchStr = normalize(searchStr);

    // Tier 1: Exact Match (Normalized line endings & tabs)
    if (normFileText.includes(normSearchStr)) {
        if (fileText.includes(searchStr)) {
            return { success: true, result: fileText.replace(searchStr, replaceStr) };
        } else {
            return { success: true, result: normFileText.replace(normSearchStr, replaceStr) };
        }
    }

    // Tier 2: Trimmed Line Match (Whole block trimmed or normalized line endings only)
    const searchNoR = searchStr.replace(/\r\n/g, '\n');
    const fileNoR = fileText.replace(/\r\n/g, '\n');
    if (fileNoR.includes(searchNoR)) {
        return { success: true, result: fileNoR.replace(searchNoR, replaceStr.replace(/\r\n/g, '\n')) };
    }
    if (fileText.includes(searchStr.trim())) {
        return { success: true, result: fileText.replace(searchStr.trim(), replaceStr.trim()) };
    }

    // Tier 3: Normalized Indentation Match (Line-by-line whitespace-trimmed match)
    const searchLines = normSearchStr.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const fileLines = normFileText.split('\n');
    const origFileLines = fileText.split(/\r?\n/);
    
    if (searchLines.length === 0) {
        return { success: false, result: fileText, error: "Search block contains no valid code lines." };
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

    // Tier 4: Context Anchor Match (First 2 & Last 2 non-empty lines)
    const anchorMatch = findByContextAnchors(origFileLines, searchLines);
    if (anchorMatch.matched && anchorMatch.startIndex !== -1 && anchorMatch.endIndex !== -1) {
        const pre = origFileLines.slice(0, anchorMatch.startIndex);
        const post = origFileLines.slice(anchorMatch.endIndex + 1);
        const result = (pre.length > 0 ? pre.join('\n') + '\n' : '') + replaceStr + (post.length > 0 ? '\n' + post.join('\n') : '');
        return { success: true, result };
    }

    // Tier 5: Bounded Fuzzy Match (threshold >= 0.85)
    if (searchLines.length > 0 && fileLines.length >= searchLines.length) {
        let bestAvgScore = 0;
        let bestStart = -1;
        let bestEnd = -1;

        for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
            let totalSim = 0;
            for (let s = 0; s < searchLines.length; s++) {
                totalSim += computeLevenshteinSimilarity(fileLines[i + s].trim(), searchLines[s]);
            }
            const avgSim = totalSim / searchLines.length;
            if (avgSim > bestAvgScore) {
                bestAvgScore = avgSim;
                bestStart = i;
                bestEnd = i + searchLines.length - 1;
            }
        }

        if (bestAvgScore >= 0.65 && bestStart !== -1 && bestEnd !== -1) {
            const pre = origFileLines.slice(0, bestStart);
            const post = origFileLines.slice(bestEnd + 1);
            const result = (pre.length > 0 ? pre.join('\n') + '\n' : '') + replaceStr + (post.length > 0 ? '\n' + post.join('\n') : '');
            return { success: true, result };
        }
    }

    return { 
        success: false, 
        result: fileText, 
        error: "Could not find matching code in file. Ensure SEARCH block includes exact lines and context anchors." 
    };
}
