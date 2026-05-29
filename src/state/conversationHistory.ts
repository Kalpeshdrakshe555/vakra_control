/**
 * ConversationHistory — Manages multi-turn chat context for the AI agent.
 * Stores message history with role attribution and provides serialization
 * for the Gemini multi-turn API format.
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
}
export interface ChatSession {
    id: string;
    title: string;
    updatedAt: number;
    messages: ChatMessage[];
}

export class ConversationHistory {
    private sessions: ChatSession[] = [];
    private currentSessionId: string | null = null;
    private readonly maxHistory: number;
    private savePath?: string;

    constructor(maxHistory: number = 20, workspaceRoot?: string) {
        this.maxHistory = maxHistory;
        if (workspaceRoot) {
            this.savePath = path.join(workspaceRoot, '.chat-history.json');
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
            usage
        });

        while (session.messages.length > this.maxHistory * 2) {
            session.messages.shift();
        }
        
        this.saveToFile();
    }

    public getHistory(maxTurns?: number): Array<{ role: 'user' | 'model'; text: string }> {
        const session = this.activeSession;
        if (!session) return [];
        const limit = maxTurns || this.maxHistory;
        const sliced = session.messages.slice(-limit * 2);
        
        while (sliced.length > 0 && sliced[0].role === 'model') {
            sliced.shift();
        }

        return sliced.map(m => ({
            role: m.role,
            text: m.text
        }));
    }

    public getAllMessages(): ChatMessage[] {
        return this.activeSession ? [...this.activeSession.messages] : [];
    }

    public clear(): void {
        this.createNewSession();
    }

    public rollbackToTimestamp(timestamp: number): boolean {
        const session = this.activeSession;
        if (!session) return false;
        
        const index = session.messages.findIndex(m => m.timestamp === timestamp);
        if (index !== -1) {
            session.messages = session.messages.slice(0, index + 1);
            session.updatedAt = Date.now();
            this.saveToFile();
            return true;
        }
        return false;
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
        return session.messages.reduce((sum, m) => sum + Math.ceil(m.text.length / 3), 0);
    }

    public trimToTokenBudget(maxTokens: number): void {
        const session = this.activeSession;
        if (!session) return;
        
        let trimmed = false;
        while (this.estimateTokens() > maxTokens && session.messages.length > 2) {
            // Remove user message
            session.messages.shift();
            // Remove paired model message to maintain alternation
            if (session.messages.length > 0 && session.messages[0].role === 'model') {
                session.messages.shift();
            }
            trimmed = true;
        }
        
        // Failsafe: Ensure the first message is always from the user
        while (session.messages.length > 0 && session.messages[0].role === 'model') {
            session.messages.shift();
            trimmed = true;
        }

        if (trimmed) this.saveToFile();
    }
}
