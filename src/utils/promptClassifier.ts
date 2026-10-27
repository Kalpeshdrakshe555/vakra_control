export class PromptClassifier {
    /**
     * Checks if a user prompt is merely a greeting, casual chat, or polite closing.
     */
    public static isGreetingOrChat(text: string): boolean {
        const clean = text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        if (!clean) return true;
        const greetings = new Set([
            'hi', 'hello', 'hey', 'hola', 'namaste', 'kem cho', 'sup', 'yo',
            'good morning', 'good afternoon', 'good evening', 'good night',
            'who are you', 'what can you do', 'what are you', 'help me',
            'thanks', 'thank you', 'ok', 'okay', 'bye', 'kaise ho', 'kya haal hai'
        ]);
        if (greetings.has(clean)) return true;
        const words = clean.split(/\s+/);
        if (words.length <= 3 && ['hi', 'hello', 'hey', 'namaste', 'kemcho'].includes(words[0])) {
            return true;
        }
        return false;
    }

    /**
     * Classifies a user prompt into a specific category to determine tool relevance.
     */
    public static classifyPrompt(text: string): 'ui' | 'backend' | 'info' | 'chat' | 'general' {
        if (PromptClassifier.isGreetingOrChat(text)) {
            return 'chat';
        }

        const textLower = text.toLowerCase();
        
        // Full project / application tasks MUST get general classification with all tools enabled
        const fullstackKeywords = [
            'full stack', 'fullstack', 'project', 'build', 'create', 'complete', 
            'ecommerce', 'e-commerce', 'app', 'system', 'scratch', 'refactor', 
            'develop', 'scaffold', 'implement', 'analyze', 'adhura'
        ];
        if (fullstackKeywords.some(kw => textLower.includes(kw))) {
            return 'general';
        }

        const isExplanationQuery = /^(?:explain|describe|what\s+is|what\s+are|what\s+does|how\s+does|how\s+do|why\s+is|why\s+does|walk\s+me\s+through)\b/i.test(text.trim());
        const hasModificationIntent = /\b(?:fix|error|bug|issue|create|build|implement|edit|change|modify|refactor|update|delete|remove|add)\b/i.test(textLower);
        if (isExplanationQuery && !hasModificationIntent) {
            return 'info';
        }

        const uiKeywords = ['design', 'button', 'css', 'layout', 'color', 'ui', 'frontend', 'tailwind', 'component', 'view', 'styles', 'svg', 'logo'];
        const backendKeywords = ['fix', 'error', 'bug', 'api', 'database', 'function', 'class', 'backend', 'logic', 'model', 'controller', 'service', 'repository', 'exception'];
        const infoKeywords = ['explain', 'what', 'how', 'why', 'who', 'where', 'when'];
        
        let uiScore = uiKeywords.filter(kw => textLower.includes(kw)).length;
        let backendScore = backendKeywords.filter(kw => textLower.includes(kw)).length;
        let infoScore = infoKeywords.filter(kw => textLower.includes(kw)).length;
        
        if (uiScore > backendScore && uiScore > infoScore) return 'ui';
        if (backendScore > uiScore && backendScore > infoScore) return 'backend';
        if (infoScore > uiScore && infoScore > backendScore) return 'info';
        if (infoScore > 0 && uiScore === 0 && backendScore === 0) return 'info';
        
        return 'general';
    }

    /**
     * Filters out irrelevant tools based on the prompt category to save tokens and prevent tool misuse.
     */
    public static filterTools(category: 'ui' | 'backend' | 'info' | 'chat' | 'general', tools: any[]): any[] {
        if (!tools || tools.length === 0 || !tools[0].functionDeclarations) return tools;
        
        // For conversational greetings, NO tools should be invoked!
        if (category === 'chat') {
            return [];
        }

        // In general mode, give all tools
        if (category === 'general') return tools;

        const allFuncs = tools[0].functionDeclarations;
        const ALWAYS_ALLOWED = [
            'plan_set', 'plan_done', 'plan_update', 
            'set_task_plan', 'expand_plan_step', 'complete_plan_step', 
            'read_state_ledger', 'list_directory_tree', 'read_multiple_files', 
            'write_file', 'edit_file', 'replace_symbol', 
            'finish', 'create_skill', 'read_skill'
        ];

        let categoryAllowed: string[] = [];
        
        switch (category) {
            case 'ui':
                categoryAllowed = [
                    'search_web', 'research_web_docs', 'execute_terminal_command'
                ];
                break;
            case 'backend':
                categoryAllowed = [
                    'search_codebase', 'find_references', 
                    'search_web', 'execute_terminal_command',
                    'research_web_docs', 'get_code_diagnostics', 'get_symbol_outline'
                ];
                break;
            case 'info':
                categoryAllowed = ['search_codebase', 'search_web', 'research_web_docs', 'get_symbol_outline'];
                break;
            default:
                return tools;
        }

        const allowedSet = new Set([...ALWAYS_ALLOWED, ...categoryAllowed]);
        const filteredFuncs = allFuncs.filter((f: any) => allowedSet.has(f.name) || f.name.startsWith('custom_'));
        return [{ functionDeclarations: filteredFuncs }];
    }
}
