export class PromptClassifier {
    /**
     * Classifies a user prompt into a specific category to determine tool relevance.
     */
    public static classifyPrompt(text: string): 'ui' | 'backend' | 'info' | 'general' {
        const textLower = text.toLowerCase();
        
        const uiKeywords = ['design', 'button', 'page', 'css', 'layout', 'color', 'website', 'app', 'ui', 'frontend', 'tailwind', 'component', 'view', 'styles', 'svg', 'logo'];
        const backendKeywords = ['fix', 'error', 'bug', 'api', 'database', 'function', 'class', 'backend', 'logic', 'model', 'controller', 'service', 'repository', 'exception'];
        const infoKeywords = ['explain', 'what', 'how', 'why', 'who', 'where', 'when'];
        
        let uiScore = uiKeywords.filter(kw => textLower.includes(kw)).length;
        let backendScore = backendKeywords.filter(kw => textLower.includes(kw)).length;
        let infoScore = infoKeywords.filter(kw => textLower.includes(kw)).length;
        
        if (uiScore > backendScore && uiScore > infoScore) return 'ui';
        if (backendScore > uiScore && backendScore > infoScore) return 'backend';
        // info usually stands alone, but if there's no UI or backend context, it's info
        if (infoScore > 0 && uiScore === 0 && backendScore === 0) return 'info';
        
        return 'general';
    }

    /**
     * Filters out irrelevant tools based on the prompt category to save tokens.
     */
    public static filterTools(category: 'ui' | 'backend' | 'info' | 'general', tools: any[]): any[] {
        if (!tools || tools.length === 0 || !tools[0].functionDeclarations) return tools;
        
        const allFuncs = tools[0].functionDeclarations;
        let allowedNames: string[] = [];
        
        switch (category) {
            case 'ui':
                allowedNames = ['read_multiple_files', 'search_codebase', 'generate_ui_blueprint', 'search_web', 'research_web_docs', 'list_directory_tree', 'check_localhost_health'];
                break;
            case 'backend':
                allowedNames = [
                    'read_multiple_files', 'search_codebase', 'find_references', 'replace_symbol', 
                    'update_architecture_context', 'search_web', 'execute_terminal_command',
                    'research_web_docs', 'list_directory_tree', 'get_code_diagnostics', 'get_symbol_outline', 'check_localhost_health'
                ];
                break;
            case 'info':
                allowedNames = ['read_multiple_files', 'search_codebase', 'search_web', 'research_web_docs', 'list_directory_tree', 'get_symbol_outline'];
                break;
            case 'general':
            default:
                // General gets all tools just in case
                return tools;
        }
        
        const filteredFuncs = allFuncs.filter((f: any) => allowedNames.includes(f.name));
        return [{ functionDeclarations: filteredFuncs }];
    }
}
