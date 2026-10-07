import { IEngine, CompletionResult, StreamChunk } from './IEngine';
import { repairToolCall, ToolSpec } from './toolReanchor';

function getToolSpecsFromTools(tools?: any[]): ToolSpec[] {
    if (!tools || !tools[0]?.functionDeclarations) return [];
    return tools[0].functionDeclarations.map((f: any) => ({
        name: f.name,
        signature: `${f.name}(${Object.keys(f.parameters?.properties || {}).join(', ')})`,
        parameters: f.parameters || { properties: {} }
    }));
}

/**
 * Fallback parser for models that emit tool calls in plain text syntax (e.g. search_web(query="..."), <tool_call>...).
 */
const KNOWN_TOOLS_LIST = [
    'search_web',
    'research_web_docs',
    'execute_terminal_command',
    'list_directory_tree',
    'read_multiple_files',
    'get_code_diagnostics',
    'get_symbol_outline',
    'check_localhost_health',
    'update_architecture_context',
    'generate_ui_blueprint'
];
const KNOWN_TOOLS_REGEX_STR = KNOWN_TOOLS_LIST.join('|');

/**
 * Universal fallback parser for models (Gemma, Llama, Qwen, etc.) that emit tool calls in plain text syntax:
 * 1. Naked tool name followed by JSON:
 *    list_directory_tree
 *    { "dir": ".", "depth": 2 }
 * 2. Embedded JSON tool object: { "name": "list_directory_tree", "arguments": {...} }
 * 3. Function call syntax: search_web(query="...") or execute_terminal_command(command="...")
 * 4. Tag syntax: <tool_call>...</tool_call>
 * 5. Standalone ```bash blocks (auto-routed to execute_terminal_command)
 */
function tryParseJsonRelaxed(raw: string): any {
    try {
        return JSON.parse(raw);
    } catch {
        try {
            const relaxed = raw
                .replace(/,\s*([}\]])/g, '$1') // trailing commas
                .replace(/([{,]\s*)([a-zA-Z_0-9]+)\s*:/g, '$1"$2":') // unquoted keys
                .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"'); // single to double quotes
            return JSON.parse(relaxed);
        } catch {
            return null;
        }
    }
}

function inferToolFromObject(obj: any): { name: string; args: any } | null {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

    // Explicit name or tool property
    if (obj.name && KNOWN_TOOLS_LIST.includes(obj.name)) {
        const clean = { ...(obj.arguments || obj.args || obj.parameters || obj) };
        delete clean.name;
        delete clean.tool;
        return { name: obj.name, args: clean };
    }
    if (obj.tool && KNOWN_TOOLS_LIST.includes(obj.tool)) {
        const clean = { ...(obj.arguments || obj.args || obj.parameters || obj) };
        delete clean.name;
        delete clean.tool;
        return { name: obj.tool, args: clean };
    }

    // 1. read_multiple_files signature
    if (obj.filepaths) {
        const paths = Array.isArray(obj.filepaths) ? obj.filepaths : [String(obj.filepaths)];
        return { name: 'read_multiple_files', args: { filepaths: paths } };
    }
    if (obj.files && Array.isArray(obj.files) && obj.files.length > 0 && typeof obj.files[0] === 'string') {
        return { name: 'read_multiple_files', args: { filepaths: obj.files } };
    }
    if (obj.file_paths) {
        const paths = Array.isArray(obj.file_paths) ? obj.file_paths : [String(obj.file_paths)];
        return { name: 'read_multiple_files', args: { filepaths: paths } };
    }
    if (obj.filepath && !obj.newCode && !obj.symbolName && !obj.content && !obj.command) {
        return { name: 'read_multiple_files', args: { filepaths: [String(obj.filepath)] } };
    }

    // 2. execute_terminal_command signature
    if (obj.command || obj.cmd || obj.terminal_command || obj.shell_command) {
        const cmd = obj.command || obj.cmd || obj.terminal_command || obj.shell_command;
        return {
            name: 'execute_terminal_command',
            args: {
                command: String(cmd),
                explanation: obj.explanation || 'Executed command'
            }
        };
    }

    // 3. list_directory_tree signature
    if (obj.dir !== undefined || obj.directory !== undefined || (obj.depth !== undefined && !obj.query)) {
        return {
            name: 'list_directory_tree',
            args: {
                dir: obj.dir || obj.directory || '.',
                depth: typeof obj.depth === 'number' ? obj.depth : 2
            }
        };
    }

    // 4. research_web_docs signature
    if (obj.query && (obj.urls || obj.url || obj.docs)) {
        return {
            name: 'research_web_docs',
            args: {
                query: String(obj.query),
                urls: Array.isArray(obj.urls) ? obj.urls : (obj.url ? [String(obj.url)] : [])
            }
        };
    }

    // 5. search_web signature
    if (obj.query || obj.search_query || obj.search) {
        const q = obj.query || obj.search_query || obj.search;
        return {
            name: 'search_web',
            args: { query: String(q) }
        };
    }

    // 5b. read_skill signature
    if (obj.skill_name || (obj.name && (obj.action === 'read_skill' || obj.tool === 'read_skill'))) {
        return {
            name: 'read_skill',
            args: { skill_name: String(obj.skill_name || obj.name) }
        };
    }

    // 6. check_localhost_health signature
    if (obj.port !== undefined && (obj.port === 3000 || obj.port === 8000 || obj.port === 5173 || obj.port === 8080 || typeof obj.port === 'number')) {
        return {
            name: 'check_localhost_health',
            args: { port: Number(obj.port) }
        };
    }

    // 7. replace_symbol signature
    if (obj.filepath && obj.symbolName && obj.newCode) {
        return {
            name: 'replace_symbol',
            args: { filepath: obj.filepath, symbolName: obj.symbolName, newCode: obj.newCode }
        };
    }

    // 8. get_symbol_outline signature
    if (obj.filepath && obj.symbolName && !obj.newCode) {
        return {
            name: 'get_symbol_outline',
            args: { filepath: obj.filepath }
        };
    }

    // 9. get_code_diagnostics signature
    if (obj.diagnostics !== undefined || obj.problems !== undefined) {
        return {
            name: 'get_code_diagnostics',
            args: { filepath: obj.filepath || '' }
        };
    }

    // 10. update_architecture_context signature
    if (obj.architecture || obj.arch_content) {
        return {
            name: 'update_architecture_context',
            args: { content: obj.architecture || obj.arch_content }
        };
    }

    // 11. write_file signature
    if (obj.filepath && (obj.content !== undefined || obj.code !== undefined) && !obj.symbolName && !obj.old_text && !obj.oldText) {
        return {
            name: 'write_file',
            args: {
                filepath: String(obj.filepath),
                content: String(obj.content !== undefined ? obj.content : obj.code)
            }
        };
    }

    // 12. edit_file signature
    if (obj.filepath && (obj.old_text !== undefined || obj.oldText !== undefined || obj.search !== undefined) && (obj.new_text !== undefined || obj.newText !== undefined || obj.replace !== undefined)) {
        return {
            name: 'edit_file',
            args: {
                filepath: String(obj.filepath),
                old_text: String(obj.old_text !== undefined ? obj.old_text : (obj.oldText !== undefined ? obj.oldText : obj.search)),
                new_text: String(obj.new_text !== undefined ? obj.new_text : (obj.newText !== undefined ? obj.newText : obj.replace))
            }
        };
    }

    // Legacy planner signatures disabled - agent acts directly via write_file / edit_file / execute_terminal_command

    return null;
}

function extractTextToolCalls(text: string): Array<{ name: string; args: any; raw: string }> {
    const results: Array<{ name: string; args: any; raw: string }> = [];
    if (!text || typeof text !== 'string') return results;

    const pushUnique = (name: string, args: any, raw: string) => {
        if (!results.some(r => r.name === name && JSON.stringify(r.args) === JSON.stringify(args))) {
            results.push({ name, args, raw });
        }
    };

    // Pattern 1: Naked Tool Name followed by JSON Object (Common in Gemma, Llama, Qwen local outputs)
    // e.g.: list_directory_tree \n { "dir": ".", "depth": 2 }
    const nakedRegex = new RegExp(`(?:^|\\n)\\s*(${KNOWN_TOOLS_REGEX_STR})\\s*(?::|->)?\\s*\\n*\\s*(?:\`\`\`(?:json)?\\s*\\n*)?(\\{[\\s\\S]*?\\})(?:\\s*\\n*\`\`\`)?`, 'gi');
    let nakedMatch;
    while ((nakedMatch = nakedRegex.exec(text)) !== null) {
        const toolName = nakedMatch[1].trim();
        const rawJson = nakedMatch[2].trim();
        const parsed = tryParseJsonRelaxed(rawJson);
        if (parsed && typeof parsed === 'object') {
            pushUnique(toolName, parsed, nakedMatch[0]);
        }
    }

    // Pattern 2: JSON Object with "name" or "tool" property matching a known tool
    const jsonToolRegex = /\{[\s\S]*?"(?:name|tool)"\s*:\s*"([a-zA-Z_0-9]+)"[\s\S]*?\}/g;
    let jsonMatch;
    while ((jsonMatch = jsonToolRegex.exec(text)) !== null) {
        const parsed = tryParseJsonRelaxed(jsonMatch[0]);
        if (parsed) {
            const toolName = parsed.name || parsed.tool;
            if (toolName && KNOWN_TOOLS_LIST.includes(toolName)) {
                const args = parsed.arguments || parsed.args || parsed.parameters || parsed;
                const cleanArgs = { ...args };
                delete cleanArgs.name;
                delete cleanArgs.tool;
                pushUnique(toolName, cleanArgs, jsonMatch[0]);
            }
        }
    }

    // Pattern 3: Standard Function call syntax: e.g. search_web(query="...")
    const funcRegex = new RegExp(`\\b(${KNOWN_TOOLS_REGEX_STR})\\s*\\(([\\s\\S]*?)\\)`, 'gi');
    let match;
    while ((match = funcRegex.exec(text)) !== null) {
        const toolName = match[1];
        const rawArgs = match[2].trim();
        let parsedArgs: any = {};

        // Case A: JSON object inside parentheses, e.g. search_web({"query": "foo"})
        if (rawArgs.startsWith('{') && rawArgs.endsWith('}')) {
            const parsed = tryParseJsonRelaxed(rawArgs);
            if (parsed) parsedArgs = parsed;
        }

        // Case B: keyword arguments: query="foo", command="bar"
        if (Object.keys(parsedArgs).length === 0 && rawArgs.length > 0) {
            const kwRegex = /([a-zA-Z_0-9]+)\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\d+)|(\[[^\]]*\]))/g;
            let kwMatch;
            let foundKw = false;
            while ((kwMatch = kwRegex.exec(rawArgs)) !== null) {
                foundKw = true;
                const paramName = kwMatch[1];
                const strVal = kwMatch[2] !== undefined ? kwMatch[2] : kwMatch[3];
                const numVal = kwMatch[4];
                const arrVal = kwMatch[5];
                if (strVal !== undefined) {
                    parsedArgs[paramName] = strVal.replace(/\\"/g, '"').replace(/\\'/g, "'");
                } else if (numVal !== undefined) {
                    parsedArgs[paramName] = Number(numVal);
                } else if (arrVal !== undefined) {
                    try { parsedArgs[paramName] = JSON.parse(arrVal.replace(/'/g, '"')); } catch { parsedArgs[paramName] = arrVal; }
                }
            }
            // Case C: Single string argument without parameter name: search_web("foo")
            if (!foundKw) {
                const singleStrMatch = rawArgs.match(/^["']([\s\S]*?)["']$/);
                if (singleStrMatch) {
                    if (toolName === 'search_web' || toolName === 'research_web_docs') parsedArgs = { query: singleStrMatch[1] };
                    else if (toolName === 'execute_terminal_command') parsedArgs = { command: singleStrMatch[1] };
                    else if (toolName === 'list_directory_tree') parsedArgs = { dir: singleStrMatch[1] };
                    else if (toolName === 'get_code_diagnostics' || toolName === 'get_symbol_outline') parsedArgs = { filepath: singleStrMatch[1] };
                }
            }
        }

        if (toolName && Object.keys(parsedArgs).length > 0) {
            pushUnique(toolName, parsedArgs, match[0]);
        }
    }

    // Pattern 4: XML <tool_call>...</tool_call> or <action>...</action>
    const xmlRegex = /<(?:tool_call|action)>([\s\S]*?)<\/(?:tool_call|action)>/gi;
    while ((match = xmlRegex.exec(text)) !== null) {
        const parsed = tryParseJsonRelaxed(match[1].trim());
        if (parsed && parsed.name) {
            pushUnique(parsed.name, parsed.arguments || parsed.args || {}, match[0]);
        }
    }

    // Pattern 5: Line-based shorthand: e.g. read_multiple_files \n catalog/views.py
    const shorthandRegex = new RegExp(`(?:^|\\n)\\s*(${KNOWN_TOOLS_REGEX_STR})\\s*(?::|->)?\\s*\\n\\s*([a-zA-Z0-9_\\-\\.\\/\\\\]+\\.[a-zA-Z0-9]+)\\s*(?:\\n|$)`, 'gi');
    let shortMatch;
    while ((shortMatch = shorthandRegex.exec(text)) !== null) {
        const tool = shortMatch[1].trim();
        const arg = shortMatch[2].trim();
        if (tool === 'read_multiple_files' || tool === 'get_code_diagnostics' || tool === 'get_symbol_outline') {
            const args = tool === 'read_multiple_files' ? { filepaths: [arg] } : { filepath: arg };
            pushUnique(tool, args, shortMatch[0]);
        }
    }

    // Pattern 6: Signature-Inferred Tool Calls (Naked JSON payloads without tool name)
    // Extracts balanced-brace JSON objects in markdown fences or raw text
    // Handles: { "filepaths": [ "catalog/views.py" ] }, { "command": "..." }, { "dir": ".", "depth": 2 }
    let openBraceIndex = -1;
    let braceCount = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (char === '\\') {
            escape = true;
            continue;
        }
        if (char === '"' && !escape) {
            inString = !inString;
            continue;
        }
        if (!inString) {
            if (char === '{') {
                if (braceCount === 0) {
                    openBraceIndex = i;
                }
                braceCount++;
            } else if (char === '}') {
                braceCount--;
                if (braceCount === 0 && openBraceIndex !== -1) {
                    const candidate = text.substring(openBraceIndex, i + 1).trim();
                    const parsed = tryParseJsonRelaxed(candidate);
                    if (parsed && typeof parsed === 'object') {
                        const inferred = inferToolFromObject(parsed);
                        if (inferred) {
                            pushUnique(inferred.name, inferred.args, candidate);
                        }
                    }
                    openBraceIndex = -1;
                } else if (braceCount < 0) {
                    braceCount = 0;
                    openBraceIndex = -1;
                }
            }
        }
    }

    // Pattern 7: Auto-route actionable bash code blocks to execute_terminal_command
    if (results.length === 0) {
        const bashBlockRegex = /```(?:bash|sh|cmd|powershell)\s*\n([\s\S]*?)\n```/gi;
        let bashMatch;
        while ((bashMatch = bashBlockRegex.exec(text)) !== null) {
            const rawCmd = bashMatch[1].trim();
            if (rawCmd.length > 0 && !rawCmd.startsWith('#')) {
                results.push({
                    name: 'execute_terminal_command',
                    args: { command: rawCmd, explanation: 'Auto-detected command from response' },
                    raw: bashMatch[0]
                });
                break;
            }
        }
    }

    // Pattern 8: Auto-detect conversational file reading intent (prevents hallucination and fetches real context)
    // e.g. "I am reading the project's main urls.py", "Reading urls.py to verify...", "Let me inspect catalog/views.py"
    if (results.length === 0) {
        const readIntentRegex = /(?:#|\/\/)?\s*(?:I am reading|Reading|Let me read|Let me inspect|I will inspect|Let's check|Checking)\s+(?:the\s+)?(?:project'?s?\s+main\s+)?`?([a-zA-Z0-9_\-\.\/\\]+\.[a-zA-Z0-9]+)`?/i;
        const readMatch = readIntentRegex.exec(text);
        if (readMatch && readMatch[1]) {
            const rawPath = readMatch[1].trim();
            if (!rawPath.endsWith('.md') && !rawPath.includes(' ') && rawPath.includes('.')) {
                results.push({
                    name: 'read_multiple_files',
                    args: { filepaths: [rawPath] },
                    raw: readMatch[0]
                });
            }
        }
    }

    return results;
}

export class GeminiCloudClient implements IEngine {
    public readonly name = 'Cloud-Gemini';
    private currentKeyIndex = 0;
    private keys: string[];
    private model: string;
    private timeoutMs: number;
    private maxTokens: number;

    public temperature: number = 0.4;
    public maxToolIterations: number = 30;

    constructor(keys: string[], model: string, timeoutMs: number = 30000, maxTokens: number = 8000, temperature: number = 0.4) {
        this.keys = keys || [];
        this.model = model;
        this.timeoutMs = timeoutMs;
        this.maxTokens = maxTokens;
        this.temperature = temperature;
    }

    /**
     * Resets key rotation index — call when starting a new conversation turn.
     */
    public resetKeyRotation(): void {
        this.currentKeyIndex = 0;
    }

    /**
     * Executes content completion using Google's Gemini API (non-streaming).
     * Enforces a configurable timeout logic, trying keys sequentially in case of 429, 403, or 400.
     */
    public async complete(prompt: string): Promise<CompletionResult> {
        if (!this.keys || this.keys.length === 0) {
            throw new Error('Gemini API Key is missing. Please click the ⚙️ Gear icon in the chat panel to open Agent Configuration and add your API key.');
        }
        this.resetKeyRotation();
        while (this.currentKeyIndex < this.keys.length) {
            const apiKey = this.keys[this.currentKeyIndex].trim();
            if (!apiKey) {
                this.currentKeyIndex++;
                continue;
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contents: [
                            {
                                parts: [
                                    {
                                        text: prompt
                                    }
                                ]
                            }
                        ],
                        generationConfig: {
                            maxOutputTokens: this.maxTokens
                        }
                    }),
                    signal: controller.signal
                });

                if (!response.ok) {
                    const status = response.status;
                    const errText = await response.text();
                    
                    if (status === 429 || status === 403 || status === 400 || status >= 500) {
                        console.warn(`Gemini API key index ${this.currentKeyIndex} failed with status ${status}. Trying next key. Error: ${errText}`);
                        this.currentKeyIndex++;
                        continue;
                    }
                    
                    throw new Error(`Gemini API error (Status ${status}): ${errText}`);
                }

                const data = (await response.json()) as any;
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

                if (typeof text !== 'string') {
                    throw new Error('Invalid or empty response format from Gemini API.');
                }

                const usage = data?.usageMetadata ? {
                    promptTokens: data.usageMetadata.promptTokenCount || 0,
                    completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                    totalTokens: data.usageMetadata.totalTokenCount || 0
                } : undefined;

                return { text, usage };
            } catch (error: any) {
                if (error.name === 'AbortError') {
                    throw new Error(`Gemini API call timed out after ${this.timeoutMs / 1000} seconds.`);
                }
                throw error;
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw new Error("All provided API keys have been exhausted or rate-limited.");
    }

    /**
     * Streaming content completion — delivers tokens incrementally via onChunk callback.
     * Uses Gemini's streamGenerateContent endpoint with SSE.
     */
    public async completeStream(prompt: string, onChunk: (chunk: StreamChunk) => void): Promise<CompletionResult> {
        if (!this.keys || this.keys.length === 0) {
            throw new Error('Gemini API Key is missing. Please click the ⚙️ Gear icon in the chat panel to open Agent Configuration and add your API key.');
        }
        this.resetKeyRotation();
        while (this.currentKeyIndex < this.keys.length) {
            const apiKey = this.keys[this.currentKeyIndex].trim();
            if (!apiKey) {
                this.currentKeyIndex++;
                continue;
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${apiKey}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contents: [
                            {
                                parts: [
                                    {
                                        text: prompt
                                    }
                                ]
                            }
                        ],
                        generationConfig: {
                            maxOutputTokens: this.maxTokens
                        }
                    }),
                    signal: controller.signal
                });

                if (!response.ok) {
                    const status = response.status;
                    const errText = await response.text();
                    
                    if (status === 429 || status === 403 || status === 400 || status >= 500) {
                        console.warn(`Gemini Streaming: key index ${this.currentKeyIndex} failed with status ${status}. Trying next key.`);
                        this.currentKeyIndex++;
                        continue;
                    }
                    
                    throw new Error(`Gemini Streaming API error (Status ${status}): ${errText}`);
                }

                // Process SSE stream
                let fullText = '';
                let finalUsage: CompletionResult['usage'] | undefined;

                const body = response.body;
                if (!body) {
                    throw new Error('Gemini streaming response body is null.');
                }

                const reader = body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) { break; }

                    buffer += decoder.decode(value, { stream: true });
                    
                    // Parse SSE events from buffer
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const jsonStr = line.slice(6).trim();
                            if (!jsonStr || jsonStr === '[DONE]') { continue; }

                            try {
                                const data = JSON.parse(jsonStr);
                                const chunkText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                                
                                if (chunkText) {
                                    fullText += chunkText;
                                    onChunk({ text: chunkText, done: false });
                                }

                                // Capture usage from the final chunk
                                if (data?.usageMetadata) {
                                    finalUsage = {
                                        promptTokens: data.usageMetadata.promptTokenCount || 0,
                                        completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                                        totalTokens: data.usageMetadata.totalTokenCount || 0
                                    };
                                }
                            } catch {
                                // Skip malformed JSON chunks
                            }
                        }
                    }
                }

                // Signal completion
                onChunk({ text: '', done: true, usage: finalUsage });
                return { text: fullText, usage: finalUsage };

            } catch (error: any) {
                if (error.name === 'AbortError') {
                    throw new Error(`Gemini streaming call timed out after ${this.timeoutMs / 1000} seconds.`);
                }
                throw error;
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw new Error("All provided API keys have been exhausted or rate-limited.");
    }

    /**
     * Constructs the full multi-turn Gemini API payload with system instruction and history.
     */
    public async completeWithHistory(
        systemInstructionOrOptions: string | any,
        history?: Array<{ role: 'user' | 'model'; text: string }>,
        userMessage?: string,
        stream: boolean = false,
        onChunk?: (chunk: StreamChunk) => void,
        signal?: AbortSignal,
        tools?: any[],
        onToolCall?: (functionCall: any) => Promise<any>,
        images?: any[]
    ): Promise<CompletionResult> {
        let systemInstruction = '';
        if (typeof systemInstructionOrOptions === 'object' && systemInstructionOrOptions !== null) {
            const opts = systemInstructionOrOptions;
            systemInstruction = opts.systemInstruction || '';
            history = opts.history || [];
            userMessage = opts.prompt || opts.userMessage || '';
            stream = opts.stream ?? true;
            onChunk = opts.onChunk;
            signal = opts.signal;
            tools = opts.tools;
            onToolCall = opts.onToolCall;
            images = opts.images || [];
        } else {
            systemInstruction = systemInstructionOrOptions || '';
            history = history || [];
            userMessage = userMessage || '';
        }

        if (!this.keys || this.keys.length === 0) {
            throw new Error('Gemini API Key is missing. Please click the ⚙️ Gear icon in the chat panel to open Agent Configuration and add your API key.');
        }
        this.resetKeyRotation();

        const userParts: any[] = [{ text: userMessage }];
        if (images && images.length > 0) {
            for (const img of images) {
                if (typeof img === 'string') {
                    const match = img.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        userParts.push({
                            inlineData: {
                                mimeType: match[1],
                                data: match[2]
                            }
                        });
                    } else {
                        userParts.push({
                            inlineData: {
                                mimeType: 'image/png',
                                data: img
                            }
                        });
                    }
                } else if (img?.data) {
                    userParts.push({
                        inlineData: {
                            mimeType: img.mimeType || 'image/png',
                            data: img.data
                        }
                    });
                }
            }
        }

        const contents: any[] = [
            ...(history || []).map(h => ({
                role: h.role,
                parts: [{ text: h.text }]
            })),
            { role: 'user', parts: userParts }
        ];

        let finalUsage: CompletionResult['usage'] | undefined;
        let fullText = '';
        let iteration = 0;
        const toolExecutionHistory = new Map<string, number>();

        while (iteration < this.maxToolIterations) { // Configurable tool calls per turn (default 30)
            if (signal?.aborted) {
                if (onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true, usage: finalUsage });
                return { text: fullText || 'Stopped by user.', usage: finalUsage };
            }
            iteration++;
            const requestBody: any = {
                contents,
                systemInstruction: {
                    parts: [{ text: systemInstruction }]
                },
                generationConfig: {
                    temperature: this.temperature,
                    topP: 0.95,
                    topK: 40,
                    maxOutputTokens: this.maxTokens
                }
            };

            if (tools && tools.length > 0) {
                requestBody.tools = tools;
            }

            let functionCallToExecute: any = null;
            let successWithoutTool = false;

            while (this.currentKeyIndex < this.keys.length) {
                const apiKey = this.keys[this.currentKeyIndex].trim();
                if (!apiKey) {
                    this.currentKeyIndex++;
                    continue;
                }

                const endpoint = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:${endpoint}${stream ? '&' : '?'}key=${apiKey}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
                
                const abortHandler = () => controller.abort();
                if (signal) { signal.addEventListener('abort', abortHandler); }

                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(requestBody),
                        signal: controller.signal
                    });

                    if (!response.ok) {
                        const status = response.status;
                        const errText = await response.text();
                        if (status === 429 || status === 403 || status === 400 || status >= 500) {
                            this.currentKeyIndex++;
                            continue;
                        }
                        throw new Error(`Gemini API error (Status ${status}): ${errText}`);
                    }

                    if (stream && onChunk) {
                        const body = response.body;
                        if (!body) { throw new Error('Response body is null.'); }

                        const reader = body.getReader();
                        const decoder = new TextDecoder();
                        let buffer = '';

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) { break; }
                            buffer += decoder.decode(value, { stream: true });
                            const lines = buffer.split('\n');
                            buffer = lines.pop() || '';

                            for (const line of lines) {
                                if (line.startsWith('data: ')) {
                                    const jsonStr = line.slice(6).trim();
                                    if (!jsonStr || jsonStr === '[DONE]') { continue; }
                                    try {
                                        const data = JSON.parse(jsonStr);
                                        const funcCall = data?.candidates?.[0]?.content?.parts?.[0]?.functionCall;
                                        
                                        if (funcCall) {
                                            functionCallToExecute = funcCall;
                                        }

                                        const chunkText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                                        if (chunkText) {
                                            fullText += chunkText;
                                            onChunk({ text: chunkText, done: false });
                                        }
                                        if (data?.usageMetadata) {
                                            finalUsage = {
                                                promptTokens: data.usageMetadata.promptTokenCount || 0,
                                                completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                                                totalTokens: data.usageMetadata.totalTokenCount || 0
                                            };
                                        }
                                    } catch { /* skip malformed */ }
                                }
                            }
                            if (functionCallToExecute) break;
                        }
                    } else {
                        const data = (await response.json()) as any;
                        const funcCall = data?.candidates?.[0]?.content?.parts?.[0]?.functionCall;
                        if (funcCall) {
                            functionCallToExecute = funcCall;
                        } else {
                            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (text) { fullText += text; }
                        }
                        
                        if (data?.usageMetadata) {
                            finalUsage = {
                                promptTokens: data.usageMetadata.promptTokenCount || 0,
                                completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                                totalTokens: data.usageMetadata.totalTokenCount || 0
                            };
                        }
                    }

                    successWithoutTool = !functionCallToExecute;
                    break; // break the keys loop, we got a successful response (either tool or text)
                } catch (error: any) {
                    if (error.name === 'AbortError') {
                        if (signal?.aborted) throw new Error('Generation stopped by user.');
                        throw new Error(`Gemini API call timed out after ${this.timeoutMs / 1000} seconds.`);
                    }
                    throw error;
                } finally {
                    clearTimeout(timeoutId);
                    if (signal) signal.removeEventListener('abort', abortHandler);
                }
            } // end keys loop

            if (this.currentKeyIndex >= this.keys.length && !successWithoutTool && !functionCallToExecute) {
                throw new Error("All provided API keys have been exhausted or rate-limited.");
            }

            if (!functionCallToExecute && onToolCall) {
                const textCalls = extractTextToolCalls(fullText);
                if (textCalls.length > 0) {
                    functionCallToExecute = { name: textCalls[0].name, args: textCalls[0].args };
                } else {
                    const toolSpecs = getToolSpecsFromTools(tools);
                    const repaired = repairToolCall(fullText, toolSpecs);
                    if (repaired) {
                        functionCallToExecute = { name: repaired.name, args: repaired.args };
                    }
                }
            }

            if (functionCallToExecute && onToolCall) {
                if (signal?.aborted) {
                    if (onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true, usage: finalUsage });
                    return { text: fullText || 'Stopped by user.', usage: finalUsage };
                }

                if (onChunk) onChunk({ text: `\n> *⚙️ AI is using tool: \`${functionCallToExecute.name}\`*\n`, done: false });
                
                let toolResult: any;
                const callSignature = `${functionCallToExecute.name}:${JSON.stringify(functionCallToExecute.args || {})}`;
                const callCount = (toolExecutionHistory.get(callSignature) || 0) + 1;
                toolExecutionHistory.set(callSignature, callCount);

                if (callCount > 2) {
                    toolResult = `[LOOP PREVENTED]: Tool '${functionCallToExecute.name}' with the same arguments was already executed ${callCount - 1} times in this turn. Aborting repeat execution to prevent loop.`;
                } else {
                    try {
                        toolResult = await onToolCall(functionCallToExecute);
                    } catch (err: any) {
                        if (signal?.aborted || err?.message?.includes('aborted') || err?.message?.includes('AbortError')) {
                            if (onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true, usage: finalUsage });
                            return { text: fullText || 'Stopped by user.', usage: finalUsage };
                        }
                        toolResult = `Error executing tool: ${err?.message}`;
                    }
                }

                if (signal?.aborted) {
                    if (onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true, usage: finalUsage });
                    return { text: fullText || 'Stopped by user.', usage: finalUsage };
                }

                // Safety: Clamp any massive tool result to max 8,000 characters to prevent 170k context explosion
                let safeResultText = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
                if (safeResultText.length > 8000) {
                    safeResultText = safeResultText.substring(0, 8000) + '\n\n... [Output truncated to 8000 chars for context safety]';
                }

                contents.push({
                    role: 'model',
                    parts: [{ functionCall: functionCallToExecute }]
                });
                contents.push({
                    role: 'function',
                    parts: [{
                        functionResponse: {
                            name: functionCallToExecute.name,
                            response: { result: safeResultText }
                        }
                    }]
                });
                continue;
            }

            // Done generating!
            if (onChunk) onChunk({ text: '', done: true, usage: finalUsage });
            return { text: fullText, usage: finalUsage };
        } // end tool loop
        
        if (onChunk) onChunk({ text: '\n\n*Completed maximum autonomous tool executions for this turn. Proceeding with the project roadmap.*', done: true, usage: finalUsage });
        return { text: fullText || 'Completed autonomous tool executions for this turn. Proceeding with next planned steps.', usage: finalUsage };
    }
}

/**
 * Client for local models compatible with Ollama/OpenAI API.
 */
export class LocalOllamaClient implements IEngine {
    public readonly name = 'Local-Model';
    public temperature: number = 0.4;
    public maxToolIterations: number = 30;

    constructor(private model: string = 'llama3', private endpoint: string = 'http://127.0.0.1:11434', private apiKey?: string, temperature: number = 0.4) {
        this.temperature = temperature;
    }

    public async complete(prompt: string): Promise<CompletionResult> {
        return this.completeWithHistory('', [], prompt);
    }

    public async completeStream(prompt: string, onChunk: (chunk: StreamChunk) => void): Promise<CompletionResult> {
        return this.completeWithHistory('', [], prompt, true, onChunk);
    }

    public async completeWithHistory(
        systemInstructionOrOptions: string | any,
        history?: Array<{ role: 'user' | 'model'; text: string }>,
        userMessage?: string,
        stream: boolean = false,
        onChunk?: (chunk: StreamChunk) => void,
        signal?: AbortSignal,
        tools?: any[],
        onToolCall?: (functionCall: any) => Promise<any>,
        images?: any[]
    ): Promise<CompletionResult> {
        let systemInstruction = '';
        if (typeof systemInstructionOrOptions === 'object' && systemInstructionOrOptions !== null) {
            const opts = systemInstructionOrOptions;
            systemInstruction = opts.systemInstruction || '';
            history = opts.history || [];
            userMessage = opts.prompt || opts.userMessage || '';
            stream = opts.stream ?? true;
            onChunk = opts.onChunk;
            signal = opts.signal;
            tools = opts.tools;
            onToolCall = opts.onToolCall;
            images = opts.images || [];
        } else {
            systemInstruction = systemInstructionOrOptions || '';
            history = history || [];
            userMessage = userMessage || '';
        }

        let messages: any[] = [];
        if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
        
        (history || []).forEach(h => {
            messages.push({ role: h.role === 'model' ? 'assistant' : 'user', content: h.text });
        });

        if (images && images.length > 0) {
            const userContent: any[] = [{ type: 'text', text: userMessage }];
            const ollamaImages: string[] = [];
            for (const img of images) {
                const rawB64 = typeof img === 'string' ? img.replace(/^data:image\/[^;]+;base64,/, '') : (img.data || '');
                ollamaImages.push(rawB64);
                const url = typeof img === 'string' ? (img.startsWith('data:') ? img : `data:image/png;base64,${img}`) : (img.url || `data:${img.mimeType || 'image/png'};base64,${img.data}`);
                userContent.push({ type: 'image_url', image_url: { url } });
            }
            messages.push({
                role: 'user',
                content: userContent,
                ...(ollamaImages.length > 0 ? { images: ollamaImages } : {})
            });
        } else {
            messages.push({ role: 'user', content: userMessage });
        }

        let cleanEndpoint = (this.endpoint || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
        
        let url = '';
        if (cleanEndpoint.includes('/chat/completions')) {
            url = cleanEndpoint;
        } else if (cleanEndpoint.endsWith('/api/chat')) {
            url = cleanEndpoint;
        } else if (cleanEndpoint.includes(':11434')) {
            url = `${cleanEndpoint}/api/chat`;
        } else if (cleanEndpoint.endsWith('/v1')) {
            url = `${cleanEndpoint}/chat/completions`;
        } else {
            url = `${cleanEndpoint}/v1/chat/completions`;
        }

        const isOllama = url.includes('/api/chat');

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(this.apiKey && this.apiKey.trim() ? { 'Authorization': `Bearer ${this.apiKey.trim()}` } : {})
        };

        // Convert Gemini-format tools to OpenAI-format tools for Groq/OpenAI
        let openAITools: any[] | undefined;
        if (tools && tools[0]?.functionDeclarations && !isOllama) {
            openAITools = tools[0].functionDeclarations.map((f: any) => ({
                type: 'function',
                function: {
                    name: f.name,
                    description: f.description || '',
                    parameters: f.parameters || { type: 'object', properties: {} }
                }
            }));
        }

        const MAX_TOOL_ITERATIONS = this.maxToolIterations;
        const localToolExecutionCounts = new Map<string, number>();
        let lastFullText = '';
        let currentUsage: CompletionResult['usage'] | undefined;

        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
            if (signal?.aborted) {
                if (stream && onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true, usage: currentUsage });
                return { text: lastFullText || 'Stopped by user.', usage: currentUsage };
            }
            const requestBody: any = {
                model: this.model,
                messages: messages,
                stream: stream,
                temperature: this.temperature
            };

            // Only add tools on non-streaming or tool-loop iterations
            if (openAITools && openAITools.length > 0) {
                requestBody.tools = openAITools;
                requestBody.tool_choice = 'auto';
            }

            let response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestBody),
                signal
            });

            // If proxy fails with 400/422/500 on tools or role 'tool', retry without native tools by converting to plain conversational prompts
            if (!response.ok && (requestBody.tools || messages.some((m: any) => m.role === 'tool' || m.tool_calls))) {
                console.warn(`[LocalOllamaClient] API request failed with status ${response.status}. Attempting conversational fallback...`);
                const fallbackMessages = messages.map(m => {
                    if (m.role === 'tool') {
                        return { role: 'user', content: `[Tool Execution Result]:\n${m.content}\n\nPlease inspect this result and proceed to the next step.` };
                    }
                    if (m.role === 'assistant' && (m.tool_calls || m.content === null || m.content === '')) {
                        return { role: 'assistant', content: m.content || `[Executing requested tool operation...]` };
                    }
                    return m;
                });
                const fallbackBody = {
                    ...requestBody,
                    messages: fallbackMessages,
                    tools: undefined,
                    tool_choice: undefined
                };
                response = await fetch(url, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(fallbackBody),
                    signal
                });
            }

            if (!response.ok) {
                throw new Error(`Local model failed: ${response.status} ${await response.text()}`);
            }

            // --- STREAMING PATH (only for the final text response) ---
            if (requestBody.stream && onChunk) {
                let fullText = '';
                let toolCallsAccumulator: any[] = [];
                const body = response.body;
                if (!body) throw new Error('Response body is null');
                
                const reader = body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let isInsideThinking = false;
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    
                    for (const line of lines) {
                        if (line.trim() === '') continue;
                        try {
                            if (isOllama) {
                                const data = JSON.parse(line);
                                const reasoning = data.message?.reasoning_content || '';
                                const content = data.message?.content || '';
                                if (reasoning) {
                                    if (!isInsideThinking) {
                                        isInsideThinking = true;
                                        fullText += '<think>' + reasoning;
                                        onChunk({ text: '<think>' + reasoning, done: false });
                                    } else {
                                        fullText += reasoning;
                                        onChunk({ text: reasoning, done: false });
                                    }
                                }
                                if (content) {
                                    if (isInsideThinking) {
                                        isInsideThinking = false;
                                        fullText += '</think>' + content;
                                        onChunk({ text: '</think>' + content, done: false });
                                    } else {
                                        fullText += content;
                                        onChunk({ text: content, done: false });
                                    }
                                }
                            } else {
                                if (line.startsWith('data: ')) {
                                    const dataStr = line.slice(6);
                                    if (dataStr.trim() === '[DONE]') continue;
                                    const data = JSON.parse(dataStr);
                                    if (data.usage) {
                                        currentUsage = {
                                            promptTokens: data.usage.prompt_tokens || 0,
                                            completionTokens: data.usage.completion_tokens || 0,
                                            totalTokens: data.usage.total_tokens || ((data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0))
                                        };
                                    }
                                    const delta = data.choices?.[0]?.delta;
                                    
                                    // Handle streamed tool calls
                                    if (delta?.tool_calls) {
                                        for (const tc of delta.tool_calls) {
                                            if (tc.index !== undefined) {
                                                if (!toolCallsAccumulator[tc.index]) {
                                                    toolCallsAccumulator[tc.index] = { id: tc.id || '', name: '', arguments: '' };
                                                }
                                                if (tc.function?.name) toolCallsAccumulator[tc.index].name = tc.function.name;
                                                if (tc.function?.arguments) toolCallsAccumulator[tc.index].arguments += tc.function.arguments;
                                            }
                                        }
                                    }
                                    
                                    const reasoning = delta?.reasoning_content || delta?.reasoning || delta?.thought || '';
                                    const content = delta?.content || '';

                                    if (reasoning) {
                                        if (!isInsideThinking) {
                                            isInsideThinking = true;
                                            fullText += '<think>' + reasoning;
                                            onChunk({ text: '<think>' + reasoning, done: false });
                                        } else {
                                            fullText += reasoning;
                                            onChunk({ text: reasoning, done: false });
                                        }
                                    }

                                    if (content) {
                                        if (isInsideThinking) {
                                            isInsideThinking = false;
                                            fullText += '</think>' + content;
                                            onChunk({ text: '</think>' + content, done: false });
                                        } else {
                                            fullText += content;
                                            onChunk({ text: content, done: false });
                                        }
                                    }
                                }
                            }
                        } catch (e) { 
                            console.error("Local stream parse error", e, "Line:", line);
                        }
                    }
                }
                if (isInsideThinking) {
                    isInsideThinking = false;
                    fullText += '</think>';
                    onChunk({ text: '</think>', done: false });
                }
                // Parse remaining buffer
                if (buffer.trim() !== '') {
                    try {
                        if (isOllama) {
                            const data = JSON.parse(buffer);
                            const reasoning = data.message?.reasoning_content || '';
                            const content = data.message?.content || '';
                            if (reasoning) {
                                fullText += '<think>' + reasoning + '</think>';
                                onChunk({ text: '<think>' + reasoning + '</think>', done: false });
                            }
                            if (content) {
                                fullText += content;
                                onChunk({ text: content, done: false });
                            }
                        }
                    } catch (e) { console.error("Local stream buffer parse error", e); }
                }

                // If no structured tool calls were streamed, check for text-based tool calls in fullText
                if (toolCallsAccumulator.length === 0 && onToolCall) {
                    const textCalls = extractTextToolCalls(fullText);
                    if (textCalls.length > 0) {
                        toolCallsAccumulator = textCalls.map((tc, i) => ({
                            id: `call_text_${i}`,
                            name: tc.name,
                            arguments: JSON.stringify(tc.args)
                        }));
                    } else {
                        const toolSpecs = getToolSpecsFromTools(tools);
                        const repaired = repairToolCall(fullText, toolSpecs);
                        if (repaired) {
                            toolCallsAccumulator = [{
                                id: `call_repaired_0`,
                                name: repaired.name,
                                arguments: JSON.stringify(repaired.args)
                            }];
                        }
                    }
                }

                // If tool calls were streamed, handle them
                if (toolCallsAccumulator.length > 0 && onToolCall) {
                    if (signal?.aborted) {
                        if (stream && onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true });
                        return { text: lastFullText || 'Stopped by user.' };
                    }

                    const isTextDetected = toolCallsAccumulator.some(tc => (tc.id || '').startsWith('call_text_') || (tc.id || '').startsWith('call_repaired_'));
                    if (isTextDetected) {
                        // Conversational history for text-based models (llama-server, Ollama, etc.)
                        messages.push({ role: 'assistant', content: fullText || `[Invoking tool operation...]` });
                        for (const tc of toolCallsAccumulator) {
                            if (signal?.aborted) {
                                if (stream && onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true });
                                return { text: lastFullText || 'Stopped by user.' };
                            }
                            try {
                                const args = JSON.parse(tc.arguments);
                                const callSig = `${tc.name}:${tc.arguments}`;
                                const count = (localToolExecutionCounts.get(callSig) || 0) + 1;
                                localToolExecutionCounts.set(callSig, count);

                                if (count > 2) {
                                    const loopMsg = `[LOOP PREVENTED]: Tool '${tc.name}' with identical parameters was already called ${count - 1} times in this turn. Halting repeated execution. Please analyze previous results and proceed to the next step.`;
                                    messages.push({ role: 'user', content: loopMsg });
                                    continue;
                                }

                                const result = await onToolCall({ name: tc.name, args });
                                const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                                messages.push({ role: 'user', content: `[Tool Result (${tc.name})]:\n${resultStr}\n\nPlease inspect the output and proceed to the next step.` });
                            } catch (e: any) {
                                if (signal?.aborted || e?.message?.includes('aborted') || e?.message?.includes('AbortError')) {
                                    if (stream && onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true });
                                    return { text: lastFullText || 'Stopped by user.' };
                                }
                                messages.push({ role: 'user', content: `[Tool Execution Error (${tc.name})]: ${e.message}\nPlease correct and proceed.` });
                            }
                        }
                    } else {
                        // Native OpenAI format
                        messages.push({ role: 'assistant', content: '', tool_calls: toolCallsAccumulator.map((tc, i) => ({ id: tc.id || `call_${i}`, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) });
                        for (const tc of toolCallsAccumulator) {
                            if (signal?.aborted) {
                                if (stream && onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true });
                                return { text: lastFullText || 'Stopped by user.' };
                            }
                            try {
                                const args = JSON.parse(tc.arguments);
                                const callSig = `${tc.name}:${tc.arguments}`;
                                const count = (localToolExecutionCounts.get(callSig) || 0) + 1;
                                localToolExecutionCounts.set(callSig, count);

                                if (count > 2) {
                                    const loopMsg = `[LOOP PREVENTED]: Tool '${tc.name}' with identical parameters was already called ${count - 1} times in this turn. Halting repeated execution. Please analyze previous results and proceed to the next step.`;
                                    messages.push({ role: 'tool', tool_call_id: tc.id || `call_${toolCallsAccumulator.indexOf(tc)}`, content: loopMsg });
                                    continue;
                                }

                                const result = await onToolCall({ name: tc.name, args });
                                messages.push({ role: 'tool', tool_call_id: tc.id || `call_${toolCallsAccumulator.indexOf(tc)}`, content: typeof result === 'string' ? result : JSON.stringify(result) });
                            } catch (e: any) {
                                if (signal?.aborted || e?.message?.includes('aborted') || e?.message?.includes('AbortError')) {
                                    if (stream && onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true });
                                    return { text: lastFullText || 'Stopped by user.' };
                                }
                                messages.push({ role: 'tool', tool_call_id: tc.id || `call_${toolCallsAccumulator.indexOf(tc)}`, content: `Error: ${e.message}` });
                            }
                        }
                    }
                    continue; // Loop back for next API call
                }
                
                if (!currentUsage) {
                    const estPrompt = Math.max(1, Math.round(JSON.stringify(messages).length / 4));
                    const estComp = Math.max(1, Math.round(fullText.length / 4));
                    currentUsage = {
                        promptTokens: estPrompt,
                        completionTokens: estComp,
                        totalTokens: estPrompt + estComp
                    };
                }
                onChunk({ text: '', done: true, usage: currentUsage });
                return { text: fullText, usage: currentUsage };

            } else {
                // --- NON-STREAMING PATH ---
                let fullText = '';
                const rawText = await response.text();
                
                try {
                    if (isOllama) {
                        const lines = rawText.split('\n').filter(l => l.trim() !== '');
                        for (const line of lines) {
                            const data = JSON.parse(line);
                            fullText += data.message?.content || '';
                        }
                    } else {
                        const data = JSON.parse(rawText);
                        const choice = data.choices?.[0];
                        
                        // Check if the model wants to call tools (or fallback to text-based tool calls)
                        let toolCalls = choice?.message?.tool_calls;
                        if ((!toolCalls || toolCalls.length === 0) && onToolCall) {
                            const raw = choice?.message?.content || fullText;
                            const textCalls = extractTextToolCalls(raw);
                            if (textCalls.length > 0) {
                                toolCalls = textCalls.map((tc, i) => ({
                                    id: `call_text_${i}`,
                                    type: 'function',
                                    function: { name: tc.name, arguments: JSON.stringify(tc.args) }
                                }));
                            } else {
                                const toolSpecs = getToolSpecsFromTools(tools);
                                const repaired = repairToolCall(raw, toolSpecs);
                                if (repaired) {
                                    toolCalls = [{
                                        id: `call_repaired_0`,
                                        type: 'function',
                                        function: { name: repaired.name, arguments: JSON.stringify(repaired.args) }
                                    }];
                                }
                            }
                        }
                        if (toolCalls && toolCalls.length > 0 && onToolCall) {
                            if (signal?.aborted) {
                                if (stream && onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true });
                                return { text: lastFullText || 'Stopped by user.' };
                            }

                            const isTextDetected = toolCalls.some((tc: any) => (tc.id || '').startsWith('call_text_') || (tc.id || '').startsWith('call_repaired_'));
                            if (isTextDetected) {
                                messages.push({ role: 'assistant', content: lastFullText || `[Invoking tool operation...]` });
                                for (const tc of toolCalls) {
                                    if (signal?.aborted) {
                                        if (stream && onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true });
                                        return { text: lastFullText || 'Stopped by user.' };
                                    }
                                    try {
                                        const args = JSON.parse(tc.function.arguments);
                                        const callSig = `${tc.function.name}:${tc.function.arguments}`;
                                        const count = (localToolExecutionCounts.get(callSig) || 0) + 1;
                                        localToolExecutionCounts.set(callSig, count);

                                        if (count > 2) {
                                            const loopMsg = `[LOOP PREVENTED]: Tool '${tc.function.name}' with identical parameters was already called ${count - 1} times in this turn. Halting repeated execution. Please analyze previous results and proceed to the next step.`;
                                            messages.push({ role: 'user', content: loopMsg });
                                            continue;
                                        }

                                        if (onChunk) onChunk({ text: `\n> *⚙️ Tool: \`${tc.function.name}\`*\n`, done: false });
                                        const result = await onToolCall({ name: tc.function.name, args });
                                        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                                        messages.push({
                                            role: 'user',
                                            content: `[Tool Result (${tc.function.name})]:\n${resultStr}\n\nPlease inspect the output and proceed to the next step.`
                                        });
                                    } catch (e: any) {
                                        if (signal?.aborted || e?.message?.includes('aborted') || e?.message?.includes('AbortError')) {
                                            if (stream && onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true });
                                            return { text: lastFullText || 'Stopped by user.' };
                                        }
                                        messages.push({
                                            role: 'user',
                                            content: `[Tool Execution Error (${tc.function.name})]: ${e.message}\nPlease correct and proceed.`
                                        });
                                    }
                                }
                            } else {
                                messages.push(choice.message);
                                for (const tc of toolCalls) {
                                    if (signal?.aborted) {
                                        if (stream && onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true });
                                        return { text: lastFullText || 'Stopped by user.' };
                                    }
                                    try {
                                        const args = JSON.parse(tc.function.arguments);
                                        const callSig = `${tc.function.name}:${tc.function.arguments}`;
                                        const count = (localToolExecutionCounts.get(callSig) || 0) + 1;
                                        localToolExecutionCounts.set(callSig, count);

                                        if (count > 2) {
                                            const loopMsg = `[LOOP PREVENTED]: Tool '${tc.function.name}' with identical parameters was already called ${count - 1} times in this turn. Halting repeated execution. Please analyze previous results and proceed to the next step.`;
                                            messages.push({ role: 'tool', tool_call_id: tc.id, content: loopMsg });
                                            continue;
                                        }

                                        if (onChunk) onChunk({ text: `\n> *⚙️ Tool: \`${tc.function.name}\`*\n`, done: false });
                                        const result = await onToolCall({ name: tc.function.name, args });
                                        messages.push({
                                            role: 'tool',
                                            tool_call_id: tc.id,
                                            content: typeof result === 'string' ? result : JSON.stringify(result)
                                        });
                                    } catch (e: any) {
                                        if (signal?.aborted || e?.message?.includes('aborted') || e?.message?.includes('AbortError')) {
                                            if (stream && onChunk) onChunk({ text: '\n\n*🛑 Generation stopped by user.*', done: true });
                                            return { text: lastFullText || 'Stopped by user.' };
                                        }
                                        messages.push({
                                            role: 'tool',
                                            tool_call_id: tc.id,
                                            content: `Error executing tool: ${e.message}`
                                        });
                                    }
                                }
                            }
                            continue; // Loop back for next API call with tool results
                        }
                        
                        if (data.usage) {
                            currentUsage = {
                                promptTokens: data.usage.prompt_tokens || 0,
                                completionTokens: data.usage.completion_tokens || 0,
                                totalTokens: data.usage.total_tokens || ((data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0))
                            };
                        }
                        fullText = choice?.message?.content || '';
                    }
                } catch (e) {
                    fullText = rawText;
                }

                if (!currentUsage) {
                    const estPrompt = Math.max(1, Math.round(JSON.stringify(messages).length / 4));
                    const estComp = Math.max(1, Math.round(fullText.length / 4));
                    currentUsage = {
                        promptTokens: estPrompt,
                        completionTokens: estComp,
                        totalTokens: estPrompt + estComp
                    };
                }
                lastFullText = fullText;
                if (stream && onChunk) {
                    onChunk({ text: fullText, done: false });
                    onChunk({ text: '', done: true, usage: currentUsage });
                }
                return { text: fullText, usage: currentUsage };
            }
        }

        if (stream && onChunk) {
            onChunk({ text: '\n\n*Completed maximum autonomous tool executions for this turn. Proceeding with the project roadmap.*', done: true });
        }
        return { text: lastFullText || 'Completed autonomous tool executions for this turn. Proceeding with next planned steps.' };
    }
}
