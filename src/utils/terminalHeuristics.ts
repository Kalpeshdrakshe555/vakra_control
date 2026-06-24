import * as fs from 'fs';
import * as path from 'path';

/**
 * Analyzes raw terminal output and extracts a surgical 10-line snippet
 * around the exact point of failure to save AI context tokens.
 */
export async function extractSurgicalErrorContext(rawOutput: string, workspaceRoot: string): Promise<string> {
    const lines = rawOutput.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return rawOutput;

    let errorName = '';
    let filePath = '';
    let lineNumber = -1;

    // 🧠 PRIMARY TIER: Try to use Scout Brain (LLM) to intelligently parse the error
    try {
        const config = require('../config').getAgentConfig(workspaceRoot);
        const supportBrain = config?.supportBrain;
        
        if (supportBrain && supportBrain.model) {
            const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');
            let scoutClient;
            if (supportBrain.providerType === 'local') {
                scoutClient = new LocalOllamaClient(supportBrain.model || 'llama-3.1-8b-instant', supportBrain.endpoint || 'http://127.0.0.1:11434', supportBrain.apiKey);
            } else {
                scoutClient = new GeminiCloudClient([supportBrain.apiKey?.trim() || ''], supportBrain.model || 'gemini-1.5-flash', 60);
            }

            const prompt = `Analyze this terminal error output. Extract the main error name, the file path where it occurred, and the exact line number.\nReturn ONLY a valid JSON object with keys: "errorName", "filePath", "lineNumber" (as integer). If you cannot find them, return {"errorName": "", "filePath": "", "lineNumber": -1}. Do not include markdown blocks.\n\nTerminal Output:\n${lines.slice(-30).join('\n')}`;
            
            const response = await scoutClient.complete(prompt);
            const jsonStr = response.text.replace(/```json/gi, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(jsonStr);
            
            if (parsed.filePath && parsed.lineNumber !== -1) {
                errorName = parsed.errorName || 'Unknown Error';
                filePath = parsed.filePath;
                lineNumber = parsed.lineNumber;
            }
        }
    } catch (e) {
        console.error("Scout heuristic failed, falling back to Regex:", e);
    }

    // 🛠️ SECONDARY TIER: Regex Fallback (Includes Node, Python, C++, Go, Rust)
    if (!filePath || lineNumber === -1) {
        // Scan from bottom-up (where errors usually terminate)
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];

            // Match standard Error types
            if (!errorName && /^[A-Z][a-zA-Z0-9_]+Error:/.test(line)) errorName = line;
            if (!errorName && /^Exception:/.test(line)) errorName = line;
            
            // Match C++/Go/Rust Compiler Errors
            if (!errorName && /(?:error|fatal error):\s+(.*)/i.test(line)) {
                const m = line.match(/(?:error|fatal error):\s+(.*)/i);
                if (m) errorName = m[1] || 'Compilation Error';
            }

            // Match Python File/Line
            const pyMatch = line.match(/File\s+"([^"]+)",\s+line\s+(\d+)/);
            if (pyMatch && !filePath) { filePath = pyMatch[1]; lineNumber = parseInt(pyMatch[2], 10); }

            // Match Node/JS File/Line
            const jsMatch = line.match(/at\s+(?:[^\(]+\()?([^:]+):(\d+):\d+\)?/);
            if (jsMatch && !filePath && !jsMatch[1].startsWith('node:')) {
                filePath = jsMatch[1]; lineNumber = parseInt(jsMatch[2], 10);
            }

            // Match C/C++/Go/Rust File/Line (e.g., main.cpp:10:5: error: ...)
            const ccGoMatch = line.match(/([a-zA-Z0-9_.\/\\-]+(?:\.cpp|\.c|\.h|\.hpp|\.go|\.rs)):(\d+):(?:\d+:)?/);
            if (ccGoMatch && !filePath) {
                filePath = ccGoMatch[1]; lineNumber = parseInt(ccGoMatch[2], 10);
            }

            if (errorName && filePath && lineNumber !== -1) break;
        }
    }

    // Fallback: If heuristic parsing fails, return a truncated 15-line tail instead of 60 lines.
    if (!filePath || lineNumber === -1) {
        return `**Terminal Output:**\n\`\`\`\n${lines.slice(-15).join('\n')}\n\`\`\``;
    }

    try {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
        if (fs.existsSync(fullPath)) {
            const fileLines = fs.readFileSync(fullPath, 'utf8').split('\n');
            const startLine = Math.max(0, lineNumber - 6); // 5 lines above
            const endLine = Math.min(fileLines.length, lineNumber + 5); // 5 lines below
            const snippet = fileLines.slice(startLine, endLine).map((l, idx) => (startLine + idx + 1) === lineNumber ? `>> ${startLine + idx + 1}: ${l}` : `   ${startLine + idx + 1}: ${l}`).join('\n');
            return `**🚨 Terminal Error Detected:** \`${errorName || 'Unknown Error'}\`\n**📍 Location:** \`${path.relative(workspaceRoot, fullPath)}\` (Line ${lineNumber})\n\n**💻 Code Context:**\n\`\`\`${path.extname(fullPath).slice(1) || 'text'}\n${snippet}\n\`\`\`\n\n**Raw Error:**\n\`\`\`\n${errorName || lines[lines.length - 1]}\n\`\`\``;
        }
    } catch (e) { /* ignore fs errors and fallback */ }

    return `**Terminal Error:**\n\`\`\`\n${lines.slice(-10).join('\n')}\n\`\`\``;
}