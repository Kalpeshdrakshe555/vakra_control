import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getAgentConfig } from '../config';

export class BackgroundIndexer {
    private workspaceRoot: string;
    private modifiedFiles: Set<string> = new Set();
    private debounceTimer: NodeJS.Timeout | null = null;
    private isIndexing: boolean = false;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    public async initialize() {
        const config = getAgentConfig(this.workspaceRoot);
        // M3 FIX: Only attempt generation if Support Brain is actually configured
        if (!config?.supportBrain?.apiKey && !config?.supportBrain?.endpoint) return;

        const archPath = path.join(this.workspaceRoot, 'ARCHITECTURE.md');
        if (!fs.existsSync(archPath)) {
            console.log("[BackgroundIndexer] ARCHITECTURE.md not found. Generating initial architecture...");
            vscode.window.setStatusBarMessage('$(sync~spin) AI generating ARCHITECTURE.md...', 5000);
            
            // Wait a bit to ensure RAG has built index
            setTimeout(() => {
                this.generateInitialArchitecture();
            }, 10000);
        }
    }

    private async generateInitialArchitecture() {
        if (this.isIndexing) return;
        
        const config = getAgentConfig(this.workspaceRoot);
        if (!config?.supportBrain) return;

        this.isIndexing = true;
        try {
            const supportClient = this.getSupportClient(config.supportBrain, config);
            if (!supportClient) return;

            // Gather folder structure (Deep scan for functions)
            let structure = "Project Root & Files:\n";
            try {
                let fileCount = 0;
                const walkSync = (dir: string, filelist: string[] = [], depth = 0) => {
                    if (depth > 4 || fileCount > 100) return filelist; // Limit depth and files to prevent freezing
                    const files = fs.readdirSync(dir);
                    for (const file of files) {
                        if (['node_modules', '.git', 'dist', 'out', 'build', '.next', '.vscode'].includes(file)) continue;
                        const filepath = path.join(dir, file);
                        const stat = fs.statSync(filepath);
                        if (stat.isDirectory()) {
                            walkSync(filepath, filelist, depth + 1);
                        } else {
                            if (['.ts', '.js', '.py', '.java', '.go', '.rs', '.tsx', '.jsx'].includes(path.extname(file))) {
                                fileCount++;
                                try {
                                    const content = fs.readFileSync(filepath, 'utf8');
                                    // Extract top 3 function/class names roughly
                                    const matches = content.match(/(?:class|function|const|let|var)\s+([a-zA-Z0-9_]+)/g);
                                    const functions = matches ? matches.slice(0, 3).map(f => f.replace(/(?:class|function|const|let|var)\s+/, '')).join(', ') : 'misc logic';
                                    filelist.push(`- ${path.relative(this.workspaceRoot, filepath)} (Core: ${functions})`);
                                } catch (e) {
                                    filelist.push(`- ${path.relative(this.workspaceRoot, filepath)}`);
                                }
                            }
                        }
                    }
                    return filelist;
                };
                const allFiles = walkSync(this.workspaceRoot);
                structure += allFiles.join('\n');
            } catch(e) {}
            
            // Gather dependency context to instantly understand the tech stack of massive projects
            let dependenciesContext = '';
            const depFiles = ['package.json', 'requirements.txt', 'pom.xml', 'go.mod', 'Cargo.toml', 'composer.json', 'build.gradle'];
            for (const depFile of depFiles) {
                const fullPath = path.join(this.workspaceRoot, depFile);
                if (fs.existsSync(fullPath)) {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        dependenciesContext += `\n--- ${depFile} ---\n${content.substring(0, 2500)}\n`;
                    } catch (e) {}
                }
            }

            const prompt = `You are an AI Architect. The user just opened an existing project. Here is the mapped directory structure with core functions:\n\n${structure}\n\nDependencies (truncated):\n${dependenciesContext}\n\nPlease generate an initial highly accurate ARCHITECTURE.md file. You MUST include:\n1. A high-level overview.\n2. The exact Tech Stack.\n3. A mapped folder structure.\n4. A list of key files with their functions and a 1-line explanation for each.\nOutput ONLY the raw markdown content.`;

            const response = await supportClient.complete(prompt);
            let newContent = response.text.trim();
            if (newContent.startsWith('\`\`\`markdown')) newContent = newContent.replace(/^\`\`\`markdown\n/, '').replace(/\n\`\`\`$/, '');
            else if (newContent.startsWith('\`\`\`')) newContent = newContent.replace(/^\`\`\`\n/, '').replace(/\n\`\`\`$/, '');

            fs.writeFileSync(path.join(this.workspaceRoot, 'ARCHITECTURE.md'), newContent, 'utf8');
            vscode.window.setStatusBarMessage('$(check) AI generated ARCHITECTURE.md', 3000);
        } catch (e) {
            console.error('[BackgroundIndexer] Initial generation failed', e);
        } finally {
            this.isIndexing = false;
        }
    }

    private getSupportClient(supportBrain: any, config: any) {
        const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');
        if (supportBrain.providerType === 'local') {
            return new LocalOllamaClient(supportBrain.model || 'llama-3.1-8b-instant', supportBrain.endpoint || 'http://127.0.0.1:11434', supportBrain.apiKey);
        } else {
            const keyStr = supportBrain.apiKey?.trim() || '';
            if (keyStr.startsWith('gsk_')) {
                return new LocalOllamaClient(supportBrain.model, 'https://api.groq.com/openai', keyStr);
            } else if (keyStr.startsWith('sk-') || keyStr.startsWith('sk-proj-')) {
                return new LocalOllamaClient(supportBrain.model, 'https://api.openai.com', keyStr);
            } else {
                const timeout = config.providers?.cloud?.timeoutSeconds ? config.providers.cloud.timeoutSeconds * 1000 : 60000;
                return new GeminiCloudClient([keyStr], supportBrain.model || 'gemini-1.5-flash', timeout);
            }
        }
    }

    /**
     * Called when a file is saved or changed.
     */
    public onFileChanged(filePath: string) {
        // Only track code files, ignore dot files, node_modules, and ARCHITECTURE itself
        if (filePath.includes('node_modules') || filePath.includes('.git') || filePath.includes('dist') || filePath.includes('out') || filePath.endsWith('ARCHITECTURE.md')) {
            return;
        }

        const ext = path.extname(filePath);
        if (!['.ts', '.js', '.py', '.java', '.go', '.rs', '.tsx', '.jsx'].includes(ext)) {
            return;
        }

        this.modifiedFiles.add(filePath);

        // Debounce for 30 seconds of inactivity
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.runIndexTask();
        }, 30000); // 30s
    }

    private async runIndexTask() {
        if (this.isIndexing || this.modifiedFiles.size === 0) return;

        const config = getAgentConfig(this.workspaceRoot);
        // C4 FIX: Run in ALL modes, not just Advanced Mode. Only need Support Brain configured.
        if (!config?.supportBrain) {
            this.modifiedFiles.clear();
            return;
        }

        this.isIndexing = true;
        const filesToIndex = Array.from(this.modifiedFiles);
        this.modifiedFiles.clear();

        try {
            const supportClient = this.getSupportClient(config.supportBrain, config);
            if (!supportClient) return;

            // Gather context
            let changesContext = '';
            let totalChars = 0;
            const MAX_PAYLOAD_CHARS = 40000; // Hard cap at ~10,000 tokens to protect Scout memory limit

            for (const file of filesToIndex) {
                if (fs.existsSync(file)) {
                    const content = fs.readFileSync(file, 'utf8');
                    // Truncate huge files to prevent token explosion
                    const safeContent = content.length > 10000 ? content.substring(0, 10000) + '\n... (truncated)' : content;
                    
                    if (totalChars + safeContent.length > MAX_PAYLOAD_CHARS) {
                        changesContext += `\n--- File: ${path.relative(this.workspaceRoot, file)} ---\n... (Skipped to stay within limits)\n`;
                        continue; // Skip adding full content but acknowledge file was changed
                    }
                    
                    totalChars += safeContent.length;
                    changesContext += `\n--- File: ${path.relative(this.workspaceRoot, file)} ---\n${safeContent}\n`;
                }
            }

            const archPath = path.join(this.workspaceRoot, 'ARCHITECTURE.md');
            let currentArch = '';
            if (fs.existsSync(archPath)) {
                currentArch = fs.readFileSync(archPath, 'utf8');
            }

            const prompt = `You are a background AI Architecture assistant. The user has recently modified the following files:\n${changesContext}\n\nHere is the current ARCHITECTURE.md content:\n${currentArch || '(No ARCHITECTURE.md exists yet)'}\n\nPlease output the completely updated markdown content for ARCHITECTURE.md reflecting these changes. Keep it concise, maintain structural overviews, and note significant new functions or components. Output ONLY the raw markdown content without any wrapper code blocks or conversational text.`;

            // Execute completion silently
            const response = await supportClient.complete(prompt);
            
            let newContent = response.text.trim();
            
            // Clean markdown wrapper if the model misbehaves
            if (newContent.startsWith('\`\`\`markdown')) {
                newContent = newContent.replace(/^\`\`\`markdown\n/, '').replace(/\n\`\`\`$/, '');
            } else if (newContent.startsWith('\`\`\`')) {
                newContent = newContent.replace(/^\`\`\`\n/, '').replace(/\n\`\`\`$/, '');
            }

            // Save updated ARCHITECTURE.md
            fs.writeFileSync(archPath, newContent, 'utf8');
            console.log(`[BackgroundIndexer] Successfully updated ARCHITECTURE.md using Support Brain.`);
            
            vscode.window.setStatusBarMessage('$(sync) AI updated ARCHITECTURE.md', 3000);

        } catch (error) {
            console.error('[BackgroundIndexer] Failed to update architecture:', error);
            // Re-add files to queue so we can try again later
            filesToIndex.forEach(f => this.modifiedFiles.add(f));
        } finally {
            this.isIndexing = false;
        }
    }
}
