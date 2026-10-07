import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CustomSkill {
    name: string;
    description: string;
    triggerRules: string[];
    instructions: string;
    filePath?: string;
}

export class SkillsManager {
    public static getSkillsDirs(workspaceRoot: string): string[] {
        const candidateDirs: string[] = [];
        if (workspaceRoot) {
            candidateDirs.push(
                path.join(workspaceRoot, '.ultra-light-ai', 'skills'),
                path.join(workspaceRoot, 'skills'),
                path.join(workspaceRoot, '.skills'),
                path.join(workspaceRoot, '.agents', 'skills'),
                path.join(workspaceRoot, '.agent', 'skills')
            );
        }

        try {
            const home = os.homedir();
            candidateDirs.push(
                path.join(home, '.ultra-light-ai', 'skills'),
                path.join(home, '.agents', 'skills'),
                path.join(home, '.agent', 'skills')
            );
        } catch {}

        const uniqueDirs = Array.from(new Set(candidateDirs));
        return uniqueDirs.filter(d => fs.existsSync(d));
    }

    public static readonly BUILTIN_SKILLS: CustomSkill[] = [
        {
            name: 'django',
            description: 'Production-grade Django project architecture, conventions, and verification steps',
            triggerRules: ['django', 'manage.py', 'django-admin', 'drf', 'django rest framework', 'python backend', 'startapp', 'models.py', 'urls.py', 'views.py'],
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
        const skillDocCandidates = ['SKILL.md', 'skill.md', 'Skill.md', 'instructions.md', 'prompt.md', 'README.md'];

        for (const dir of dirs) {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        for (const candidate of skillDocCandidates) {
                            const skillFile = path.join(dir, entry.name, candidate);
                            if (fs.existsSync(skillFile)) {
                                const content = fs.readFileSync(skillFile, 'utf8');
                                const skill = this.parseSkillMarkdown(entry.name, content);
                                if (skill) {
                                    skill.filePath = skillFile;
                                    skillsMap.set(skill.name.toLowerCase(), skill); // User custom skill overrides built-in
                                    break;
                                }
                            }
                        }
                    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                        // Direct markdown skill file like skills/django.md
                        const skillName = path.basename(entry.name, path.extname(entry.name));
                        const skillPath = path.join(dir, entry.name);
                        const content = fs.readFileSync(skillPath, 'utf8');
                        const skill = this.parseSkillMarkdown(skillName, content);
                        if (skill) {
                            skill.filePath = skillPath;
                            skillsMap.set(skill.name.toLowerCase(), skill);
                        }
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
        const cleanName = name.trim().replace(/^['"]+|['"]+$/g, '');
        const safeSlug = cleanName.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
        const targetDir = path.join(workspaceRoot, '.ultra-light-ai', 'skills', safeSlug);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const filePath = path.join(targetDir, 'SKILL.md');
        const formattedRules = triggerRules.map(r => `"${r.toLowerCase().replace(/^['"]+|['"]+$/g, '')}"`).join(', ');
        const content = `---\nname: "${cleanName}"\ndescription: "${description.trim().replace(/^['"]+|['"]+$/g, '')}"\ntrigger_rules: [${formattedRules}]\n---\n\n${instructions.trim()}\n`;

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

    private static parseSkillMarkdown(folderName: string, rawContent: string): CustomSkill | null {
        // Strip BOM and normalize
        let content = rawContent.replace(/^\uFEFF/, '').trimStart();
        let name = folderName.replace(/^['"]+|['"]+$/g, '');
        let description = '';
        let triggerRules: string[] = [];
        let instructions = content;

        // Auto-extract trigger words from folder/file name (e.g. django-fullstack -> ['django', 'fullstack', 'django-fullstack', 'django fullstack'])
        const cleanedFolder = folderName.toLowerCase().replace(/^['"]+|['"]+$/g, '');
        triggerRules.push(cleanedFolder);
        const nameTokens = cleanedFolder.split(/[-_.\s]+/).filter(t => t.length > 1);
        nameTokens.forEach(t => {
            if (!triggerRules.includes(t)) triggerRules.push(t);
        });
        if (nameTokens.length > 1) {
            const spaceJoined = nameTokens.join(' ');
            if (!triggerRules.includes(spaceJoined)) triggerRules.push(spaceJoined);
        }

        // Parse YAML frontmatter if present
        const frontmatterMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
        if (frontmatterMatch) {
            const yamlStr = frontmatterMatch[1];
            instructions = frontmatterMatch[2].trim();

            const nameMatch = yamlStr.match(/name:\s*(.+)/i);
            if (nameMatch) {
                name = nameMatch[1].trim().replace(/^['"]+|['"]+$/g, '');
                const nameLower = name.toLowerCase();
                if (!triggerRules.includes(nameLower)) triggerRules.push(nameLower);
                const tokens = nameLower.split(/[-_.\s]+/).filter(t => t.length > 1);
                tokens.forEach(t => { if (!triggerRules.includes(t)) triggerRules.push(t); });
            }

            const descMatch = yamlStr.match(/description:\s*(.+)/i);
            if (descMatch) {
                description = descMatch[1].trim().replace(/^['"]+|['"]+$/g, '');
            }

            const rulesMatch = yamlStr.match(/(?:trigger_rules|triggers|trigger|rules|tags|keywords):\s*(?:\[(.*?)\]|([\s\S]*?)(?=\n[a-zA-Z0-9_-]+:|$))/i);
            if (rulesMatch) {
                if (rulesMatch[1] !== undefined) {
                    const parsed = rulesMatch[1].split(',').map(r => r.trim().replace(/^['"]+|['"]+$/g, '').toLowerCase()).filter(Boolean);
                    parsed.forEach(p => { if (!triggerRules.includes(p)) triggerRules.push(p); });
                } else if (rulesMatch[2] !== undefined) {
                    const lines = rulesMatch[2].split(/\r?\n/).map(l => l.replace(/^\s*-\s*/, '').trim().replace(/^['"]+|['"]+$/g, '').toLowerCase()).filter(Boolean);
                    lines.forEach(l => { if (!triggerRules.includes(l)) triggerRules.push(l); });
                }
            }
        }

        return { name, description, triggerRules, instructions };
    }

    public static getAvailableSkillsSummary(workspaceRoot: string): string {
        const skills = this.loadSkills(workspaceRoot);
        if (skills.length === 0) return '';

        return `[WORKSPACE SKILLS CATALOG]\n` +
            `The workspace has the following specialized skills available in the skills directory:\n` +
            skills.map(s => `- **${s.name}**: ${s.description || 'Specialized workflow and domain rules'} (Triggers: ${s.triggerRules.slice(0, 8).join(', ')})`).join('\n') +
            `\nWhen executing tasks in these domains or when requested by the user, you MUST adopt and strictly follow these skills.\n`;
    }

    public static getMatchingSkills(prompt: string, workspaceRoot: string): CustomSkill[] {
        const skills = this.loadSkills(workspaceRoot);
        if (skills.length === 0) return [];

        const lowerPrompt = prompt.toLowerCase();
        const matchedSkills: CustomSkill[] = [];

        // Check if user specifically asks to follow skills / skill folder / @skill
        const isGenericSkillRequest = 
            /\b(skill|skills|skills folder|custom skill|active skill|follow skill)\b/i.test(prompt) ||
            /\b(skill.*follow|skill.*use|use.*skill|follow.*skill|skills.*use|use.*skills|skills.*follow|follow.*skills)\b/i.test(lowerPrompt) ||
            /skills\s+folder\s+me/i.test(lowerPrompt) ||
            /skill\s+use\s+(karo|kar|kr)/i.test(lowerPrompt);

        for (const skill of skills) {
            const skillNameLower = skill.name.toLowerCase();
            const isCustom = !!skill.filePath;

            // Built-in skills shouldn't match on generic "use skills" if workspace has skills
            const triggerOnGeneric = isCustom && isGenericSkillRequest;

            const isMatch = 
                triggerOnGeneric ||
                skill.triggerRules.some(rule => rule && lowerPrompt.includes(rule.toLowerCase())) ||
                lowerPrompt.includes(skillNameLower) ||
                lowerPrompt.includes(`@${skillNameLower}`) ||
                lowerPrompt.includes(`@skill:${skillNameLower}`) ||
                lowerPrompt.includes(`@skill ${skillNameLower}`) ||
                (skill.description && skill.description.toLowerCase().split(/\s+/).some(w => w.length > 4 && lowerPrompt.includes(w)));

            if (isMatch && !matchedSkills.some(s => s.name.toLowerCase() === skill.name.toLowerCase())) {
                matchedSkills.push(skill);
            }
        }

        // Conflict Resolution: If ANY custom workspace skill matches, completely SUPPRESS built-in skills
        // so the model NEVER gets confused by conflicting rules or dual instructions!
        const hasCustomMatch = matchedSkills.some(s => !!s.filePath);
        if (hasCustomMatch) {
            return matchedSkills.filter(s => !!s.filePath);
        }

        return matchedSkills;
    }

    public static getMatchingSkillInstructions(prompt: string, workspaceRoot: string): string {
        const matchedSkills = this.getMatchingSkills(prompt, workspaceRoot);
        if (matchedSkills.length === 0) return '';

        return `\n\n================================================================================\n` +
            `🚨 MANDATORY ACTIVE WORKSPACE SKILL PROTOCOL (PRIORITY 0 - ABSOLUTE ENFORCEMENT) 🚨\n` +
            `================================================================================\n` +
            `You MUST STRICTLY ADHERE to the active skill instructions, step-by-step checklists, rules, and prohibitions below.\n` +
            `DO NOT deviate from these steps. Execute them in strict sequence.\n` +
            `Every action MUST comply with the rules and constraints defined in the skill:\n\n` +
            matchedSkills.map(s => `--- [ACTIVE SKILL: ${s.name}] ---\nDescription: ${s.description}\n\n${s.instructions}`).join('\n\n================================================================================\n\n') +
            `\n================================================================================\n`;
    }
}
