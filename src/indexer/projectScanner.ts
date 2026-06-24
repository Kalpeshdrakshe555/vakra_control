import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ProjectProfile {
    stack: string;
    framework: string;
    entryPoints: string[];
    buildCommand?: string;
    devCommand?: string;
    testCommand?: string;
}

export class ProjectScanner {
    public static async scanProject(workspaceRoot: string): Promise<ProjectProfile | null> {
        if (!workspaceRoot) return null;

        const profile: ProjectProfile = {
            stack: 'Unknown',
            framework: 'None',
            entryPoints: []
        };

        const packageJsonPath = path.join(workspaceRoot, 'package.json');
        const requirementsTxtPath = path.join(workspaceRoot, 'requirements.txt');
        const pyprojectTomlPath = path.join(workspaceRoot, 'pyproject.toml');
        const cargoTomlPath = path.join(workspaceRoot, 'Cargo.toml');
        const goModPath = path.join(workspaceRoot, 'go.mod');

        let isNode = false;
        let isPython = false;
        let isRust = false;
        let isGo = false;

        // 1. Detect Stack and Framework
        if (fs.existsSync(packageJsonPath)) {
            isNode = true;
            try {
                const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                const deps = { ...pkg.dependencies, ...pkg.devDependencies };
                
                if (deps['next']) profile.framework = 'Next.js';
                else if (deps['react-scripts'] || deps['react']) profile.framework = 'React';
                else if (deps['vue']) profile.framework = 'Vue';
                else if (deps['@angular/core']) profile.framework = 'Angular';
                else if (deps['svelte']) profile.framework = 'Svelte';
                else if (deps['express']) profile.framework = 'Express';
                else if (deps['nestjs']) profile.framework = 'NestJS';

                if (deps['typescript']) profile.stack = 'Node.js + TypeScript';
                else profile.stack = 'Node.js + JavaScript';

                if (pkg.scripts) {
                    profile.buildCommand = pkg.scripts.build ? 'npm run build' : undefined;
                    profile.devCommand = pkg.scripts.dev || pkg.scripts.start ? (pkg.scripts.dev ? 'npm run dev' : 'npm start') : undefined;
                    profile.testCommand = pkg.scripts.test ? 'npm test' : undefined;
                }
            } catch (e) {
                console.warn('Failed to parse package.json', e);
            }
        } else if (fs.existsSync(requirementsTxtPath) || fs.existsSync(pyprojectTomlPath)) {
            isPython = true;
            profile.stack = 'Python';
            try {
                const reqs = fs.existsSync(requirementsTxtPath) ? fs.readFileSync(requirementsTxtPath, 'utf8') : '';
                if (reqs.includes('Django')) profile.framework = 'Django';
                else if (reqs.includes('Flask')) profile.framework = 'Flask';
                else if (reqs.includes('FastAPI')) profile.framework = 'FastAPI';
            } catch (e) { }
        } else if (fs.existsSync(cargoTomlPath)) {
            isRust = true;
            profile.stack = 'Rust';
            profile.buildCommand = 'cargo build';
            profile.devCommand = 'cargo run';
            profile.testCommand = 'cargo test';
        } else if (fs.existsSync(goModPath)) {
            isGo = true;
            profile.stack = 'Go';
            profile.buildCommand = 'go build';
            profile.devCommand = 'go run .';
            profile.testCommand = 'go test ./...';
        }

        // 2. Scan for Entry Points (max 3 levels deep)
        const commonEntryNames = ['index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js', 'server.ts', 'server.js', 'main.py', 'app.py', 'manage.py', 'main.go', 'main.rs', 'layout.tsx', 'page.tsx'];
        
        try {
            // Very fast shallow glob search
            const files = await vscode.workspace.findFiles('**/{' + commonEntryNames.join(',') + '}', '**/node_modules/**|**/.git/**|**/dist/**|**/build/**|**/.next/**', 10);
            for (const file of files) {
                const relPath = path.relative(workspaceRoot, file.fsPath);
                // Keep only top 3 levels
                if (relPath.split(path.sep).length <= 4) {
                    profile.entryPoints.push(relPath);
                }
            }
        } catch (e) { }

        // Save Profile
        const aiMetaDir = path.join(workspaceRoot, '.ultra-light-ai');
        if (!fs.existsSync(aiMetaDir)) {
            fs.mkdirSync(aiMetaDir, { recursive: true });
        }
        
        const profilePath = path.join(aiMetaDir, 'PROJECT_PROFILE.json');
        fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');

        return profile;
    }

    public static getProfile(workspaceRoot: string): ProjectProfile | null {
        const profilePath = path.join(workspaceRoot, '.ultra-light-ai', 'PROJECT_PROFILE.json');
        if (fs.existsSync(profilePath)) {
            try {
                return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
            } catch (e) {
                return null;
            }
        }
        return null;
    }
}
