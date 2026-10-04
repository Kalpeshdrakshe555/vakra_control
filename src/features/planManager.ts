import * as fs from 'fs';
import * as path from 'path';

export class PlanManager {
    public static getPlanPath(workspaceRoot: string): string {
        return path.join(workspaceRoot, '.ultra-light-ai', 'PLAN.md');
    }

    public static setPlan(workspaceRoot: string, planTitle: string, steps: string[]): string {
        const planPath = this.getPlanPath(workspaceRoot);
        const dir = path.dirname(planPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        let md = `# Active Execution Plan: ${planTitle}\n`;
        md += `Updated: ${new Date().toISOString()}\n\n`;
        steps.forEach((step, idx) => {
            md += `- [ ] Step ${idx + 1}: ${step}\n`;
        });

        fs.writeFileSync(planPath, md, 'utf8');
        return planPath;
    }

    public static markNextStepComplete(workspaceRoot: string, note?: string): boolean {
        const planPath = this.getPlanPath(workspaceRoot);
        if (!fs.existsSync(planPath)) return false;

        try {
            const content = fs.readFileSync(planPath, 'utf8');
            const lines = content.split('\n');
            let modified = false;

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('- [ ]')) {
                    lines[i] = lines[i].replace('- [ ]', '- [x]');
                    if (note) {
                        lines[i] += ` *(Completed: ${note})*`;
                    }
                    modified = true;
                    break;
                }
            }

            if (modified) {
                fs.writeFileSync(planPath, lines.join('\n'), 'utf8');
            }
            return modified;
        } catch {
            return false;
        }
    }

    public static getPlanContent(workspaceRoot: string): string | null {
        const planPath = this.getPlanPath(workspaceRoot);
        if (fs.existsSync(planPath)) {
            try {
                return fs.readFileSync(planPath, 'utf8');
            } catch {}
        }
        return null;
    }
}
