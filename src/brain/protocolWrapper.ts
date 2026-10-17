import { ModelProfile } from '../config/modelProfile';

export interface ProtocolEnvInfo {
    os?: string;
    shell?: string;
    pythonVersion?: string;
    nodeVersion?: string;
    workspaceName?: string;
    provider?: string;
}

/**
 * Builds a natural developer prompt combined with the strict output protocol
 * sent to Web Brain (Gemini/ChatGPT Web) in the browser.
 */
export function buildWrapper(profile: ModelProfile, env?: ProtocolEnvInfo, taskContext?: string): string {
    const osName = env?.os || (process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux');
    const shellName = env?.shell || (process.platform === 'win32' ? 'PowerShell 5.1/7' : 'bash/sh');
    const pyVer = env?.pythonVersion || 'available';
    const nodeVer = env?.nodeVersion || process.version;
    const wsName = env?.workspaceName || 'current workspace';
    const providerName = env?.provider ? env.provider.charAt(0).toUpperCase() + env.provider.slice(1).toLowerCase() : 'Gemini';

    const naturalGreeting = `Hi ${providerName}, please help me with the following task in my VS Code project.`;

    const taskBlock = taskContext?.trim()
        ? `\n\n[TASK & OBJECTIVE]:\n${taskContext.trim()}\n`
        : '';

    return `${naturalGreeting}${taskBlock}
Project Environment:
- Workspace: ${wsName}
- OS: ${osName}
- Shell: ${shellName}
- Python: ${pyVer}
- Node: ${nodeVer}

Please provide complete implementation files and any required terminal commands.
To allow our VS Code extension to automatically apply your files and commands directly into the project workspace, please format your response according to the following protocol:

[OUTPUT PROTOCOL: FOLLOW EXACTLY]
LIMITS PER REPLY:
- At most ${profile.maxFilesPerStep} file(s) or edit blocks.
- At most ${profile.maxCommandsPerStep} terminal commands.
- At most ${profile.maxLinesPerFile} lines per file.
If an operation requires more, output ONLY the first step now.

REQUIRED FORMAT:
TYPE: FIX
STEP: <step_number> - <title>
MANIFEST: <count>
- path/to/file1
===FILE: path/to/file1===
<complete file content without placeholders>
===END FILE===
===EDIT: path/to/file2===
<<<<<<< SEARCH
<exact existing lines to replace>
=======
<replacement lines>
>>>>>>> REPLACE
===END EDIT===
===COMMANDS===
<single command per line>
===END COMMANDS===
===VERIFY===
<command to verify this step>
===END VERIFY===
NEXT_PLANNED: <title of next step>
===END OF RESPONSE===

CRITICAL RULES:
1. Complete files only. NEVER output lazy placeholders like "...rest unchanged" or "// ... existing code ...".
2. No conversational chatter between or outside blocks. Output raw protocol.
3. For existing files, prefer ===EDIT: path=== with SEARCH/REPLACE blocks.
4. Always end your reply with ===END OF RESPONSE===.
5. On Windows PowerShell, NEVER use '&&' to chain commands. Put each command on a separate line.`;
}
