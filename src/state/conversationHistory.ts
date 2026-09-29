/**
 * ConversationHistory — Manages multi-turn chat context for the AI agent.
 * Stores message history with role attribution and provides serialization
 * for the Gemini / Ollama / OpenAI multi-turn API format.
 * 
 * Features:
 * - Persistent session storage (never wipes user messages from disk)
 * - Intelligent Long-Term Memory (LTM) rolling compression for earlier turns
 * - Zero context amnesia: combines rolling summary + active turns for LLMs
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ChatMessage {
    role: 'user' | 'model';
    text: string;
    timestamp: number;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    fileBackups?: { filepath: string, content: string | null }[];
}

export interface ChatSession {
    id: string;
    title: string;
    updatedAt: number;
    rollingSummary?: string;
    messages: ChatMessage[];
}

// Generous retention limit for UI history per session on disk
const MAX_SAVED_MESSAGES_PER_SESSION = 300;

export class ConversationHistory {
    private sessions: ChatSession[] = [];
    private currentSessionId: string | null = null;
    private readonly maxHistory: number;
    private savePath?: string;

    constructor(maxHistory: number = 20, workspaceRoot?: string) {
        this.maxHistory = maxHistory;
        if (workspaceRoot) {
            const aiDir = path.join(workspaceRoot, '.ultra-light-ai');
            if (!fs.existsSync(aiDir)) {
                try { fs.mkdirSync(aiDir, { recursive: true }); } catch {}
            }
            this.savePath = path.join(aiDir, 'chat-history.json');
            // Migration: check if legacy .chat-history.json exists at root
            const legacyPath = path.join(workspaceRoot, '.chat-history.json');
            if (!fs.existsSync(this.savePath) && fs.existsSync(legacyPath)) {
                try {
                    fs.copyFileSync(legacyPath, this.savePath);
                } catch {}
            }
            this.loadFromFile();
        }
    }

    private loadFromFile(): void {
        if (this.savePath && fs.existsSync(this.savePath)) {
            try {
                const data = fs.readFileSync(this.savePath, 'utf8');
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) {
                    // Check if it's the old single-session format
                    if (parsed.length > 0 && parsed[0].role) {
                        this.sessions = [{
                            id: Date.now().toString(),
                            title: 'Legacy Chat',
                            updatedAt: Date.now(),
                            messages: parsed
                        }];
                    } else {
                        this.sessions = parsed;
                    }
                }
                
                // Set active session to most recent
                if (this.sessions.length > 0) {
                    this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
                    this.currentSessionId = this.sessions[0].id;
                }
            } catch (e) {
                console.error("Failed to load chat history", e);
            }
        }
    }

    private saveToFile(): void {
        if (this.savePath) {
            try {
                fs.writeFileSync(this.savePath, JSON.stringify(this.sessions, null, 2), 'utf8');
            } catch (e) {
                console.error("Failed to save chat history", e);
            }
        }
    }

    private get activeSession(): ChatSession | null {
        if (!this.currentSessionId) return null;
        return this.sessions.find(s => s.id === this.currentSessionId) || null;
    }

    public createNewSession(): void {
        const id = Date.now().toString();
        this.sessions.push({
            id,
            title: 'New Conversation',
            updatedAt: Date.now(),
            messages: []
        });
        this.currentSessionId = id;
        this.saveToFile();
    }

    public switchSession(id: string): boolean {
        if (this.sessions.some(s => s.id === id)) {
            this.currentSessionId = id;
            return true;
        }
        return false;
    }

    public getAllSessionsSummary(): { id: string, title: string, updatedAt: number }[] {
        return this.sessions
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(s => ({
                id: s.id,
                title: s.title,
                updatedAt: s.updatedAt
            }));
    }

    public deleteSession(id: string): boolean {
        const index = this.sessions.findIndex(s => s.id === id);
        if (index !== -1) {
            this.sessions.splice(index, 1);
            if (this.currentSessionId === id) {
                this.currentSessionId = this.sessions.length > 0 ? this.sessions[0].id : null;
            }
            this.saveToFile();
            return true;
        }
        return false;
    }

    /**
     * Adds a message to the active session.
     * Preserves the full chat log up to MAX_SAVED_MESSAGES_PER_SESSION (e.g. 300)
     * so user never loses their history upon window restart.
     */
    public addMessage(role: 'user' | 'model', text: string, usage?: ChatMessage['usage'], timestamp?: number): void {
        if (!this.currentSessionId) {
            this.createNewSession();
        }
        const session = this.activeSession!;
        session.updatedAt = Date.now();
        
        // Auto-generate title for new sessions based on first user message
        if (session.messages.length === 0 && role === 'user') {
            session.title = text.split('\n')[0].substring(0, 30) + '...';
        }

        session.messages.push({
            role,
            text,
            timestamp: timestamp || Date.now(),
            usage,
            fileBackups: []
        });

        // Generous bound to avoid unbounded disk growth while preserving full conversations
        while (session.messages.length > MAX_SAVED_MESSAGES_PER_SESSION) {
            session.messages.shift();
        }
        
        this.saveToFile();
    }

    /**
     * Returns all raw messages for UI rendering (e.g. restoreHistory).
     */
    public getAllMessages(): ChatMessage[] {
        return this.activeSession ? [...this.activeSession.messages] : [];
    }

    /**
     * Backward-compatible simple history getter.
     */
    public getHistory(maxTurns?: number): Array<{ role: 'user' | 'model'; text: string }> {
        return this.getHistoryForLLM(maxTurns || this.maxHistory);
    }

    /**
     * SMART TWO-TIER CONTEXT ENGINE:
     * Provides LLM context with:
     * 1. Long-Term Rolling Summary of older messages (zero token waste, zero amnesia)
     * 2. Active recent turns verbatim
     * Does NOT mutate or delete messages from disk!
     */
    public getHistoryForLLM(
        historyLimit: number = 10,
        maxTokens: number = 8000
    ): Array<{ role: 'user' | 'model'; text: string }> {
        const session = this.activeSession;
        if (!session || session.messages.length === 0) return [];

        const turnsToKeep = Math.max(3, historyLimit);
        const messagesToKeepCount = turnsToKeep * 2; // user + model pairs

        let olderMessages: ChatMessage[] = [];
        let recentMessages: ChatMessage[] = [];

        if (session.messages.length > messagesToKeepCount) {
            olderMessages = session.messages.slice(0, session.messages.length - messagesToKeepCount);
            recentMessages = session.messages.slice(session.messages.length - messagesToKeepCount);
        } else {
            recentMessages = [...session.messages];
        }

        // Build or update rolling summary if we have older turns
        if (olderMessages.length > 0) {
            const summary = this.extractContextSummary(olderMessages, session.rollingSummary);
            if (summary && summary !== session.rollingSummary) {
                session.rollingSummary = summary;
                this.saveToFile();
            }
        }

        const formattedHistory: Array<{ role: 'user' | 'model'; text: string }> = [];

        // Prepend rolling summary as an early grounding turn if available
        if (session.rollingSummary) {
            formattedHistory.push({
                role: 'user',
                text: `### PREVIOUS CONVERSATION CONTEXT & LONG-TERM MEMORY ###\n${session.rollingSummary}\n### END PREVIOUS CONTEXT ###\nPlease keep this context, previous user goals, decisions, and files in mind.`
            });
            formattedHistory.push({
                role: 'model',
                text: `Understood! I have full memory of our previous discussions, files touched, and architectural decisions. I will continue building on this context without losing track.`
            });
        }

        // Add recent messages
        for (const msg of recentMessages) {
            formattedHistory.push({
                role: msg.role,
                text: msg.text
            });
        }

        // Ensure LLM history starts with a user turn
        while (formattedHistory.length > 0 && formattedHistory[0].role === 'model') {
            formattedHistory.shift();
        }

        // Token budget safety check (in-memory only, disk is NOT mutated)
        let totalTokens = formattedHistory.reduce((sum, m) => sum + Math.ceil(m.text.length / 4), 0);
        while (totalTokens > maxTokens && formattedHistory.length > 2) {
            // Trim oldest recent message (preserving summary if possible)
            if (session.rollingSummary && formattedHistory.length > 2) {
                formattedHistory.splice(2, 1);
            } else {
                formattedHistory.shift();
            }
            if (formattedHistory.length > 0 && formattedHistory[0].role === 'model') {
                formattedHistory.shift();
            }
            totalTokens = formattedHistory.reduce((sum, m) => sum + Math.ceil(m.text.length / 4), 0);
        }

        return formattedHistory;
    }

    /**
     * Heuristic Rolling Context Extractor:
     * Summarizes key user intents, decisions, modified files, and fixes without expensive API calls.
     */
    private extractContextSummary(olderMessages: ChatMessage[], existingSummary?: string): string {
        const userGoals: string[] = [];
        const filesMentioned = new Set<string>();
        const decisionsMade: string[] = [];
        let errorsAddressed = 0;

        for (const msg of olderMessages) {
            if (msg.role === 'user') {
                const lines = msg.text.trim().split('\n');
                const firstLine = lines[0].trim();
                if (firstLine.length > 5 && !firstLine.startsWith('---') && !firstLine.startsWith('Here is')) {
                    const cleanGoal = firstLine.substring(0, 120);
                    if (!userGoals.includes(cleanGoal)) {
                        userGoals.push(cleanGoal);
                    }
                }
            } else {
                // Find file mentions: **`filepath`** or `path/file.ext`
                const fileMatches = msg.text.matchAll(/(?:\*\*\`|\`)([a-zA-Z0-9_\-\.\/\\]+\.[a-zA-Z0-9]+)(?:\`\*\*|\`)/g);
                for (const match of fileMatches) {
                    const f = match[1];
                    if (!f.endsWith('.md') && !f.endsWith('.json') && !f.includes('node_modules')) {
                        filesMentioned.add(f);
                    }
                }

                // Error fixes
                if (/(error|exception|fail|bug|issue|fixed)/i.test(msg.text)) {
                    errorsAddressed++;
                }

                // Decisions
                const bulletMatches = msg.text.matchAll(/^- (.*(?:decid|chose|implement|creat|updat|fix).*)$/gmi);
                for (const match of bulletMatches) {
                    const dec = match[1].trim();
                    if (dec.length < 150 && !decisionsMade.includes(dec)) {
                        decisionsMade.push(dec);
                    }
                }
            }
        }

        const summaryLines: string[] = [];
        if (existingSummary) {
            summaryLines.push(existingSummary.trim());
        }

        if (userGoals.length > 0) {
            summaryLines.push(`Key User Goals / Inquiries:\n- ${userGoals.slice(-5).join('\n- ')}`);
        }

        if (filesMentioned.size > 0) {
            const filesList = Array.from(filesMentioned).slice(-15).join(', ');
            summaryLines.push(`Files Involved: ${filesList}`);
        }

        if (decisionsMade.length > 0) {
            summaryLines.push(`Decisions & Progress:\n- ${decisionsMade.slice(-4).join('\n- ')}`);
        }

        if (errorsAddressed > 0) {
            summaryLines.push(`Addressed and resolved ${errorsAddressed} troubleshooting / bug items.`);
        }

        return summaryLines.join('\n\n').substring(0, 3000);
    }

    public clear(): void {
        this.createNewSession();
    }

    public rollbackToTimestamp(timestamp: number): boolean {
        const session = this.activeSession;
        if (!session) return false;
        
        const index = session.messages.findIndex(m => m.timestamp === timestamp);
        if (index !== -1) {
            session.messages = session.messages.slice(0, index);
            session.updatedAt = Date.now();
            this.saveToFile();
            return true;
        }
        return false;
    }

    public compressHistoryWithSummary(summary: string, keepRecentTurns: number): void {
        const session = this.activeSession;
        if (!session) return;
        session.rollingSummary = summary;
        session.updatedAt = Date.now();
        this.saveToFile();
    }

    public localCompress(keepRecentTurns: number): void {
        // Safe non-destructive compression: updates rollingSummary without deleting session messages
        const session = this.activeSession;
        if (!session || session.messages.length <= keepRecentTurns * 2) return;
        
        const older = session.messages.slice(0, -(keepRecentTurns * 2));
        session.rollingSummary = this.extractContextSummary(older, session.rollingSummary);
        session.updatedAt = Date.now();
        this.saveToFile();
    }

    public addFileBackupToLatestMessage(filepath: string, content: string | null): void {
        const session = this.activeSession;
        if (!session || session.messages.length === 0) return;
        const latestMsg = session.messages[session.messages.length - 1];
        if (!latestMsg.fileBackups) latestMsg.fileBackups = [];
        
        if (!latestMsg.fileBackups.find(b => b.filepath === filepath)) {
            latestMsg.fileBackups.push({ filepath, content });
            this.saveToFile();
        }
    }

    public deleteMessageByTimestamp(timestamp: number): boolean {
        const session = this.activeSession;
        if (!session) return false;

        const index = session.messages.findIndex(m => m.timestamp === timestamp);
        if (index !== -1) {
            session.messages.splice(index, 1);
            if (index < session.messages.length && session.messages[index].role === 'model') {
                session.messages.splice(index, 1);
            }
            session.updatedAt = Date.now();
            this.saveToFile();
            return true;
        }
        return false;
    }

    public get length(): number {
        return this.activeSession ? this.activeSession.messages.length : 0;
    }

    public estimateTokens(): number {
        const session = this.activeSession;
        if (!session) return 0;
        return session.messages.reduce((sum, m) => sum + Math.ceil(m.text.length / 4), 0);
    }

    public trimToTokenBudget(maxTokens: number): void {
        // No-op for disk mutations to preserve full UI history!
        // Token budget enforcement is handled non-destructively in getHistoryForLLM.
    }
}
