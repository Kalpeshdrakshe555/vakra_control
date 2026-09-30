import * as fs from 'fs';
import * as path from 'path';

/**
 * Direct Package Registry Interfaces (Zero scraping, Zero CAPTCHAs, 100% reliable)
 */

export interface PackageDocResult {
    name: string;
    version: string;
    description: string;
    homepage?: string;
    documentationUrl?: string;
    installCommand: string;
    readmeSnippet?: string;
}

/**
 * Fetches official Python package info from PyPI's JSON API.
 */
export async function fetchPyPiInfo(pkgName: string): Promise<PackageDocResult | null> {
    try {
        const cleanName = pkgName.trim().toLowerCase().replace(/[^a-z0-9_\-\.]/g, '');
        if (!cleanName) return null;

        const res = await fetch(`https://pypi.org/pypi/${cleanName}/json`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) return null;

        const data: any = await res.json();
        const info = data.info || {};
        const urls = info.project_urls || {};
        const docUrl = urls.Documentation || urls.Docs || urls['Source Code'] || urls.Source || info.home_page || '';

        // Truncate README description to first 2000 chars
        const rawDesc = info.description || '';
        const readmeSnippet = rawDesc.length > 2500 ? rawDesc.substring(0, 2500) + '\n...(truncated)' : rawDesc;

        return {
            name: info.name || cleanName,
            version: info.version || 'latest',
            description: info.summary || '',
            homepage: info.home_page || '',
            documentationUrl: docUrl,
            installCommand: `pip install ${info.name || cleanName}`,
            readmeSnippet
        };
    } catch {
        return null;
    }
}

/**
 * Fetches official JavaScript/TypeScript package info from npm Registry API.
 */
export async function fetchNpmInfo(pkgName: string): Promise<PackageDocResult | null> {
    try {
        const cleanName = pkgName.trim().toLowerCase().replace(/[^\@a-z0-9_\-\/]/g, '');
        if (!cleanName) return null;

        const res = await fetch(`https://registry.npmjs.org/${cleanName}`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) return null;

        const data: any = await res.json();
        const latestVersion = data['dist-tags']?.latest || Object.keys(data.versions || {}).pop() || 'latest';
        const versionData = data.versions?.[latestVersion] || {};

        const rawReadme = data.readme || versionData.readme || '';
        const readmeSnippet = rawReadme.length > 2500 ? rawReadme.substring(0, 2500) + '\n...(truncated)' : rawReadme;

        return {
            name: data.name || cleanName,
            version: latestVersion,
            description: data.description || versionData.description || '',
            homepage: data.homepage || versionData.homepage || '',
            documentationUrl: data.homepage || (data.repository?.url ? data.repository.url.replace(/^git\+/, '') : ''),
            installCommand: `npm install ${data.name || cleanName}`,
            readmeSnippet
        };
    } catch {
        return null;
    }
}

/**
 * Fetches HTML context from a web resource, strips HTML tags, and truncates content.
 */
export async function fetchWebContext(url: string): Promise<string> {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch web resource. HTTP status: ${response.status}`);
        }

        const html = await response.text();

        // Extract core content first if possible
        let mainContent = html;
        const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
        if (mainMatch && mainMatch[1]) {
            mainContent = mainMatch[1];
        }

        // Basic code block formatting preservation
        let cleanText = mainContent.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, p1) => {
            return '\n```\n' + p1.replace(/<[^>]+>/g, '').trim() + '\n```\n';
        });

        // Strip noisy tags
        cleanText = cleanText
            .replace(/<(style|script|head|title|nav|footer|aside|header|form|button|figure|iframe|noscript|svg)[^>]*>([\s\S]*?)<\/\1>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Truncate to maximum of 2500 characters
        return cleanText.substring(0, 2500);
    } catch (error) {
        console.error(`fetchWebContext failed for ${url}:`, error);
        return '';
    }
}

/**
 * Performs a web search with DuckDuckGo fallback and Registry API prioritization.
 */
export async function searchWeb(query: string): Promise<string> {
    try {
        // Step 1: Detect if query is asking for a package/library directly
        const words = query.trim().split(/\s+/);
        const candidatePkg = words.find(w => /^[a-z0-9\-_]{2,30}$/i.test(w) && !['how', 'to', 'in', 'the', 'use', 'create', 'with', 'code', 'file', 'app'].includes(w.toLowerCase()));

        if (candidatePkg) {
            // Check PyPI & npm in parallel
            const [pypi, npm] = await Promise.all([
                fetchPyPiInfo(candidatePkg),
                fetchNpmInfo(candidatePkg)
            ]);

            const isPy = /python|django|fastapi|pydantic|flask|celery|sqlmodel|pip/i.test(query);
            const winner = isPy ? (pypi || npm) : (npm || pypi);
            if (winner) {
                let out = `--- DIRECT REGISTRY DOCUMENTATION: ${winner.name}@${winner.version} ---\n`;
                out += `Summary: ${winner.description}\n`;
                out += `Install: \`${winner.installCommand}\`\n`;
                if (winner.documentationUrl) out += `Docs / Homepage: ${winner.documentationUrl}\n`;
                if (winner.readmeSnippet) {
                    out += `\nReadme / Usage Snippet:\n${winner.readmeSnippet.substring(0, 1500)}\n`;
                }
                return out;
            }
        }

        // Step 2: Fallback to DuckDuckGo search
        const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (response.ok) {
            const html = await response.text();
            const results: { url: string; snippet: string }[] = [];
            const resultRegex = /href="([^"]*uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
            let match;
            while ((match = resultRegex.exec(html)) !== null && results.length < 3) {
                try {
                    const params = new URLSearchParams(match[1].includes('?') ? match[1].split('?')[1] : match[1]);
                    const cleanUrl = decodeURIComponent(params.get('uddg') || '');
                    const snippet = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                    if (cleanUrl.startsWith('http') && !cleanUrl.includes('duckduckgo.com') && !results.some(r => r.url === cleanUrl)) {
                        results.push({ url: cleanUrl, snippet });
                    }
                } catch {}
            }

            if (results.length > 0) {
                const fullResults = await Promise.all(results.map(async (r, idx) => {
                    try {
                        const pageContent = await fetchWebContext(r.url);
                        if (pageContent && pageContent.length > 200) {
                            return `[Source ${idx + 1}] ${r.url}\n${pageContent}`;
                        }
                    } catch {}
                    return `[Source ${idx + 1}] ${r.url}\nSnippet: ${r.snippet}`;
                }));
                return `--- WEB SEARCH RESULTS FOR '${query}' ---\n\n` + fullResults.join('\n\n---\n\n');
            }
        }

        return `No online documentation found for query '${query}'.`;
    } catch (error) {
        console.error("Search error:", error);
        return `Search failed: ${error}`;
    }
}

/**
 * Autonomous Deep Doc Researcher Sub-Agent
 * Integrates direct package registry lookups with web fallback.
 * Saves clean markdown in `.ultra-light-ai/research/`.
 */
export async function researchWebDocs(query: string, urls: string[] = [], workspaceRoot: string): Promise<string> {
    const { executeDeepResearch } = require('./researchDistiller');
    return await executeDeepResearch(query, urls, workspaceRoot);
}

/**
 * Autonomous Pre-Flight Scout Pattern:
 * Analyzes prompt for library/framework setup needs and fetches live registry docs
 * BEFORE invoking the model. Returns an injected context block (max 800 tokens).
 */
export async function autonomousPreFlightScout(prompt: string): Promise<string> {
    try {
        const lower = prompt.toLowerCase();
        // Common libraries that often suffer from syntax hallucination in small models
        const candidateLibs = [
            'tailwind', 'django-tailwind', 'fastapi', 'pydantic', 'zustand', 'zod',
            'trpc', 'prisma', 'drizzle-orm', 'next-auth', 'lucide-react', 'flowbite',
            'radix-ui', 'shadcn', 'framer-motion', 'sqlmodel', 'celery'
        ];

        const detected = candidateLibs.filter(lib => lower.includes(lib));
        if (detected.length === 0) return '';

        const targetLib = detected[0];
        const [npm, pypi] = await Promise.all([fetchNpmInfo(targetLib), fetchPyPiInfo(targetLib)]);
        const pythonLibs = ['fastapi', 'pydantic', 'django-tailwind', 'sqlmodel', 'celery'];
        const isPy = pythonLibs.includes(targetLib);
        const best = isPy ? (pypi || npm) : (npm || pypi);
        if (!best) return '';

        return `[PRE-FLIGHT SCOUT: Live Docs for ${best.name}@${best.version}]\n` +
               `Install: ${best.installCommand}\n` +
               `Description: ${best.description}\n` +
               (best.readmeSnippet ? `Setup Guide:\n${best.readmeSnippet.substring(0, 800)}\n` : '');
    } catch {
        return '';
    }
}
