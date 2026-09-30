export class PromptClassifier {
    /**
     * Classifies a user prompt into a specific category to determine tool relevance.
     */
    public static classifyPrompt(text: string): 'ui' | 'backend' | 'info' | 'general' {
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

        const uiKeywords = ['design', 'button', 'css', 'layout', 'color', 'ui', 'frontend', 'tailwind', 'component', 'view', 'styles', 'svg', 'logo'];
        const backendKeywords = ['fix', 'error', 'bug', 'api', 'database', 'function', 'class', 'backend', 'logic', 'model', 'controller', 'service', 'repository', 'exception'];
        const infoKeywords = ['explain', 'what', 'how', 'why', 'who', 'where', 'when'];
        
        let uiScore = uiKeywords.filter(kw => textLower.includes(kw)).length;
        let backendScore = backendKeywords.filter(kw => textLower.includes(kw)).length;
        let infoScore = infoKeywords.filter(kw => textLower.includes(kw)).length;
        
        if (uiScore > backendScore && uiScore > infoScore) return 'ui';
        if (backendScore > uiScore && backendScore > infoScore) return 'backend';
        if (infoScore > 0 && uiScore === 0 && backendScore === 0) return 'info';
        
        return 'general';
    }

    /**
     * Filters out irrelevant tools based on the prompt category to save tokens.
     * Core tools like plan_set and plan_done are NEVER filtered.
     */
    public static filterTools(category: 'ui' | 'backend' | 'info' | 'general', tools: any[]): any[] {
        if (!tools || tools.length === 0 || !tools[0].functionDeclarations) return tools;
        
        // In general mode, give all tools
        if (category === 'general') return tools;

        const allFuncs = tools[0].functionDeclarations;
        // Core editing and planner tools are ALWAYS essential for autonomous multi-step reasoning
        const ALWAYS_ALLOWED = ['plan_set', 'plan_done', 'plan_update', 'list_directory_tree', 'read_multiple_files', 'write_file', 'edit_file', 'replace_symbol'];

        let categoryAllowed: string[] = [];
        
        switch (category) {
            case 'ui':
                categoryAllowed = [
                    'generate_ui_blueprint', 'capture_localhost_preview', 'search_web', 
                    'research_web_docs', 'execute_terminal_command', 'check_localhost_health'
                ];
                break;
            case 'backend':
                categoryAllowed = [
                    'search_codebase', 'find_references', 
                    'update_architecture_context', 'search_web', 'execute_terminal_command',
                    'research_web_docs', 'get_code_diagnostics', 'get_symbol_outline', 'check_localhost_health'
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
