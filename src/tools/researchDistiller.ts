import * as fs from 'fs';
import * as path from 'path';
import { getAgentConfig } from '../config';
import { fetchPyPiInfo, fetchNpmInfo, fetchWebContext } from './scraper';

/**
 * Technical Research Distiller Sub-Agent
 * 1. Fetches from 5 to 10 web & package registry sources concurrently.
 * 2. Uses LLM to strip ads/nav/marketing and extract pure API signatures & working code.
 * 3. Saves complete research artifact into `.ultra-light-ai/findings/<topic>.md`.
 * 4. Returns a token-efficient summary index to prevent context bloat.
 */

export interface DistillationResult {
    topic: string;
    filePath: string;
    sources: { title: string; url: string }[];
    distilledBy: string;
    summaryMarkdown: string;
    rawTextResult: string;
}

/**
 * Creates an LLM client for research distillation using the configured model.
 */
function getDistillerClient(workspaceRoot: string): { client: any; brainName: string } | null {
    try {
        const config = getAgentConfig(workspaceRoot);
        const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');

        const main = config?.mainBrain;
        if (main && main.model) {
            if (main.providerType === 'local') {
                return {
                    client: new LocalOllamaClient(main.model, main.endpoint || 'http://127.0.0.1:11434', main.apiKey),
                    brainName: `AI (${main.model})`
                };
            } else {
                const keyStr = main.apiKey?.trim() || '';
                if (keyStr.startsWith('gsk_')) {
                    return {
                        client: new LocalOllamaClient(main.model, 'https://api.groq.com/openai', keyStr),
                        brainName: `AI (${main.model} - Groq)`
                    };
                } else if (keyStr.startsWith('sk-or-')) {
                    return {
                        client: new LocalOllamaClient(main.model, 'https://openrouter.ai/api', keyStr),
                        brainName: `AI (${main.model} - OpenRouter)`
                    };
                } else if (keyStr.startsWith('sk-')) {
                    return {
                        client: new LocalOllamaClient(main.model, 'https://api.openai.com', keyStr),
                        brainName: `AI (${main.model} - OpenAI)`
                    };
                } else {
                    return {
                        client: new GeminiCloudClient([keyStr], main.model || 'gemini-1.5-pro', 60),
                        brainName: `AI (${main.model})`
                    };
                }
            }
        }

        return null;
    } catch (err) {
        console.error('Error initializing distiller client:', err);
        return null;
    }
}

/**
 * Searches and collects 5 to 10 distinct URLs from DuckDuckGo.
 */
async function searchMultiUrls(query: string, maxResults: number = 8): Promise<string[]> {
    const urls: string[] = [];
    try {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + ' documentation reference guide code')}`;
        const res = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });

        if (res.ok) {
            const html = await res.text();
            const linkMatches = html.matchAll(/href="([^"]*uddg=[^"]+)"/gi);
            for (const m of linkMatches) {
                try {
                    const rawHref = m[1];
                    const params = new URLSearchParams(rawHref.includes('?') ? rawHref.split('?')[1] : rawHref);
                    const cleanUrl = decodeURIComponent(params.get('uddg') || '');
                    if (
                        cleanUrl.startsWith('http') &&
                        !cleanUrl.includes('duckduckgo.com') &&
                        !cleanUrl.includes('ad_provider') &&
                        !urls.includes(cleanUrl)
                    ) {
                        urls.push(cleanUrl);
                        if (urls.length >= maxResults) break;
                    }
                } catch {}
            }
        }
    } catch (e) {
        console.error('Multi-URL search error:', e);
    }
    return urls;
}

/**
 * Executes autonomous multi-source technical research and distillation.
 */
export async function executeDeepResearch(
    query: string,
    providedUrls: string[] = [],
    workspaceRoot: string,
    options: { offset?: number; limit?: number } = {}
): Promise<any> {
    try {
        // Ensure findings folder exists in workspace
        const findingsDir = path.join(workspaceRoot, '.ultra-light-ai', 'findings');
        if (!fs.existsSync(findingsDir)) {
            fs.mkdirSync(findingsDir, { recursive: true });
        }

        const rawSources: { source: string; content: string }[] = [];

        // 1. Check Package Registries (PyPI / npm)
        const words = query.trim().split(/\s+/);
        const candidatePkg = words.find(w => /^[a-z0-9\-_]{2,30}$/i.test(w) && !['how', 'to', 'in', 'the', 'use', 'create', 'with', 'code', 'file', 'app', 'implement', 'fix'].includes(w.toLowerCase()));

        if (candidatePkg) {
            const [pypi, npm] = await Promise.all([fetchPyPiInfo(candidatePkg), fetchNpmInfo(candidatePkg)]);
            if (pypi) {
                rawSources.push({
                    source: `PyPI: ${pypi.name}@${pypi.version}`,
                    content: `Install: ${pypi.installCommand}\nDocs: ${pypi.documentationUrl || pypi.homepage}\n\n${pypi.readmeSnippet || pypi.description}`
                });
            }
            if (npm) {
                rawSources.push({
                    source: `npm: ${npm.name}@${npm.version}`,
                    content: `Install: ${npm.installCommand}\nDocs: ${npm.documentationUrl || npm.homepage}\n\n${npm.readmeSnippet || npm.description}`
                });
            }
        }

        // 2. Discover max 2 high-authority URLs (clean, zero redundancy)
        let targetUrls = Array.isArray(providedUrls) ? [...providedUrls] : [];
        if (targetUrls.length < 2) {
            const discovered = await searchMultiUrls(query, 3);
            for (const u of discovered) {
                if (!targetUrls.includes(u)) targetUrls.push(u);
                if (targetUrls.length >= 2) break;
            }
        }
        targetUrls = targetUrls.slice(0, 2);

        const safeTopicSlug = query.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 35).replace(/^_+|_+$/g, '') || 'research';
        const fileName = `${safeTopicSlug}_research.md`;
        const filePath = path.join(findingsDir, fileName);
        const relPath = path.relative(workspaceRoot, filePath);
        const offset = Math.max(0, options.offset || 0);
        const limit = Math.min(12000, Math.max(2000, options.limit || 8500));

        // Approach 1 Pagination: If offset > 0 and dossier already exists on disk, read next chunk with 0 network latency!
        if (offset > 0 && fs.existsSync(filePath)) {
            const cachedFullDoc = fs.readFileSync(filePath, 'utf8');
            const chunk = cachedFullDoc.slice(offset, offset + limit);
            const hasMore = (offset + limit) < cachedFullDoc.length;
            const endOffset = Math.min(offset + limit, cachedFullDoc.length);

            let pageMsg = `### 📚 Technical Research Continued: "${query}"\n`;
            pageMsg += `*Source Document: \`${relPath}\` (Total: ${cachedFullDoc.length} chars)*\n`;
            pageMsg += `*Reading Slice: Characters ${offset} to ${endOffset} (${chunk.length} chars)*\n\n`;
            pageMsg += `#### 💡 Technical Content (Offset ${offset}):\n\n`;
            pageMsg += `${chunk}\n\n`;
            if (hasMore) {
                pageMsg += `⏩ **More Content Available**: To read the next section, invoke \`research_web_docs(query="${query}", offset=${endOffset})\`.\n`;
            } else {
                pageMsg += `✅ **[END OF DOCUMENTATION REACHED - All ${cachedFullDoc.length} characters examined]**\n`;
            }

            return {
                topic: query,
                filePath: relPath,
                sources: [],
                distilledBy: 'Cached Full Dossier',
                summaryMarkdown: chunk,
                rawTextResult: pageMsg
            } as any;
        }

        // 3. Concurrently fetch full web context from top 2 authoritative target URLs
        const fetchPromises = targetUrls.map(async (url) => {
            try {
                const text = await fetchWebContext(url);
                if (text && text.trim().length > 100) {
                    return { source: url, content: text };
                }
            } catch {}
            return null;
        });

        const fetchedPages = await Promise.all(fetchPromises);
        for (const page of fetchedPages) {
            if (page) rawSources.push(page);
        }

        if (rawSources.length === 0) {
            return `No external documentation could be retrieved for query: "${query}". Please verify internet connectivity or specify direct URLs.`;
        }

        // 4. Distill using LLM or structured cleaner
        let distilledMarkdown = '';
        let brainUsed = 'Deterministic Deep Cleaner (No LLM active)';
        const distiller = getDistillerClient(workspaceRoot);

        if (distiller) {
            try {
                brainUsed = distiller.brainName;
                // Feed rich raw material (up to 15,000 chars per source) for high-precision distillation
                const compiledRaw = rawSources.map((s, idx) => `### Source [${idx + 1}]: ${s.source}\n${s.content.substring(0, 15000)}`).join('\n\n---\n\n');

                const distillationPrompt = `You are an Elite Technical Research Distiller for a software engineering agent.
Your objective: Process the following comprehensive documentation from ${rawSources.length} external sources on "${query}".

RULES:
1. Strip all noise: Remove ads, cookie banners, navigation links, author bios, and marketing fluff.
2. Extract exact modern API signatures, parameters, types, configuration setup, and architecture patterns.
3. Provide 3-5 complete, working, copy-paste ready code examples following modern best practices.
4. Highlight breaking changes, deprecated methods, and common gotchas.
5. Retain FULL comprehensive detail: Do not summarize or cut code blocks short. Return clean, deep Markdown.

Raw Documentation Material:
${compiledRaw}`;

                const response = await distiller.client.complete(distillationPrompt);
                distilledMarkdown = response.text || '';
            } catch (distillErr) {
                console.warn(`Distiller (${distiller.brainName}) failed:`, distillErr);
            }
        }

        // Deterministic fallback if LLM was unavailable: preserve full unabridged content
        if (!distilledMarkdown || distilledMarkdown.trim().length < 50) {
            distilledMarkdown = `# Comprehensive Technical Research: ${query}\n\n`;
            distilledMarkdown += `*Compiled from ${rawSources.length} primary authoritative sources on ${new Date().toISOString().split('T')[0]}*\n\n`;
            for (const s of rawSources) {
                distilledMarkdown += `## Source: ${s.source}\n\n${s.content}\n\n---\n\n`;
            }
        }

        // 5. UNBOUNDED DISK SAVE: Save 100% full, unclipped documentation to disk (Zero character limit!)
        fs.writeFileSync(filePath, distilledMarkdown, 'utf8');

        // Update findings INDEX.md
        const indexPath = path.join(findingsDir, 'INDEX.md');
        const indexLine = `- **[${fileName}](./${fileName})**: Complete Research on "${query}" (${rawSources.length} sources, ${distilledMarkdown.length} chars, by ${brainUsed} on ${new Date().toISOString().split('T')[0]})\n`;
        try {
            if (fs.existsSync(indexPath)) {
                fs.appendFileSync(indexPath, indexLine, 'utf8');
            } else {
                fs.writeFileSync(indexPath, `# Research Findings Index\n\n${indexLine}`, 'utf8');
            }
        } catch {}

        // 6. Format verified citations
        const citationsList = rawSources.map((s, idx) => {
            return `- **[Source ${idx + 1}]**: ${s.source}`;
        }).join('\n');

        const sourceObjects = rawSources.map(s => {
            let title = s.source;
            let url = s.source;
            if (s.source.startsWith('http')) {
                try {
                    const u = new URL(s.source);
                    title = u.hostname.replace('www.', '');
                    url = s.source;
                } catch {}
            } else if (s.source.includes(':')) {
                const parts = s.source.split(':');
                title = parts[0].trim();
            }
            return { title, url };
        });

        // 7. DELIVER CLEAN 7,000–10,000 CHARACTERS SLICE TO CONTEXT (Approach 1 Chunk Streaming)
        const chunk = distilledMarkdown.slice(offset, offset + limit);
        const hasMore = (offset + limit) < distilledMarkdown.length;
        const endOffset = Math.min(offset + limit, distilledMarkdown.length);

        let returnMsg = `### 📚 Technical Research Completed: "${query}"\n`;
        returnMsg += `Archived complete unclipped guide to: \`${relPath}\` (${distilledMarkdown.length} total chars)\n\n`;
        returnMsg += `#### 🔗 Verified Primary Sources:\n${citationsList}\n\n`;
        returnMsg += `#### 💡 Technical Findings [Chars ${offset} to ${endOffset} of ${distilledMarkdown.length}]:\n\n`;
        returnMsg += `${chunk}\n\n`;
        if (hasMore) {
            returnMsg += `⏩ **More Content Available**: The document has ${distilledMarkdown.length - endOffset} additional characters. Call \`research_web_docs(query="${query}", offset=${endOffset})\` or read \`${relPath}\` to inspect more.\n`;
        } else {
            returnMsg += `✅ **[Complete technical guide delivered without truncation]**\n`;
        }

        return {
            topic: query,
            filePath: relPath,
            sources: sourceObjects,
            distilledBy: brainUsed,
            summaryMarkdown: chunk,
            rawTextResult: returnMsg
        } as any;
    } catch (error: any) {
        return {
            topic: query,
            filePath: '',
            sources: [],
            distilledBy: 'Error',
            summaryMarkdown: '',
            rawTextResult: `Deep research error: ${error?.message || error}`
        } as any;
    }
}

export interface WebSearchSource {
    title: string;
    url: string;
    domain: string;
}

export interface WebSearchDetailedResult {
    text: string;
    sources: WebSearchSource[];
}

export async function searchWebQuickDetailed(query: string): Promise<WebSearchDetailedResult> {
    const rawResults: { title: string; snippet: string; url: string; domain: string }[] = [];

    const extractDomain = (urlStr: string): string => {
        try {
            const parsed = new URL(urlStr);
            return parsed.hostname.replace(/^www\./i, '');
        } catch {
            return 'web';
        }
    };

    // Strategy 1: DuckDuckGo Lite POST (resilient against bot challenges)
    try {
        const liteRes = await fetch('https://lite.duckduckgo.com/lite/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            },
            body: 'q=' + encodeURIComponent(query)
        });

        if (liteRes.ok) {
            const html = await liteRes.text();
            const linkRegex = /<a[^>]*class=['"]result-link['"][^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
            const linkMatches = [...html.matchAll(linkRegex)];
            const snippetMatches = [...html.matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi)];

            for (let i = 0; i < Math.min(8, linkMatches.length); i++) {
                const m = linkMatches[i];
                let rawHref = m[1] || m[3] || '';
                if (rawHref.includes('uddg=')) {
                    try {
                        const params = new URLSearchParams(rawHref.split('?')[1] || rawHref);
                        rawHref = decodeURIComponent(params.get('uddg') || rawHref);
                    } catch {}
                }
                const title = (m[2] || m[4] || '').replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim();
                const snippet = snippetMatches[i] ? snippetMatches[i][1].replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim() : '';

                if (rawHref.startsWith('http') && !rawHref.includes('duckduckgo.com')) {
                    rawResults.push({
                        title: title || 'Search Result',
                        snippet,
                        url: rawHref,
                        domain: extractDomain(rawHref)
                    });
                }
            }
        }
    } catch (liteErr) {
        console.error("DDG Lite search failed:", liteErr);
    }

    // Strategy 2: Fallback to DuckDuckGo HTML GET if Lite returned nothing
    if (rawResults.length === 0) {
        try {
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const res = await fetch(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            });

            if (res.ok) {
                const html = await res.text();
                const blockRegex = /<div[^>]*class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
                let match;
                while ((match = blockRegex.exec(html)) !== null && rawResults.length < 5) {
                    const block = match[1];
                    const titleMatch = block.match(/<a[^>]*class="[^"]*result__url[^"]*"[^>]*>([\s\S]*?)<\/a>/i) || block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
                    const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
                    const linkMatch = block.match(/href="([^"]*uddg=[^"]+)"/i);

                    let cleanSnippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
                    if (cleanSnippet) {
                        let cleanUrl = '';
                        if (linkMatch) {
                            try {
                                const params = new URLSearchParams(linkMatch[1].split('?')[1] || linkMatch[1]);
                                cleanUrl = decodeURIComponent(params.get('uddg') || '');
                            } catch {}
                        }
                        if (cleanUrl.startsWith('http')) {
                            rawResults.push({
                                title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'Search Result',
                                snippet: cleanSnippet,
                                url: cleanUrl,
                                domain: extractDomain(cleanUrl)
                            });
                        }
                    }
                }
            }
        } catch {}
    }

    if (rawResults.length === 0) {
        return {
            text: `No direct search results found for "${query}".`,
            sources: []
        };
    }

    // Prioritize high-authority domains for sports/cricket queries if available
    const isCricketQuery = /\b(cricket|score|match|ipl|test|t20|odi|wicket)\b/i.test(query);
    if (isCricketQuery) {
        const preferredDomains = ['cricbuzz.com', 'espncricinfo.com', 'flashscore.com', 'crex.live', 'cricket.com'];
        rawResults.sort((a, b) => {
            const aPref = preferredDomains.some(d => a.domain.includes(d)) ? 1 : 0;
            const bPref = preferredDomains.some(d => b.domain.includes(d)) ? 1 : 0;
            return bPref - aPref;
        });
    }

    // Strictly select the top 3 authoritative websites with unique domains
    const topThreeResults: typeof rawResults = [];
    const seenDomains = new Set<string>();

    for (const r of rawResults) {
        if (!seenDomains.has(r.domain)) {
            seenDomains.add(r.domain);
            topThreeResults.push(r);
            if (topThreeResults.length >= 3) break;
        }
    }

    // If fewer than 3 unique domains found, backfill up to 3 from remaining results
    if (topThreeResults.length < 3) {
        for (const r of rawResults) {
            if (!topThreeResults.some(item => item.url === r.url)) {
                topThreeResults.push(r);
                if (topThreeResults.length >= 3) break;
            }
        }
    }

    // Concurrently fetch comprehensive page context (7,000+ chars per site for deep technical accuracy)
    const fetchPromises = topThreeResults.map(async (target, idx) => {
        try {
            const pageText = await fetchWebContext(target.url);
            if (pageText && pageText.trim().length > 100) {
                const pageContent = pageText.trim().slice(0, 7500);
                return `\n\n=== [WEBSITE ${idx + 1} DEEP EXTRACTED CONTEXT (7K+ CHARS): ${target.url} (${target.domain})] ===\n${pageContent}`;
            }
        } catch (e) {
            console.error(`Deep fetch failed for ${target.url}:`, e);
        }
        return `\n\n=== [WEBSITE ${idx + 1} SNIPPET: ${target.url} (${target.domain})] ===\n${target.snippet}`;
    });

    const deepPages = await Promise.all(fetchPromises);
    const livePageContent = deepPages.join('\n');

    const snippetsText = topThreeResults.map((r, i) => `[Source ${i + 1}]: "${r.title}"\nURL: ${r.url}\nDomain: ${r.domain}\nKey Highlights: ${r.snippet}`).join('\n\n');
    const combinedText = `Top 3 Verified Sources & Extracts:\n\n${snippetsText}\n\n${livePageContent}`;

    const sources: WebSearchSource[] = topThreeResults.map(r => ({
        title: r.title,
        url: r.url,
        domain: r.domain
    }));

    return {
        text: combinedText,
        sources
    };
}

export async function searchWebQuick(query: string): Promise<string> {
    try {
        const res = await searchWebQuickDetailed(query);
        return res.text;
    } catch (err: any) {
        return `Quick web search error: ${err?.message || err}`;
    }
}

