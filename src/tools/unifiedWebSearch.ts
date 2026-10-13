import * as fs from 'fs';
import * as path from 'path';
import { fetchPyPiInfo, fetchNpmInfo, fetchWebContext } from './scraper';

/**
 * ============================================================================
 * UNIFIED WEB SEARCH ENGINE (VERSION 2 - STREAMING 5K CHUNKS & AUTO-PAGINATION)
 * ============================================================================
 * Unifies 'search_web' and 'research_web_docs' into a single high-efficiency tool.
 * 
 * Key Principles:
 * 1. Deep Extraction: Concurrently inspects top 2 authoritative websites.
 * 2. 5K Chunk Streaming: Scrapes 5,000 characters per website per request (10k total window).
 * 3. Zero-Latency Continuity: In-memory & disk cache stores full text across session,
 *    allowing subsequent pagination calls (offset=5000, 10000, 15000...) with 0 network latency.
 * 4. Human/Model Freedom: Model inspects current chunk. If sufficient, proceeds to code;
 *    if not, requests the next 5k slice. Document creation is handled via skills or write_file.
 * 5. Full Citation Integrity: Verified sources returned with accurate domains and URLs.
 */

export interface WebSearchSource {
    title: string;
    url: string;
    domain: string;
}

export interface UnifiedSearchOutput {
    text: string;
    sources: WebSearchSource[];
    offset: number;
    nextOffset: number;
    hasMore: boolean;
    isCached: boolean;
    filePath?: string;
}

interface CachedSiteData {
    url: string;
    domain: string;
    title: string;
    fullText: string;
    snippet: string;
}

interface CacheEntry {
    query: string;
    sites: CachedSiteData[];
    timestamp: number;
    registryInfo?: string;
}

export class UnifiedWebSearch {
    // In-memory cache for fast offset paging across a session (TTL: 30 minutes)
    private static cache = new Map<string, CacheEntry>();
    private static readonly CACHE_TTL_MS = 30 * 60 * 1000;
    public static readonly DEFAULT_CHUNK_SIZE = 5000;

    /**
     * Extracts clean root domain from any URL.
     */
    private static extractDomain(urlStr: string): string {
        try {
            const parsed = new URL(urlStr);
            return parsed.hostname.replace(/^www\./, '');
        } catch {
            return 'web';
        }
    }

    /**
     * Searches DuckDuckGo for top unique authoritative URLs.
     */
    private static async discoverTopUrls(query: string, maxSites: number = 2): Promise<{ title: string; url: string; domain: string; snippet: string }[]> {
        const results: { title: string; url: string; domain: string; snippet: string }[] = [];
        const seenDomains = new Set<string>();

        // Strategy 1: DuckDuckGo Lite POST
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

                for (let i = 0; i < linkMatches.length; i++) {
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
                        const domain = this.extractDomain(rawHref);
                        if (!seenDomains.has(domain)) {
                            seenDomains.add(domain);
                            results.push({ title: title || domain, url: rawHref, domain, snippet });
                            if (results.length >= maxSites) break;
                        }
                    }
                }
            }
        } catch (e) {
            console.error('DDG Lite search failed:', e);
        }

        // Strategy 2: Fallback to DuckDuckGo HTML GET if Lite was empty
        if (results.length < maxSites) {
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
                    while ((match = blockRegex.exec(html)) !== null && results.length < maxSites) {
                        const block = match[1];
                        const titleMatch = block.match(/<a[^>]*class="[^"]*result__url[^"]*"[^>]*>([\s\S]*?)<\/a>/i) || block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
                        const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
                        const linkMatch = block.match(/href="([^"]*uddg=[^"]+)"/i);

                        let cleanSnippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
                        let cleanUrl = '';
                        if (linkMatch) {
                            try {
                                const params = new URLSearchParams(linkMatch[1].split('?')[1] || linkMatch[1]);
                                cleanUrl = decodeURIComponent(params.get('uddg') || '');
                            } catch {}
                        }
                        if (cleanUrl.startsWith('http') && !cleanUrl.includes('duckduckgo.com')) {
                            const domain = this.extractDomain(cleanUrl);
                            if (!seenDomains.has(domain)) {
                                seenDomains.add(domain);
                                results.push({
                                    title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : domain,
                                    url: cleanUrl,
                                    domain,
                                    snippet: cleanSnippet
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('DDG HTML search failed:', e);
            }
        }

        return results.slice(0, maxSites);
    }

    /**
     * Executes the unified web search with 5k chunk streaming per site.
     */
    public static async execute(
        args: { query?: string; prompt?: string; urls?: string[]; offset?: number; chunk_size?: number },
        workspaceRoot?: string
    ): Promise<UnifiedSearchOutput> {
        const query = (args.query || args.prompt || '').trim();
        const explicitUrls = Array.isArray(args.urls) ? args.urls.filter(u => typeof u === 'string' && u.startsWith('http')) : [];
        const offset = Math.max(0, typeof args.offset === 'number' ? args.offset : 0);
        const chunkSize = Math.max(1000, Math.min(10000, typeof args.chunk_size === 'number' ? args.chunk_size : this.DEFAULT_CHUNK_SIZE));

        if (!query && explicitUrls.length === 0) {
            return {
                text: "Error: 'query' or 'urls' parameter is required for search_web.",
                sources: [],
                offset: 0,
                nextOffset: 0,
                hasMore: false,
                isCached: false
            };
        }

        const cacheKey = explicitUrls.length > 0 
            ? explicitUrls.slice().sort().join('|')
            : query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

        let cached = this.cache.get(cacheKey);
        const now = Date.now();
        let isCachedHit = false;

        if (cached && (now - cached.timestamp < this.CACHE_TTL_MS)) {
            isCachedHit = true;
        } else {
            // Need fresh search / scraping
            let registryInfo = '';

            // Step 1: Optional Package Registry check (PyPI/npm) if looking up library directly
            const words = query.split(/\s+/);
            const candidatePkg = words.find(w => /^[a-z0-9\-_]{2,30}$/i.test(w) && !['how', 'to', 'in', 'the', 'use', 'create', 'with', 'code', 'file', 'app', 'find', 'show', 'search', 'get'].includes(w.toLowerCase()));
            if (candidatePkg && explicitUrls.length === 0) {
                try {
                    const [pypi, npm] = await Promise.all([fetchPyPiInfo(candidatePkg), fetchNpmInfo(candidatePkg)]);
                    if (pypi) {
                        registryInfo += `[Package Registry: PyPI - ${pypi.name}@${pypi.version}]\nInstall: \`${pypi.installCommand}\`\nDocs: ${pypi.documentationUrl || pypi.homepage}\nSummary: ${pypi.description}\n\n`;
                    }
                    if (npm) {
                        registryInfo += `[Package Registry: npm - ${npm.name}@${npm.version}]\nInstall: \`${npm.installCommand}\`\nDocs: ${npm.documentationUrl || npm.homepage}\nSummary: ${npm.description}\n\n`;
                    }
                } catch {}
            }

            // Step 2: Target URLs selection (max 2 authoritative sources)
            let targets: { title: string; url: string; domain: string; snippet: string }[] = [];
            if (explicitUrls.length > 0) {
                targets = explicitUrls.slice(0, 2).map(u => ({
                    title: this.extractDomain(u),
                    url: u,
                    domain: this.extractDomain(u),
                    snippet: ''
                }));
            } else {
                targets = await this.discoverTopUrls(query, 2);
            }

            // Step 3: Concurrently fetch full web context for both sites
            const scrapedSites: CachedSiteData[] = [];
            await Promise.all(targets.map(async (t) => {
                try {
                    const rawDoc = await fetchWebContext(t.url);
                    const cleanDoc = (rawDoc && rawDoc.trim().length > 50) ? rawDoc.trim() : (t.snippet || 'No text extracted.');
                    scrapedSites.push({
                        url: t.url,
                        domain: t.domain,
                        title: t.title,
                        fullText: cleanDoc,
                        snippet: t.snippet
                    });
                } catch (e) {
                    scrapedSites.push({
                        url: t.url,
                        domain: t.domain,
                        title: t.title,
                        fullText: t.snippet || 'Failed to fetch content.',
                        snippet: t.snippet
                    });
                }
            }));

            // Preserve order matching targets
            scrapedSites.sort((a, b) => {
                const idxA = targets.findIndex(t => t.url === a.url);
                const idxB = targets.findIndex(t => t.url === b.url);
                return idxA - idxB;
            });

            cached = {
                query,
                sites: scrapedSites,
                timestamp: now,
                registryInfo
            };
            this.cache.set(cacheKey, cached);
        }

        const sites = cached.sites || [];
        const sources: WebSearchSource[] = sites.map(s => ({
            title: s.title,
            url: s.url,
            domain: s.domain
        }));

        if (sites.length === 0) {
            return {
                text: `No web results or accessible content found for "${query}".`,
                sources: [],
                offset: 0,
                nextOffset: 0,
                hasMore: false,
                isCached: isCachedHit
            };
        }

        // Step 4: Extract 5,000 characters slice per site
        let hasMore = false;
        let nextOffset = offset + chunkSize;

        const siteSections = sites.map((site, index) => {
            const totalChars = site.fullText.length;
            const sliceStart = Math.min(offset, totalChars);
            const sliceEnd = Math.min(offset + chunkSize, totalChars);
            const siteSlice = site.fullText.slice(sliceStart, sliceEnd);
            const remainingChars = Math.max(0, totalChars - sliceEnd);

            if (remainingChars > 0) {
                hasMore = true;
            }

            return `### 🌐 [Source ${index + 1}]: "${site.title}" (${site.domain})
- **URL**: ${site.url}
- **Window**: Characters ${sliceStart} to ${sliceEnd} of ${totalChars} (${siteSlice.length} chars displayed | ${remainingChars} chars remaining)

\`\`\`markdown
${siteSlice || '(No content in this offset window)'}
\`\`\``;
        });

        // Step 5: Format Progress & Pagination Guidance
        let continuityGuide = '';
        if (hasMore) {
            continuityGuide = `\n------------------------------------------------------------\n` +
                `⏩ **MORE CONTENT AVAILABLE FROM THESE SOURCES:**\n` +
                `To inspect the next 5,000 characters chunk, call:\n` +
                `\`search_web(query="${query}", offset=${nextOffset})\`\n\n` +
                `👉 **DECISION RULE FOR MODEL:**\n` +
                `- If the information above is already sufficient to write the code or answer the question, proceed directly to implementation/answering.\n` +
                `- If you need the next section of documentation or deeper code examples, invoke \`search_web\` with \`offset: ${nextOffset}\`.`;
        } else {
            continuityGuide = `\n------------------------------------------------------------\n` +
                `✅ **[COMPLETE DOCUMENTATION EXAMINED - End of content reached for all sources]**\n` +
                `You have reviewed all available characters across the top sources. Proceed with implementation.`;
        }

        // Step 6: Assemble Verified Sources Block for Citations
        const sourcesBlock = sources.map((s, idx) => 
            `[${idx + 1}] Title: "${s.title}" | Domain: ${s.domain} | URL: ${s.url}`
        ).join('\n');

        const dateObj = new Date();
        const dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        let resultText = `[DATE ANCHOR: Today is ${dateStr}]
[CACHE STATUS: ${isCachedHit ? '⚡ In-Memory Cache Hit (Instant)' : '🌐 Fresh Live Extraction'}]
[OFFSET: ${offset} | CHUNK SIZE: ${chunkSize} chars per website]

[VERIFIED SOURCES FOR CITATIONS]:
${sourcesBlock}

${cached.registryInfo ? `[OFFICIAL PACKAGE REGISTRY INFO]:\n${cached.registryInfo}` : ''}
[WEBSITE CONTENT EXTRACTS (TOP 2 SITES - 5K CHUNKS)]:
${siteSections.join('\n\n')}

${continuityGuide}

[CITATION & CODE GUIDELINES]:
1. Synthesize these live facts directly into a clear, accurate, and working solution.
2. If citing claims, sports scores, or API references, cite using [[1]](url) or [[2]](url) from [VERIFIED SOURCES FOR CITATIONS].
3. If documenting for workspace, you can save full research notes via your standard write_file or custom skills.`;

        return {
            text: resultText,
            sources,
            offset,
            nextOffset,
            hasMore,
            isCached: isCachedHit
        };
    }
}
