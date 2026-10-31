// src/agents/permissions.ts
// Strict Role-to-Tool Permission Policies.
// Enforced BOTH at schema construction and at execution dispatch.

import { AgentRoleType } from './types';

export const ROLE_ALLOWED_TOOLS: Record<AgentRoleType, readonly string[]> = {
    planner: [
        'set_task_plan',
        'expand_plan_step',
        'read_state_ledger',
        'list_directory_tree',
        'read_multiple_files',
        'read_skill',
        'execute_terminal_command',
        'search_web',
        'research_web_docs'
    ],
    researcher: [
        'read_multiple_files',
        'search_codebase',
        'list_directory_tree',
        'get_symbol_outline',
        'get_code_diagnostics',
        'search_web',
        'research_web_docs',
        'read_skill',
        'read_state_ledger',
        'execute_terminal_command'
    ],
    coder: [
        'write_file',
        'edit_file',
        'execute_terminal_command',
        'read_multiple_files',
        'search_codebase',
        'list_directory_tree',
        'read_state_ledger',
        'read_skill',
        'create_skill',
        'search_web',
        'research_web_docs',
        'get_code_diagnostics'
    ],
    verifier: [
        'execute_terminal_command',
        'get_code_diagnostics',
        'get_symbol_outline',
        'read_multiple_files',
        'read_state_ledger',
        'complete_plan_step',
        'finish'
    ]
};

export const ROLE_PROHIBITED_TOOLS: Record<AgentRoleType, readonly string[]> = {
    planner: [
        'write_file',
        'edit_file',
        'complete_plan_step',
        'finish',
        'create_skill'
    ],
    researcher: [
        'write_file',
        'edit_file',
        'set_task_plan',
        'expand_plan_step',
        'complete_plan_step',
        'finish',
        'create_skill'
    ],
    coder: [
        'set_task_plan',
        'expand_plan_step',
        'complete_plan_step',
        'finish'
    ],
    verifier: [
        'write_file',
        'edit_file',
        'set_task_plan',
        'expand_plan_step',
        'search_web',
        'research_web_docs',
        'create_skill'
    ]
};

/**
 * Checks whether a tool is permitted for the given active role.
 */
export function isToolAllowedForRole(role: AgentRoleType, toolName: string): boolean {
    if (!role || !toolName) return false;
    const clean = toolName.trim();
    const allowed = ROLE_ALLOWED_TOOLS[role] || [];
    return allowed.includes(clean);
}

/**
 * Filters standard tool declarations down to only those permitted for the role.
 */
export function filterToolsForRole(role: AgentRoleType, tools: any[]): any[] {
    if (!tools || tools.length === 0) return [];
    if (!tools[0]?.functionDeclarations) return tools;

    const allowed = new Set(ROLE_ALLOWED_TOOLS[role] || []);
    const filteredDeclarations = tools[0].functionDeclarations.filter((fn: any) => allowed.has(fn.name));

    if (filteredDeclarations.length === 0) return [];
    return [{ functionDeclarations: filteredDeclarations }];
}

/**
 * Validates a requested tool call against the role permissions and mandatory argument shapes.
 * Fails closed if the tool is prohibited or malformed.
 */
export function validateRoleToolCall(
    role: AgentRoleType,
    name: string,
    args: any
): { allowed: boolean; error?: string } {
    if (!role) {
        return { allowed: false, error: 'Permission denied: No active agent role determined.' };
    }

    const cleanName = (name || '').trim();
    if (!cleanName) {
        return { allowed: false, error: 'Malformed tool call: Missing tool name.' };
    }

    if (!isToolAllowedForRole(role, cleanName)) {
        return {
            allowed: false,
            error: `Permission denied: Tool '${cleanName}' is prohibited for agent role '${role}'.`
        };
    }

    // Role-specific argument shape checks
    if (role === 'coder') {
        if (cleanName === 'write_file') {
            if (!args || typeof args.filepath !== 'string' || typeof args.content !== 'string') {
                return { allowed: false, error: "Malformed write_file: 'filepath' and 'content' are required strings." };
            }
        } else if (cleanName === 'edit_file') {
            const oldT = args?.old_text ?? args?.oldText;
            const newT = args?.new_text ?? args?.newText;
            if (!args || typeof args.filepath !== 'string' || typeof oldT !== 'string' || typeof newT !== 'string') {
                return { allowed: false, error: "Malformed edit_file: 'filepath', 'old_text', and 'new_text' are required strings." };
            }
        }
    } else if (role === 'verifier') {
        if (cleanName === 'execute_terminal_command') {
            const cmd = args?.command ?? args?.cmd;
            if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
                return { allowed: false, error: "Malformed execute_terminal_command: 'command' string is required." };
            }
        }
    } else if (role === 'planner') {
        if (cleanName === 'set_task_plan') {
            const steps = args?.steps || args?.plan;
            if (!Array.isArray(steps) || steps.length === 0) {
                return { allowed: false, error: "Malformed set_task_plan: 'steps' must be a non-empty array." };
            }
        }
    }

    return { allowed: true };
}
