import * as fs from 'fs';
import * as path from 'path';

export interface StructureRule {
    glob: string;
    mustBeUnder?: string[];
    exclude?: string[];
    message?: string;
}

export interface ProjectRulesConfig {
    structure?: StructureRule[];
    forbidFolders?: string[];
    forbidFoldersInsideApps?: boolean;
}

/**
 * Minimal wildcard / glob matcher supporting '*', '?', and '**'.
 */
export function simpleGlobMatch(pattern: string, targetPath: string): boolean {
    const normPattern = pattern.replace(/\\/g, '/');
    const normPath = targetPath.replace(/\\/g, '/');

    // Convert glob pattern to regular expression
    const escaped = normPattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '.*')
        .replace(/(?<!\.)\*/g, '[^/]*')
        .replace(/\?/g, '.');

    const regex = new RegExp(`^${escaped}$`, 'i');
    return regex.test(normPath);
}

/**
 * Validates a target file path against workspace project rules (if present in .ultra-light-ai/project_rules.json).
 */
export function validateProjectRules(
    relPath: string,
    workspaceRoot: string
): { ok: boolean; message?: string } {
    const rulesPath = path.join(workspaceRoot, '.ultra-light-ai', 'project_rules.json');
    if (!fs.existsSync(rulesPath)) {
        return { ok: true };
    }

    try {
        const raw = fs.readFileSync(rulesPath, 'utf8');
        const config: ProjectRulesConfig = JSON.parse(raw);
        const normRel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');

        if (config.structure) {
            for (const rule of config.structure) {
                if (rule.exclude?.some(ex => simpleGlobMatch(ex, normRel))) {
                    continue;
                }

                if (simpleGlobMatch(rule.glob, normRel)) {
                    if (rule.mustBeUnder && rule.mustBeUnder.length > 0) {
                        const matched = rule.mustBeUnder.some(prefix => normRel.startsWith(prefix.replace(/\\/g, '/')));
                        if (!matched) {
                            return {
                                ok: false,
                                message: rule.message || `File '${normRel}' must be located under: ${rule.mustBeUnder.join(', ')}`
                            };
                        }
                    }
                }
            }
        }
    } catch {
        // Bad rules file: allow gracefully
    }

    return { ok: true };
}
