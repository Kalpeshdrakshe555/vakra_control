import * as fs from 'fs';
import * as path from 'path';

export interface PlanState {
    isActive: boolean;
    totalSteps: number;
    planContent: string;
}

export class TaskPlanner {
    public static isComplexRequest(prompt: string): boolean {
        const lower = prompt.toLowerCase();
        if (lower.length > 300) return true;
        
        const complexKeywords = [
            'build a', 'create a', 'full stack', 'full-stack', 
            'new project', 'start from scratch', 'make an app',
            'dashboard', 'ecommerce', 'e-commerce', 'clone',
            'step-by-step', 'step by step', 'architect'
        ];
        
        let matches = 0;
        for (const kw of complexKeywords) {
            if (lower.includes(kw)) matches++;
        }
        
        return matches >= 1; // If it contains at least one complex keyword
    }

    public static getPlanPath(workspaceRoot: string): string {
        const dir = path.join(workspaceRoot, '.ultra-light-ai');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, 'PLAN.md');
    }

    public static readPlan(workspaceRoot: string): PlanState {
        const planPath = this.getPlanPath(workspaceRoot);
        if (!fs.existsSync(planPath)) {
            return { isActive: false, totalSteps: 0, planContent: '' };
        }

        const content = fs.readFileSync(planPath, 'utf8').trim();
        if (content.length === 0) {
            return { isActive: false, totalSteps: 0, planContent: '' };
        }

        // Count lines with "- [ ]" or "1.", "2."
        const listItems = content.match(/^(?:- \[[ x]\]|\d+\.)/gm);
        const totalSteps = listItems ? listItems.length : 0;

        return {
            isActive: totalSteps > 0,
            totalSteps,
            planContent: content
        };
    }
    
    public static clearPlan(workspaceRoot: string): void {
        const planPath = this.getPlanPath(workspaceRoot);
        if (fs.existsSync(planPath)) {
            fs.unlinkSync(planPath);
        }
    }
}
