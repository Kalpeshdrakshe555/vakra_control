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
 * Fetches documentation or raw code context from any web resource.
 * Natively supports GitHub (raw files & READMEs), Hugging Face (Model Cards & raw files),
 * raw code files (gist, pastebin), and standard HTML web pages.
 */
export async function fetchWebContext(rawUrl: string): Promise<string> {
    try {
        let url = rawUrl.trim();

        // 1. GitHub optimization: convert blob URL to raw.githubusercontent.com
        // e.g. https://github.com/owner/repo/blob/main/path/to/file.py -> https://raw.githubusercontent.com/owner/repo/main/path/to/file.py
        const githubBlobMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
        if (githubBlobMatch) {
            url = `https://raw.githubusercontent.com/${githubBlobMatch[1]}/${githubBlobMatch[2]}/${githubBlobMatch[3]}/${githubBlobMatch[4]}`;
        }

        // 2. Hugging Face optimization: convert blob URL to raw URL
        // e.g. https://huggingface.co/owner/model/blob/main/file.py -> https://huggingface.co/owner/model/raw/main/file.py
        const hfBlobMatch = url.match(/^https?:\/\/huggingface\.co\/([^/]+\/[^/]+)\/blob\/(.+)$/i);
        if (hfBlobMatch) {
            url = `https://huggingface.co/${hfBlobMatch[1]}/raw/${hfBlobMatch[2]}`;
        }

        // 3. GitHub repository root URL: try fetching README.md directly
        // e.g. https://github.com/owner/repo -> fetch raw README.md
        const githubRepoMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/i);
        if (githubRepoMatch && !['features', 'topics', 'trending', 'collections', 'pricing', 'explore', 'settings', 'notifications'].includes(githubRepoMatch[1].toLowerCase())) {
            const rawReadmeUrl = `https://raw.githubusercontent.com/${githubRepoMatch[1]}/${githubRepoMatch[2]}/main/README.md`;
            try {
                const readmeRes = await fetch(rawReadmeUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                });
                if (readmeRes.ok) {
                    const text = await readmeRes.text();
                    if (text && text.length > 50) {
                        return text.substring(0, 10000);
                    }
                }
            } catch {}
            // Fallback to master branch if main not found
            try {
                const masterReadmeUrl = `https://raw.githubusercontent.com/${githubRepoMatch[1]}/${githubRepoMatch[2]}/master/README.md`;
                const masterRes = await fetch(masterReadmeUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                });
                if (masterRes.ok) {
                    const text = await masterRes.text();
                    if (text && text.length > 50) {
                        return text.substring(0, 10000);
                    }
                }
            } catch {}
        }

        // 4. Hugging Face model/dataset root URL: try fetching Model Card README.md directly
        // e.g. https://huggingface.co/meta-llama/Llama-3-8B -> https://huggingface.co/meta-llama/Llama-3-8B/raw/main/README.md
        const hfRepoMatch = url.match(/^https?:\/\/huggingface\.co\/([^/]+(?:\/[^/]+)?)\/?$/i);
        if (hfRepoMatch && !['models', 'datasets', 'spaces', 'docs', 'pricing', 'blog'].includes(hfRepoMatch[1].toLowerCase())) {
            const rawHfUrl = `https://huggingface.co/${hfRepoMatch[1]}/raw/main/README.md`;
            try {
                const hfRes = await fetch(rawHfUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                });
                if (hfRes.ok) {
                    const text = await hfRes.text();
                    if (text && text.length > 50) {
                        return text.substring(0, 10000);
                    }
                }
            } catch {}
        }

        // Standard fetch
        let bodyText = '';
        let contentType = '';
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml,text/plain,text/markdown;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            });
            if (response.ok) {
                contentType = response.headers.get('content-type') || '';
                bodyText = await response.text();
            }
        } catch {}

        // If raw text or markdown or JSON, return directly without stripping code
        if (bodyText && (contentType.includes('text/plain') || contentType.includes('text/markdown') || url.endsWith('.md') || url.endsWith('.txt'))) {
            return bodyText.substring(0, 10000);
        }

        let cleanText = '';
        if (bodyText) {
            // Extract core content first if HTML
            let mainContent = bodyText;
            const mainMatch = bodyText.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || bodyText.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
            if (mainMatch && mainMatch[1]) {
                mainContent = mainMatch[1];
            }

            // Strip out navigation, headers, scripts, styles, footers, noscript, iframes before extracting text
            cleanText = mainContent
                .replace(/<(script|style|nav|header|footer|noscript|iframe)[^>]*>([\s\S]*?)<\/\1>/gi, ' ')
                .replace(/<(head|title|aside|form|button|figure|svg)[^>]*>([\s\S]*?)<\/\1>/gi, ' ');

            // Preserve code block formatting
            cleanText = cleanText.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, p1) => {
                return '\n```\n' + p1.replace(/<[^>]+>/g, '').trim() + '\n```\n';
            });

            // Strip remaining tags & normalize whitespace
            cleanText = cleanText
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        }

        // Lightweight reader fallback: If raw fetch returns less than 200 characters of text
        // (typical for JS-rendered React/Vue SPAs like sports sites), fetch via Jina Reader
        if (!cleanText || cleanText.length < 200) {
            try {
                const jinaUrl = `https://r.jina.ai/${encodeURI(url)}`;
                const jinaRes = await fetch(jinaUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                        'Accept': 'text/plain,text/markdown;q=0.9,*/*;q=0.8'
                    }
                });
                if (jinaRes.ok) {
                    const jinaText = await jinaRes.text();
                    if (jinaText && jinaText.trim().length > 100) {
                        return jinaText.trim().substring(0, 10000);
                    }
                }
            } catch (jinaErr) {
                console.error(`Jina reader fallback failed for ${url}:`, jinaErr);
            }
        }

        // Truncate to maximum of 10000 characters (~2500 tokens)
        return cleanText ? cleanText.substring(0, 10000) : '';
    } catch (error) {
        console.error(`fetchWebContext failed for ${rawUrl}:`, error);
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
                const docUrl = winner.documentationUrl || winner.homepage || (isPy ? `https://pypi.org/project/${winner.name}/` : `https://www.npmjs.com/package/${winner.name}`);
                let out = `--- DIRECT REGISTRY DOCUMENTATION: ${winner.name}@${winner.version} ---\n`;
                out += `[Source 1]: ${docUrl}\n\n`;
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
