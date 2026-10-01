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

    public static readonly BUILTIN_SKILLS: CustomSkill[] = [
        {
            name: 'django',
            description: 'Production-grade Django project architecture, conventions, and verification steps',
            triggerRules: ['django', 'manage.py', 'django-admin', 'drf', 'django rest framework', 'python backend'],
            instructions: `## Django Project Protocol & Conventions:
1. SCATTERED NAMING RULE:
   - The root project folder and the Django app folder MUST have DIFFERENT names.
   - Example: Project folder "core" or "backend", App folder "shop" or "users". Never name both the same.
2. APP REGISTRATION:
   - When you create an app, immediately add it to INSTALLED_APPS in settings.py.
3. DUAL-TIER URL ROUTING:
   - Main urls.py must include the app's urls: path('', include('app_name.urls')).
   - The app must have its own urls.py with app_name and urlpatterns.
4. MIGRATIONS & DB:
   - Model changes always require: "python manage.py makemigrations" followed by "python manage.py migrate".
5. VERIFICATION:
   - Always run "python manage.py check" (or "python <subfolder>/manage.py check" if in a subdirectory) to verify settings, models, and routes.
   - NEVER run interactive "python manage.py shell".
6. RESEARCH ON FAILURE:
   - If a Django import or configuration fails, use research_web_docs with the specific error before guessing fixes.`
        }
    ];

    public static loadSkills(workspaceRoot: string): CustomSkill[] {
        const skillsMap = new Map<string, CustomSkill>();

        // Load built-in skills first
        for (const skill of this.BUILTIN_SKILLS) {
            skillsMap.set(skill.name.toLowerCase(), skill);
        }

        const dir = this.skillsDir(workspaceRoot);
        if (workspaceRoot && fs.existsSync(dir)) {
            try {
                const skillFolders = fs.readdirSync(dir);
                for (const folder of skillFolders) {
                    const skillFile = path.join(dir, folder, 'SKILL.md');
                    if (fs.existsSync(skillFile)) {
                        const content = fs.readFileSync(skillFile, 'utf8');
                        const skill = this.parseSkillMarkdown(folder, content);
                        if (skill) skillsMap.set(skill.name.toLowerCase(), skill); // User skill overrides built-in
                    }
                }
            } catch (e) {
                console.error('Failed to load skills:', e);
            }
        }

        return Array.from(skillsMap.values());
    }

    public static scaffoldSkill(workspaceRoot: string, skillName: string): string | null {
        const builtin = this.BUILTIN_SKILLS.find(s => s.name.toLowerCase() === skillName.toLowerCase());
        if (!builtin) return null;
        const targetDir = path.join(this.skillsDir(workspaceRoot), builtin.name);
        fs.mkdirSync(targetDir, { recursive: true });
        const filePath = path.join(targetDir, 'SKILL.md');
        const content = `---\nname: ${builtin.name}\ndescription: ${builtin.description}\ntrigger_rules: [${builtin.triggerRules.map(r => `"${r}"`).join(', ')}]\n---\n\n${builtin.instructions}\n`;
        fs.writeFileSync(filePath, content, 'utf8');
        return filePath;
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
