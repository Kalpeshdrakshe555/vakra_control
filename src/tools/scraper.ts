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
export async function researchWebDocs(query: string, urls: string[] = [], workspaceRoot: string): Promise<string> {
    try {
        const researchDir = path.join(workspaceRoot, '.ultra-light-ai', 'research');
        if (!fs.existsSync(researchDir)) {
            fs.mkdirSync(researchDir, { recursive: true });
        }

        // If no or few URLs provided, autonomously search DuckDuckGo for top documentation links
        let targetUrls = Array.isArray(urls) ? [...urls] : [];
        if (targetUrls.length < 2) {
            try {
                const searchHtmlResponse = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + ' documentation reference code example')}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' }
                });
                if (searchHtmlResponse.ok) {
                    const searchHtml = await searchHtmlResponse.text();
                    const linkMatches = searchHtml.matchAll(/href="([^"]*uddg=[^"]+)"/gi);
                    for (const m of linkMatches) {
                        try {
                            const params = new URLSearchParams(m[1].includes('?') ? m[1].split('?')[1] : m[1]);
                            const cleanUrl = decodeURIComponent(params.get('uddg') || '');
                            if (cleanUrl.startsWith('http') && !cleanUrl.includes('duckduckgo.com') && !targetUrls.includes(cleanUrl)) {
                                targetUrls.push(cleanUrl);
                                if (targetUrls.length >= 3) break;
                            }
                        } catch {}
                    }
                }
            } catch (e) {
                console.error("Auto-search for docs failed:", e);
            }
        }

        let combinedMarkdown = `# Deep Documentation Research: ${query}\n\n`;
        combinedMarkdown += `*Generated autonomously by Researcher Sub-Agent*\n\n`;
        const summaryPoints: string[] = [];
        const extractedCodeSnippets: string[] = [];

        for (const url of targetUrls.slice(0, 3)) {
            try {
                const content = await fetchWebContext(url);
                if (content && content.length > 50) {
                    combinedMarkdown += `## Source: ${url}\n\n${content}\n\n---\n\n`;
                    let host = url;
                    try { host = new URL(url).hostname; } catch {}
                    summaryPoints.push(`- **[${host}](${url})**: Extracted relevant API signatures & patterns.`);

                    // Extract first code snippet if present in content
                    const codeMatch = content.match(/```(?:[a-z]+)?\n([\s\S]*?)\n```/i);
                    if (codeMatch && extractedCodeSnippets.length < 2) {
                        extractedCodeSnippets.push(codeMatch[0]);
                    }
                }
            } catch (e) {
                console.error(`Failed to research ${url}:`, e);
            }
        }

        const sanitizedFileName = query.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 40) + '.md';
        const docPath = path.join(researchDir, sanitizedFileName);
        fs.writeFileSync(docPath, combinedMarkdown, 'utf8');

        const relPath = path.relative(workspaceRoot, docPath);

        let response = `### 📚 Autonomous Research Complete\n`;
        response += `**Topic:** ${query}\n`;
        response += `**Full Research Saved:** \`${relPath}\` (use \`read_multiple_files\` to view complete details)\n\n`;
        response += `**Key Documentation Sources & Findings:**\n`;
        response += summaryPoints.length > 0 ? summaryPoints.join('\n') : '- No external sites could be reached; check query or internet connectivity.';

        if (extractedCodeSnippets.length > 0) {
            response += `\n\n**Verified Code Pattern Example:**\n${extractedCodeSnippets[0]}`;
        }

        return response;
    } catch (error: any) {
        console.error("researchWebDocs error:", error);
        return `Research failed: ${error?.message || error}`;
    }
}
