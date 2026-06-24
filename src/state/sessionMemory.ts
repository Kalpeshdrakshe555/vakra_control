import * as fs from 'fs';
import * as path from 'path';

export interface SessionMemoryData {
    createdAt: number;
    updatedAt: number;
    projectStack: string;
    framework: string;
    currentStep?: number;
    totalSteps?: number;
    lastTask: string;
    keyDecisions: string[];
    createdFiles: { filepath: string; purpose: string; lines: number }[];
}

const MAX_FILES = 30;
const MAX_DECISIONS = 15;

export class SessionMemory {
    private static getPath(workspaceRoot: string): string {
        const dir = path.join(workspaceRoot, '.ultra-light-ai');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, 'SESSION_MEMORY.json');
    }

    public static get(workspaceRoot: string): SessionMemoryData | null {
        const p = this.getPath(workspaceRoot);
        if (!fs.existsSync(p)) return null;
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch { return null; }
    }

    public static init(workspaceRoot: string, stack: string, framework: string): SessionMemoryData {
        const mem: SessionMemoryData = {
            createdAt: Date.now(),
            updatedAt: Date.now(),
            projectStack: stack,
            framework,
            lastTask: 'Project initialized',
            keyDecisions: [],
            createdFiles: []
        };
        this.save(workspaceRoot, mem);
        return mem;
    }

    public static recordFileApplied(workspaceRoot: string, filepath: string, content: string) {
        const mem = this.get(workspaceRoot) || this.init(workspaceRoot, 'Unknown', 'None');
        const lineCount = content.split('\n').length;

        // Derive purpose from filename heuristics
        const base = path.basename(filepath);
        let purpose = 'general';
        if (base.includes('model'))   purpose = 'data model / schema';
        else if (base.includes('view') || base.includes('route') || base.includes('controller')) purpose = 'API / route handler';
        else if (base.includes('template') || base.includes('.html')) purpose = 'UI template';
        else if (base.includes('test') || base.includes('spec')) purpose = 'test suite';
        else if (base.includes('config') || base.includes('setting')) purpose = 'configuration';
        else if (base.includes('url') || base.includes('router')) purpose = 'URL routing';
        else if (base.includes('middleware') || base.includes('guard')) purpose = 'middleware / guard';
        else if (base.includes('util') || base.includes('helper')) purpose = 'utilities / helpers';

        // Update or add
        const existing = mem.createdFiles.findIndex(f => f.filepath === filepath);
        if (existing >= 0) {
            mem.createdFiles[existing] = { filepath, purpose, lines: lineCount };
        } else {
            mem.createdFiles.push({ filepath, purpose, lines: lineCount });
        }

        // Keep list bounded
        if (mem.createdFiles.length > MAX_FILES) {
            mem.createdFiles = mem.createdFiles.slice(-MAX_FILES);
        }

        mem.updatedAt = Date.now();
        this.save(workspaceRoot, mem);
    }

    public static recordDecision(workspaceRoot: string, decision: string) {
        const mem = this.get(workspaceRoot) || this.init(workspaceRoot, 'Unknown', 'None');
        if (!mem.keyDecisions.includes(decision)) {
            mem.keyDecisions.push(decision);
            if (mem.keyDecisions.length > MAX_DECISIONS) {
                mem.keyDecisions = mem.keyDecisions.slice(-MAX_DECISIONS);
            }
        }
        mem.updatedAt = Date.now();
        this.save(workspaceRoot, mem);
    }

    public static updateStep(workspaceRoot: string, step: number, total: number, taskDesc: string) {
        const mem = this.get(workspaceRoot) || this.init(workspaceRoot, 'Unknown', 'None');
        mem.currentStep = step;
        mem.totalSteps = total;
        mem.lastTask = taskDesc;
        mem.updatedAt = Date.now();
        this.save(workspaceRoot, mem);
    }

    /**
     * Returns a compact ≤1KB context string to inject into every prompt.
     * Replaces 10 turns of history with precise project state.
     */
    public static buildContextHeader(workspaceRoot: string): string {
        const mem = this.get(workspaceRoot);
        if (!mem) return '';

        const filesSummary = mem.createdFiles
            .map(f => `  - ${f.filepath} (${f.purpose}, ${f.lines} lines)`)
            .join('\n');

        const decisionsSummary = mem.keyDecisions.length > 0
            ? mem.keyDecisions.map(d => `  - ${d}`).join('\n')
            : '  None recorded yet.';

        const stepInfo = mem.currentStep && mem.totalSteps
            ? `Current Step: ${mem.currentStep}/${mem.totalSteps} — ${mem.lastTask}`
            : `Last task: ${mem.lastTask}`;

        return `\n### SESSION MEMORY (Do not forget this context) ###
Stack: ${mem.projectStack} | Framework: ${mem.framework}
${stepInfo}

Files created so far (${mem.createdFiles.length}):
${filesSummary || '  None yet.'}

Key decisions already made:
${decisionsSummary}
### END SESSION MEMORY ###\n`;
    }

    private static save(workspaceRoot: string, mem: SessionMemoryData) {
        try {
            fs.writeFileSync(this.getPath(workspaceRoot), JSON.stringify(mem, null, 2), 'utf8');
        } catch (e) { console.error('[SessionMemory] Failed to save', e); }
    }
}
