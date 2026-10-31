import * as fs from 'fs';
import * as path from 'path';
import { SessionMemory } from './sessionMemory';

export interface LedgerStepInfo {
    id: number;
    title: string;
    status: 'pending' | 'active' | 'done' | 'skipped';
    summary?: string;
}

export class StateLedger {
    private static getLedgerPath(workspaceRoot: string): string {
        const aiDir = path.join(workspaceRoot, '.ultra-light-ai');
        if (!fs.existsSync(aiDir)) {
            try { fs.mkdirSync(aiDir, { recursive: true }); } catch {}
        }
        return path.join(aiDir, 'STATE_LEDGER.md');
    }

    /**
     * Synchronizes and writes the Project State Ledger to disk (.ultra-light-ai/STATE_LEDGER.md).
     * This acts as the centralized project memory ledger so models don't need to retain
     * massive raw file dumps across multi-step tasks.
     */
    public static sync(
        workspaceRoot: string,
        options: {
            goal?: string;
            steps?: LedgerStepInfo[];
            activeStepId?: number;
            latestActionSummary?: string;
            keyDecisions?: string[];
        }
    ): string {
        if (!workspaceRoot) return '';
        const ledgerPath = this.getLedgerPath(workspaceRoot);
        const mem = SessionMemory.getInstance(workspaceRoot);
        const touchedPaths = mem.getTouchedPaths();

        const timestampStr = new Date().toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });

        let md = `# 📌 Project State Ledger\n`;
        md += `*Autonomous Progress & Architecture Ledger (Synchronized ${timestampStr})*\n\n`;

        // 1. Goal & Execution Roadmap
        md += `## 🎯 Goal & Milestone Roadmap\n`;
        if (options.goal) {
            md += `**Objective**: ${options.goal}\n\n`;
        }

        if (options.steps && options.steps.length > 0) {
            md += `### Steps Checklist:\n`;
            options.steps.forEach(s => {
                const icon = s.status === 'done' ? '[x]' : s.status === 'active' ? '[>]' : '[ ]';
                const tag = s.status === 'active' ? ' (👈 CURRENT ACTIVE STEP)' : '';
                md += `- ${icon} **Step ${s.id}**: ${s.title}${tag}\n`;
                if (s.summary && s.status === 'done') {
                    md += `  * *Result*: ${s.summary}\n`;
                }
            });
            md += `\n`;
        }

        // 2. Touched Files & Key Logic
        md += `## 📁 Active Working Files & Architecture State\n`;
        if (touchedPaths.length === 0) {
            md += `*(No files modified yet)*\n\n`;
        } else {
            touchedPaths.forEach(relPath => {
                const fState = mem.getFile(relPath);
                md += `### \`${relPath}\` (${fState?.status || 'modified'})\n`;
                if (fState?.symbols && fState.symbols.length > 0) {
                    md += `- **Exports/Symbols**: \`${fState.symbols.join('`, `')}\`\n`;
                }
                if (fState?.routesOrKeys && fState.routesOrKeys.length > 0) {
                    md += `- **Routes/Keys**: \`${fState.routesOrKeys.join('`, `')}\`\n`;
                }
                if (fState?.liveSnippet) {
                    md += `\`\`\`${path.extname(relPath).replace('.', '') || 'text'}\n${fState.liveSnippet}\n\`\`\`\n`;
                }
                md += `\n`;
            });
        }

        // 3. Key Decisions & Invariants
        const completedTasks = mem.getCompletedSubTasks();
        if (completedTasks.length > 0 || (options.keyDecisions && options.keyDecisions.length > 0)) {
            md += `## 🧠 Verified Decisions & Completed Milestones\n`;
            completedTasks.forEach(task => {
                md += `- ✔ ${task}\n`;
            });
            if (options.keyDecisions) {
                options.keyDecisions.forEach(dec => {
                    md += `- • ${dec}\n`;
                });
            }
            md += `\n`;
        }

        if (options.latestActionSummary) {
            md += `\n> **Latest Update**: ${options.latestActionSummary}\n`;
        }

        try {
            fs.writeFileSync(ledgerPath, md, 'utf8');
        } catch (e) {
            console.error('[StateLedger] Failed to write STATE_LEDGER.md:', e);
        }

        return md;
    }

    /**
     * Reads the current STATE_LEDGER.md content, or generates an empty template if not yet created.
     */
    public static read(workspaceRoot: string): string {
        if (!workspaceRoot) return '';
        const ledgerPath = this.getLedgerPath(workspaceRoot);
        if (fs.existsSync(ledgerPath)) {
            try {
                return fs.readFileSync(ledgerPath, 'utf8');
            } catch {}
        }
        return this.sync(workspaceRoot, {});
    }

    /**
     * Clears and resets the STATE_LEDGER.md on disk when a new chat starts.
     */
    public static clear(workspaceRoot: string): void {
        if (!workspaceRoot) return;
        const ledgerPath = this.getLedgerPath(workspaceRoot);
        if (fs.existsSync(ledgerPath)) {
            try { fs.unlinkSync(ledgerPath); } catch {}
        }
    }

    /**
     * Returns a compact token-efficient snapshot of the ledger for prompt injection.
     */
    public static getCompactPromptSlice(workspaceRoot: string, maxChars: number = 2500): string {
        const full = this.read(workspaceRoot);
        if (!full) return '';
        if (full.length <= maxChars) return full;
        return full.slice(0, maxChars) + '\n... [Remaining ledger truncated. Call read_state_ledger for full details]';
    }
}
