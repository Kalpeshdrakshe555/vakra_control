import * as fs from 'fs';
import * as path from 'path';

/**
 * Fetches HTML context from a web resource, strips HTML tags, and truncates content.
 * Serves as a zero-dependency local RAG utility.
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
        let cleanText = mainContent.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (match, p1) => {
            return '\n```\n' + p1.replace(/<[^>]+>/g, '').trim() + '\n```\n';
        });

        // 1. Strip noisy tags including their nested contents
        // 2. Strip all remaining HTML tags
        // 3. Normalize white spaces and trim
        cleanText = cleanText
            .replace(/<(style|script|head|title|nav|footer|aside|header|form|button|figure|iframe|noscript|svg)[^>]*>([\s\S]*?)<\/\1>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Truncate to maximum of 2000 characters per page to save tokens
        return cleanText.substring(0, 2000);
    } catch (error) {
        console.error(`fetchWebContext failed for ${url}:`, error);
        return '';
    }
}

/**
 * Performs a free web search using DuckDuckGo HTML interface.
 */
export async function searchWeb(query: string): Promise<string> {
    try {
        const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        if (!response.ok) {
            throw new Error(`Search failed: ${response.status}`);
        }
        const html = await response.text();
        
        const results: {url: string, snippet: string}[] = [];

        // Strategy 1: Standard result__snippet
        const resultRegex1 = /<a class="result__snippet[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        // Strategy 2: result__url or result__a links
        const resultRegex2 = /<a class="result__url"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        // Strategy 3: any link with uddg parameter
        const resultRegex3 = /href="([^"]*uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

        const processMatch = (rawUrl: string, rawSnippet: string) => {
            let url = rawUrl;
            if (url.includes('uddg=')) {
                try {
                    const params = new URLSearchParams(url.includes('?') ? url.split('?')[1] : url);
                    url = decodeURIComponent(params.get('uddg') || url);
                } catch { /* ignore */ }
            }
            if (url.startsWith('//')) url = 'https:' + url;
            const snippet = rawSnippet.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (url.startsWith('http') && !url.includes('duckduckgo.com') && !results.some(r => r.url === url)) {
                results.push({ url, snippet });
            }
        };

        let match;
        while ((match = resultRegex1.exec(html)) !== null && results.length < 3) {
            processMatch(match[1], match[2]);
        }
        if (results.length < 3) {
            while ((match = resultRegex2.exec(html)) !== null && results.length < 3) {
                processMatch(match[1], match[2]);
            }
        }
        if (results.length < 3) {
            while ((match = resultRegex3.exec(html)) !== null && results.length < 3) {
                processMatch(match[1], match[2]);
            }
        }
        
        if (results.length === 0) {
            return "No search results found.";
        }
        
        const fullResults = await Promise.all(results.map(async (r, idx) => {
            try {
                const pageContent = await fetchWebContext(r.url);
                if (pageContent && pageContent.length > 300) {
                    return `[Source ${idx+1}] ${r.url}\n${pageContent}`;
                }
            } catch (err) {}
            return `[Source ${idx+1}] ${r.url}\nSnippet: ${r.snippet}`;
        }));
        
        return "--- WEB SEARCH RESULTS FOR '" + query + "' ---\n\n" + fullResults.join('\n\n---\n\n');
    } catch (error) {
        console.error("Search error:", error);
        return "Search failed.";
    }
}

/**
 * Autonomous Deep Doc Researcher Sub-Agent
 * Scrapes URLs, strips HTML noise, saves full markdown in `.ultra-light-ai/research/`
 * and returns a concise ~150-token executive summary.
 */
export async function researchWebDocs(query: string, urls: string[], workspaceRoot: string): Promise<string> {
    try {
        const researchDir = path.join(workspaceRoot, '.ultra-light-ai', 'research');
        if (!fs.existsSync(researchDir)) {
            fs.mkdirSync(researchDir, { recursive: true });
        }

        let combinedMarkdown = `# Deep Web Research: ${query}\n\n`;
        const summaryPoints: string[] = [];

        for (const url of urls.slice(0, 3)) {
            try {
                const content = await fetchWebContext(url);
                if (content) {
                    combinedMarkdown += `## Source: ${url}\n\n${content}\n\n---\n\n`;
                    summaryPoints.push(`- Extracted documentation from [${new URL(url).hostname}](${url})`);
                }
            } catch (e) {
                console.error(`Failed to research ${url}`, e);
            }
        }

        const sanitizedFileName = query.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 40) + '.md';
        const docPath = path.join(researchDir, sanitizedFileName);
        fs.writeFileSync(docPath, combinedMarkdown, 'utf8');

        const relPath = path.relative(workspaceRoot, docPath);

        return `### 📚 Deep Doc Research Completed
**Query:** ${query}
**Saved File:** \`${relPath}\`

**Executive Summary:**
${summaryPoints.join('\n') || '- No active content scraped.'}
- Full scraped documentation saved in \`${relPath}\`. Main model can consult this file directly.`;
    } catch (error: any) {
        return `Research Error: ${error?.message || error}`;
    }
}
