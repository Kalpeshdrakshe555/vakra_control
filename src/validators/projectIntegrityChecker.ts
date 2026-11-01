// src/validators/projectIntegrityChecker.ts
// Static cross-file wiring & architecture validator for frameworks (Django, React, Node).
// Detects missing connections, unregistered apps, empty template dirs, and namespace collisions.

import * as fs from 'fs';
import * as path from 'path';

export interface IntegrityIssue {
    severity: 'critical' | 'warning' | 'hint';
    code: string;
    message: string;
    fixSuggestion: string;
    file?: string;
    line?: number;
}

export class ProjectIntegrityChecker {
    /**
     * Inspects a workspace and returns all architectural wiring issues found.
     */
    public static checkWorkspace(workspaceRoot: string): IntegrityIssue[] {
        if (!workspaceRoot || !fs.existsSync(workspaceRoot)) return [];

        const issues: IntegrityIssue[] = [];

        // Check if Django project
        if (this.isDjangoProject(workspaceRoot)) {
            issues.push(...this.checkDjangoProject(workspaceRoot));
        }

        return issues;
    }

    /**
     * Returns a formatted text snippet of the top integrity issues (clamped for small models).
     */
    public static formatReport(issues: IntegrityIssue[], maxIssues: number = 2): string {
        if (!issues || issues.length === 0) return '';

        const subset = issues.slice(0, maxIssues);
        const lines: string[] = [];
        lines.push(`\n[PROJECT INTEGRITY CHECK (${issues.length} issue${issues.length > 1 ? 's' : ''} detected)]:`);

        subset.forEach((issue, idx) => {
            const prefix = issue.severity === 'critical' ? '🚨 CRITICAL' : (issue.severity === 'warning' ? '⚠️ WARNING' : '💡 HINT');
            lines.push(`${idx + 1}. ${prefix}: ${issue.message}`);
            lines.push(`   Suggested Fix: ${issue.fixSuggestion}`);
        });

        if (issues.length > maxIssues) {
            lines.push(`   (... and ${issues.length - maxIssues} other wiring item(s) pending after fixing the above)`);
        }

        return lines.join('\n');
    }

    private static isDjangoProject(workspaceRoot: string): boolean {
        return fs.existsSync(path.join(workspaceRoot, 'manage.py'));
    }

    private static checkDjangoProject(workspaceRoot: string): IntegrityIssue[] {
        const issues: IntegrityIssue[] = [];

        // Find settings.py
        let settingsPath: string | null = null;
        let settingsContent = '';

        const findSettings = (dir: string, depth = 0) => {
            if (depth > 2 || settingsPath) return;
            try {
                const entries = fs.readdirSync(dir);
                for (const e of entries) {
                    if (['node_modules', '.git', '.venv', 'venv', '__pycache__', '.ultra-light-ai'].includes(e)) continue;
                    const full = path.join(dir, e);
                    if (fs.statSync(full).isDirectory()) {
                        const s = path.join(full, 'settings.py');
                        if (fs.existsSync(s)) {
                            settingsPath = s;
                            settingsContent = fs.readFileSync(s, 'utf8');
                            return;
                        }
                        findSettings(full, depth + 1);
                    }
                }
            } catch {}
        };
        findSettings(workspaceRoot);

        if (!settingsPath) return issues;
        const relSettings = path.relative(workspaceRoot, settingsPath).replace(/\\/g, '/');

        // 1. Check Reserved App Names and discover local apps
        const entries = fs.readdirSync(workspaceRoot);
        const reserved = ['auth', 'admin', 'django', 'test', 'site'];
        const appNames: string[] = [];

        for (const e of entries) {
            if (['node_modules', '.git', '.venv', 'venv', '__pycache__', '.ultra-light-ai', 'templates', 'static'].includes(e)) continue;
            const full = path.join(workspaceRoot, e);
            try {
                if (fs.statSync(full).isDirectory()) {
                    const hasAppsPy = fs.existsSync(path.join(full, 'apps.py'));
                    const hasModelsPy = fs.existsSync(path.join(full, 'models.py'));
                    const hasViewsPy = fs.existsSync(path.join(full, 'views.py'));
                    if (hasAppsPy || hasModelsPy || hasViewsPy) {
                        appNames.push(e);
                        if (reserved.includes(e.toLowerCase())) {
                            issues.push({
                                severity: 'critical',
                                code: 'RESERVED_APP_NAME',
                                message: `Local app directory '${e}' collides with Django internal package 'django.contrib.${e}'.`,
                                fixSuggestion: `Rename app directory '${e}' to 'users', 'accounts', or a custom domain name to avoid namespace collision.`
                            });
                        }
                    }
                }
            } catch {}
        }

        // 2. Check INSTALLED_APPS registration
        const installedAppsMatch = settingsContent.match(/INSTALLED_APPS\s*=\s*\[([\s\S]*?)\]/);
        const installedAppsStr = installedAppsMatch ? installedAppsMatch[1] : '';

        for (const app of appNames) {
            if (app.toLowerCase() === 'auth' || app.toLowerCase() === 'config') continue;
            const isRegistered = new RegExp(`['"](?:[a-zA-Z0-9_]+\\.)?${app}(?:\\.apps\\.[a-zA-Z0-9_]+)?['"]`).test(installedAppsStr);
            if (!isRegistered) {
                issues.push({
                    severity: 'warning',
                    code: 'UNREGISTERED_APP',
                    message: `App '${app}' exists with models/views but is NOT listed in INSTALLED_APPS in ${relSettings}.`,
                    fixSuggestion: `Add '${app}' to INSTALLED_APPS in ${relSettings}.`
                });
            }
        }

        // Check rest_framework registration if imported
        let usesDRF = false;
        for (const app of appNames) {
            const vp = path.join(workspaceRoot, app, 'views.py');
            const sp = path.join(workspaceRoot, app, 'serializers.py');
            if (fs.existsSync(vp) && fs.readFileSync(vp, 'utf8').includes('rest_framework')) usesDRF = true;
            if (fs.existsSync(sp) && fs.readFileSync(sp, 'utf8').includes('rest_framework')) usesDRF = true;
        }
        if (usesDRF && !installedAppsStr.includes('rest_framework')) {
            issues.push({
                severity: 'warning',
                code: 'MISSING_DRF_APP',
                message: `Django REST Framework is imported in code but 'rest_framework' is missing from INSTALLED_APPS in ${relSettings}.`,
                fixSuggestion: `Add 'rest_framework' to INSTALLED_APPS in ${relSettings}.`
            });
        }

        // 3. Check TEMPLATES['DIRS']
        const templatesDir = path.join(workspaceRoot, 'templates');
        if (fs.existsSync(templatesDir) && fs.statSync(templatesDir).isDirectory()) {
            const templatesMatch = settingsContent.match(/TEMPLATES\s*=\s*\[([\s\S]*?)\]/);
            const templatesStr = templatesMatch ? templatesMatch[1] : '';
            const hasDirsRegistered = /['"]DIRS['"]\s*:\s*\[\s*(?:BASE_DIR\s*\/\s*['"]templates['"]|['"]templates['"])/.test(templatesStr);
            if (!hasDirsRegistered) {
                issues.push({
                    severity: 'warning',
                    code: 'UNREGISTERED_TEMPLATES_DIR',
                    message: `'templates/' directory exists, but TEMPLATES['DIRS'] is empty in ${relSettings}.`,
                    fixSuggestion: `Set 'DIRS': [BASE_DIR / 'templates'] inside TEMPLATES in ${relSettings} so Django can locate HTML templates.`
                });
            }
        }

        // 4. Check HTML Template Rendering vs Pure JSON API Views
        try {
            const hasHtmlTemplates = fs.existsSync(templatesDir) && fs.readdirSync(templatesDir).some(f => f.endsWith('.html'));
            if (hasHtmlTemplates) {
                let hasHtmlView = false;
                for (const app of appNames) {
                    const vp = path.join(workspaceRoot, app, 'views.py');
                    if (fs.existsSync(vp)) {
                        const vText = fs.readFileSync(vp, 'utf8');
                        if (vText.includes('render(') || vText.includes('TemplateView')) {
                            hasHtmlView = true;
                            break;
                        }
                    }
                }
                if (!hasHtmlView) {
                    issues.push({
                        severity: 'hint',
                        code: 'NO_HTML_VIEW',
                        message: `HTML templates exist in 'templates/', but all views are returning JSON APIs. No view calls render(request, '...html').`,
                        fixSuggestion: `Implement at least one view in your main app that returns render(request, 'products.html', context) to render the web frontend.`
                    });
                }
            }
        } catch {}

        return issues;
    }
}
