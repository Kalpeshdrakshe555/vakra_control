import * as fs from 'fs';
import * as path from 'path';

export interface CustomSkill {
    name: string;
    description: string;
    triggerRules: string[];
    instructions: string;
}

export class SkillsManager {
    private static skillsDir(workspaceRoot: string): string {
        return path.join(workspaceRoot, '.ultra-light-ai', 'skills');
    }

    public static loadSkills(workspaceRoot: string): CustomSkill[] {
        const skills: CustomSkill[] = [];
        const dir = this.skillsDir(workspaceRoot);
        if (!fs.existsSync(dir)) return skills;

        try {
            const skillFolders = fs.readdirSync(dir);
            for (const folder of skillFolders) {
                const skillFile = path.join(dir, folder, 'SKILL.md');
                if (fs.existsSync(skillFile)) {
                    const content = fs.readFileSync(skillFile, 'utf8');
                    const skill = this.parseSkillMarkdown(folder, content);
                    if (skill) skills.push(skill);
                }
            }
        } catch (e) {
            console.error('Failed to load skills:', e);
        }

        return skills;
    }

    private static parseSkillMarkdown(folderName: string, content: string): CustomSkill | null {
        // Parse YAML frontmatter if present
        const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        let name = folderName;
        let description = '';
        let triggerRules: string[] = [];
        let instructions = content;

        if (frontmatterMatch) {
            const yamlStr = frontmatterMatch[1];
            instructions = frontmatterMatch[2].trim();

            const nameMatch = yamlStr.match(/name:\s*(.+)/i);
            if (nameMatch) name = nameMatch[1].trim();

            const descMatch = yamlStr.match(/description:\s*(.+)/i);
            if (descMatch) description = descMatch[1].trim();

            const rulesMatch = yamlStr.match(/trigger_rules:\s*\[(.*?)\]/i);
            if (rulesMatch) {
                triggerRules = rulesMatch[1].split(',').map(r => r.trim().replace(/^['"]|['"]$/g, ''));
            }
        }

        return { name, description, triggerRules, instructions };
    }

    public static getMatchingSkillInstructions(prompt: string, workspaceRoot: string): string {
        const skills = this.loadSkills(workspaceRoot);
        if (skills.length === 0) return '';

        const lowerPrompt = prompt.toLowerCase();
        const matchedSkills: CustomSkill[] = [];

        for (const skill of skills) {
            const isMatch = skill.triggerRules.some(rule => lowerPrompt.includes(rule.toLowerCase())) ||
                            lowerPrompt.includes(`@skill:${skill.name.toLowerCase()}`) ||
                            lowerPrompt.includes(`@skill ${skill.name.toLowerCase()}`);
            if (isMatch) {
                matchedSkills.push(skill);
            }
        }

        if (matchedSkills.length === 0) return '';

        return `\n\n### ACTIVE CUSTOM SKILLS INSTRUCTIONS ###\n` +
            matchedSkills.map(s => `--- Skill: ${s.name} ---\n${s.instructions}`).join('\n\n') +
            `\n### END CUSTOM SKILLS ###\n`;
    }
}
