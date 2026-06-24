import * as fs from 'fs';
import * as path from 'path';
import { AgentConfig } from '../config';
import { ProjectScanner } from '../indexer/projectScanner';
import { TerminalCapture } from '../tools/terminalCapture';
import { FrameworkConventions } from '../utils/frameworkConventions';
import { ToolRegistry } from '../tools/toolRegistry';
import { SessionMemory } from '../state/sessionMemory';

export class PromptBuilder {
    /**
     * Builds the system instruction dynamically based on modes and project context.
     */
    public static buildSystemInstruction(
        config: AgentConfig | null, 
        workspaceRoot?: string, 
        isAgentMode: boolean = false, 
        isArchitectMode: boolean = false,
        taskCategory: 'ui' | 'backend' | 'info' | 'general' = 'general'
    ): string {
        let systemInstruction = config?.systemInstructions || 
            'You are an AI coding agent. Always wrap your code solutions in standard markdown code blocks.';
        
        systemInstruction = systemInstruction.replace(/Provide the complete code file content so it can be directly applied\.?/g, '').trim();
        
        systemInstruction += `
You are an expert debugger and 10x developer. Always think step-by-step before making changes.
When modifying existing code, DO NOT rewrite the entire file unless asked. Use Search and Replace blocks to patch specific lines or functions.
Format the blocks exactly like this:

**\`src/filepath.ext\`**
\`\`\`javascript
<<<<<<< SEARCH
exact code to be replaced
=======
new updated code
>>>>>>> REPLACE
\`\`\`

CRITICAL: The SEARCH block MUST perfectly match the existing code, including indentation.
You can include multiple Search/Replace blocks for the same file if needed.
If you MUST provide a complete file rewrite, format it like this without the search/replace markers:
**\`src/filepath.ext\`**
\`\`\`javascript
// full code here
\`\`\`

ANTI-HALLUCINATION RULES FOR SEARCH BLOCKS (Violations will corrupt user files):
1. NEVER write what you "think" the code looks like. The SEARCH block MUST be copied character-for-character from the actual file content provided to you.
2. If the file is small (under 150 lines), ALWAYS use a full file rewrite instead of SEARCH/REPLACE to avoid mismatch errors.
3. NEVER include markdown fences inside a SEARCH or REPLACE block.
4. Include 3-5 lines of surrounding context in SEARCH blocks to make the match unambiguous.
5. If you are unsure of the exact content, ask for the file content before making changes.

CRITICAL UI FORMATTING RULES:
- NEVER use the **\`filepath.ext\`** header for general explanations, examples, or thinking. 
- ONLY use the **\`filepath.ext\`** header when you want the system to actually modify or create that file!
- If you output your thought process (e.g., in <think> tags), keep it strictly as plain text without file headers or code blocks.

ANTI-ELISION RULE (CRITICAL):
NEVER use placeholders like "// rest of the code remains the same" or "// ...". You MUST write the complete, exact code in the SEARCH block and the complete updated code in the REPLACE block. If you use placeholders, the file parser will corrupt the user's files and delete their working code. DO NOT DELETE WORKING CODE.

You have the ability to suggest Terminal commands to test your code, debug, or install dependencies.
If you need to execute a command, provide it in a standard \`\`\`bash block.`;

            systemInstruction += `\nIf the user provides a short 2-3 line request for a new feature or project, first analyze the context, create a step-by-step plan, and then execute it. 
If the user provides a detailed plan with steps, acknowledge it and systematically execute their exact steps without deviating.
When suggesting terminal commands, ALWAYS wrap them in \`\`\`bash code blocks so the user can execute them.`;

        if (isArchitectMode) {
            systemInstruction += `\n\n[ARCHITECT MODE ACTIVE]: You are building a large project or feature. 
CRITICAL RULE 1: If the user asks you to build a NEW project using a framework (React, Next.js, Django, Vue, Vite, etc.), you MUST FIRST ONLY provide the exact CLI terminal commands to scaffold the project (e.g., \`django-admin startproject\`, \`npx create-next-app\`) using standard \`\`\`bash blocks. DO NOT provide ANY code files or file modifications in this first response.
CRITICAL RULE 2: STOP GENERATING immediately after providing the scaffolding commands. Wait for the user to run them and reply.
CRITICAL RULE 3: Once the scaffold is ready, carefully read the context. Do not make arbitrary changes. Break down your coding steps and provide ONLY 1 or 2 file modifications per response. Ask the user for confirmation to continue.
Do NOT attempt to write the entire codebase at once.`;
        }

        systemInstruction += `\n\nCRITICAL ARCHITECTURE, TOOL & TOKEN RULES:
1. ZERO HALLUCINATION: NEVER guess file paths, folder structures, or variable names. If you don't know the exact path, you MUST use the 'search_codebase' tool to find it. Do NOT make up paths.
2. USE YOUR TOOLS: You have been provided with function tools (search_codebase, read_multiple_files, etc.). In normal chat, if a user asks to fix a bug or asks about a file not in context, DO NOT GUESS. You are REQUIRED to use these tools to gather context before answering.
3. RAG/SEARCH FIRST: Always use the 'search_codebase' (RAG) tool first to search for keywords. Once you know the exact file paths from RAG, use 'read_multiple_files' to read them.
4. TOKEN EFFICIENCY: Read multiple files at once using the 'read_multiple_files' tool passing an array of paths.
5. MODULARITY: NEVER write massive, monolithic files. Break down logic into small, modular files.
6. AMBIGUITY RULE (CRITICAL): If the user says "fix error", "solve this bug", or "something is broken" WITHOUT providing the actual error message or traceback, you MUST STOP and ask: "Please paste the exact error message or traceback so I can fix it precisely."
7. TOOL LOOP PREVENTION: Never call the same tool with the same arguments twice in a row.
8. CONTEXT FALLBACK: A background Scout agent may provide initial context in <scout_context> tags. If this context is missing, insufficient, or incomplete, YOU MUST use the 'read_multiple_files' or 'search_codebase' tools yourself to fetch the missing code before generating your response.
9. ARCHITECTURE UPDATES: Whenever you solve a bug, add a feature, or make significant code changes, you MUST use the 'update_architecture_context' tool to log the changes.
10. STEP-BY-STEP LIMIT: Provide a MAXIMUM of 3 file modifications per response.
11. DEBUGGING & COMMANDS: When analyzing an error, do NOT hallucinate the cause. Output the necessary terminal command in a \`\`\`bash block and explicitly say: "Please run this command and provide the output so I can analyze the error."`;


        if (taskCategory === 'ui' || taskCategory === 'general') {
            systemInstruction += `\n\nCRITICAL UI/UX & DESIGN RULES (For Frontend/UI Tasks):\n1. TWO-STEP DESIGN PROCESS & WEB RESEARCH: If the user asks to build a UI, you MUST FIRST use the 'generate_ui_blueprint' tool.\n2. THEME PERSISTENCE: Append researched themes to '.agentrules' so they persist.\n3. IMAGE HACK: NEVER leave empty img tags. Use https://picsum.photos/WxH for images, https://i.pravatar.cc/150 for avatars.\n4. LOGO GENERATION: Generate a beautiful INLINE SVG logo. Never use placeholder images.\n5. ANIMATIONS: Make design ALIVE — hover states, CSS keyframes, transitions on all interactive elements.\n6. MODERN AESTHETICS: Glassmorphism, dark mode, gradients, subtle borders, rounded corners.\n7. DESIGN QUALITY CHECKLIST — silently verify before submitting any UI code:\n   - No plain white/black background (use gradient, dark surface, or glassmorphism)\n   - All buttons/cards/links have hover + transition effects\n   - Google Fonts declared explicitly in <link> or @import\n   - No empty <img src=""> tags\n   - At least one CSS @keyframes animation present\n   - Clear visual hierarchy: H1 > H2 > body text\n   - Color contrast is readable`;
        }


        if (isAgentMode) {
            systemInstruction += `\n[ARCHITECT MODE ACTIVE]: You are a senior software architect. Provide clear, step-by-step implementations.`;
            
            if (workspaceRoot) {
                const profile = ProjectScanner.getProfile(workspaceRoot);
                if (profile && profile.framework) {
                    const conventions = FrameworkConventions.getConvention(profile.framework);
                    if (conventions) {
                        systemInstruction += `\n\n${conventions}`;
                    }
                }
            }
        }
        
        // Add Project-specific rules
        if (workspaceRoot) {
            const profile = ProjectScanner.getProfile(workspaceRoot);
            if (profile && profile.stack !== 'Unknown') {
                systemInstruction += `\n\n### PROJECT PROFILE ###\n- Stack: ${profile.stack}\n- Framework: ${profile.framework}\n- Entry Points: ${profile.entryPoints.join(', ')}\n`;
                if (profile.devCommand) systemInstruction += `- Run Command: ${profile.devCommand}\n`;
            }

            // Inject Session Memory (replaces 10 turns of history with precise state)
            const sessionCtx = SessionMemory.buildContextHeader(workspaceRoot);
            if (sessionCtx) systemInstruction += sessionCtx;

            const agentRulesPath = path.join(workspaceRoot, '.agentrules');
            const cursorRulesPath = path.join(workspaceRoot, '.cursorrules');
            
            if (fs.existsSync(agentRulesPath)) {
                systemInstruction += `\n\n### PROJECT RULES ###\nYou MUST strictly follow these project rules defined by the user:\n${fs.readFileSync(agentRulesPath, 'utf8')}\n`;
            } else if (fs.existsSync(cursorRulesPath)) {
                systemInstruction += `\n\n### PROJECT RULES ###\nYou MUST strictly follow these project rules defined by the user:\n${fs.readFileSync(cursorRulesPath, 'utf8')}\n`;
            }
            
            const lastTerminalOutput = TerminalCapture.getLastOutput();
            if (lastTerminalOutput) {
                systemInstruction += `\n\n### TERMINAL OUTPUT ###\nThe following is the output from the last executed command:\n<terminal_output>\n${lastTerminalOutput}\n</terminal_output>\nAnalyze this output to fix any errors.`;
            }

            ToolRegistry.loadWorkspacePlugins(workspaceRoot);
            systemInstruction += ToolRegistry.getAvailableToolsPrompt();
        }

        return systemInstruction;
    }
}
