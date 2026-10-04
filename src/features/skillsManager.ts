import * as fs from 'fs';
import * as path from 'path';

export interface CustomSkill {
    name: string;
    description: string;
    triggerRules: string[];
    instructions: string;
}

export class SkillsManager {
    private static getSkillsDirs(workspaceRoot: string): string[] {
        if (!workspaceRoot) return [];
        return [
            path.join(workspaceRoot, '.ultra-light-ai', 'skills'),
            path.join(workspaceRoot, '.agent', 'skills'),
            path.join(workspaceRoot, '.skills'),
            path.join(workspaceRoot, 'skills')
        ].filter(d => fs.existsSync(d));
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

        const dirs = this.getSkillsDirs(workspaceRoot);
        for (const dir of dirs) {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const skillFile = path.join(dir, entry.name, 'SKILL.md');
                        if (fs.existsSync(skillFile)) {
                            const content = fs.readFileSync(skillFile, 'utf8');
                            const skill = this.parseSkillMarkdown(entry.name, content);
                            if (skill) {
                                skillsMap.set(skill.name.toLowerCase(), skill); // User custom skill overrides built-in
                            }
                        }
                    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                        // Direct markdown skill file like skills/django.md
                        const skillName = path.basename(entry.name, path.extname(entry.name));
                        const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
                        const skill = this.parseSkillMarkdown(skillName, content);
                        if (skill) skillsMap.set(skill.name.toLowerCase(), skill);
                    }
                }
            } catch (e) {
                console.error('Failed to load skills from ' + dir, e);
            }
        }

        return Array.from(skillsMap.values());
    }

    public static saveCustomSkill(
        workspaceRoot: string,
        name: string,
        description: string,
        triggerRules: string[],
        instructions: string
    ): string {
        const safeSlug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
        const targetDir = path.join(workspaceRoot, '.ultra-light-ai', 'skills', safeSlug);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const filePath = path.join(targetDir, 'SKILL.md');
        const formattedRules = triggerRules.map(r => `"${r.toLowerCase()}"`).join(', ');
        const content = `---\nname: "${name}"\ndescription: "${description}"\ntrigger_rules: [${formattedRules}]\n---\n\n${instructions.trim()}\n`;

        fs.writeFileSync(filePath, content, 'utf8');
        return filePath;
    }

    public static scaffoldSkill(workspaceRoot: string, skillName: string): string | null {
        const builtin = this.BUILTIN_SKILLS.find(s => s.name.toLowerCase() === skillName.toLowerCase());
        if (!builtin) return null;
        const targetDir = path.join(workspaceRoot, '.ultra-light-ai', 'skills', builtin.name);
        fs.mkdirSync(targetDir, { recursive: true });
        const filePath = path.join(targetDir, 'SKILL.md');
        const content = `---\nname: ${builtin.name}\ndescription: ${builtin.description}\ntrigger_rules: [${builtin.triggerRules.map(r => `"${r}"`).join(', ')}]\n---\n\n${builtin.instructions}\n`;
        fs.writeFileSync(filePath, content, 'utf8');
        return filePath;
    }

    private static parseSkillMarkdown(folderName: string, content: string): CustomSkill | null {
        let name = folderName;
        let description = '';
        let triggerRules: string[] = [];
        let instructions = content;

        // Auto-extract trigger words from folder/file name (e.g. django-fullstack -> ['django', 'fullstack', 'django-fullstack'])
        const nameTokens = folderName.toLowerCase().split(/[-_.\s]+/).filter(t => t.length > 2);
        triggerRules.push(folderName.toLowerCase());
        nameTokens.forEach(t => {
            if (!triggerRules.includes(t)) triggerRules.push(t);
        });

        // Parse YAML frontmatter if present
        const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        if (frontmatterMatch) {
            const yamlStr = frontmatterMatch[1];
            instructions = frontmatterMatch[2].trim();

            const nameMatch = yamlStr.match(/name:\s*(.+)/i);
            if (nameMatch) {
                name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
                if (!triggerRules.includes(name.toLowerCase())) triggerRules.push(name.toLowerCase());
            }

            const descMatch = yamlStr.match(/description:\s*(.+)/i);
            if (descMatch) description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

            const rulesMatch = yamlStr.match(/(?:trigger_rules|triggers|tags):\s*(?:\[(.*?)\]|([\s\S]*?)(?=\n[a-zA-Z0-9_-]+:|$))/i);
            if (rulesMatch) {
                if (rulesMatch[1] !== undefined) {
                    const parsed = rulesMatch[1].split(',').map(r => r.trim().replace(/^['"]|['"]$/g, '').toLowerCase()).filter(Boolean);
                    parsed.forEach(p => { if (!triggerRules.includes(p)) triggerRules.push(p); });
                } else if (rulesMatch[2] !== undefined) {
                    const lines = rulesMatch[2].split(/\r?\n/).map(l => l.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, '').toLowerCase()).filter(Boolean);
                    lines.forEach(l => { if (!triggerRules.includes(l)) triggerRules.push(l); });
                }
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
            const skillNameLower = skill.name.toLowerCase();
            const isMatch = 
                skill.triggerRules.some(rule => rule && lowerPrompt.includes(rule.toLowerCase())) ||
                lowerPrompt.includes(skillNameLower) ||
                lowerPrompt.includes(`@skill:${skillNameLower}`) ||
                lowerPrompt.includes(`@skill ${skillNameLower}`) ||
                (skill.description && skill.description.toLowerCase().split(/\s+/).some(w => w.length > 4 && lowerPrompt.includes(w)));

            if (isMatch && !matchedSkills.some(s => s.name === skill.name)) {
                matchedSkills.push(skill);
            }
        }

        if (matchedSkills.length === 0) return '';

        return `\n\n### ACTIVE WORKSPACE SKILLS INSTRUCTIONS ###\n` +
            matchedSkills.map(s => `--- Skill: ${s.name} ---\n${s.instructions}`).join('\n\n') +
            `\n### END WORKSPACE SKILLS ###\n`;
    }
}
