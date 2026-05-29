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

        // Basic code block formatting preservation
        let cleanText = html.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (match, p1) => {
            return '\n```\n' + p1.replace(/<[^>]+>/g, '').trim() + '\n```\n';
        });

        // 1. Strip script, style and head tags including their nested contents
        // 2. Strip all remaining tags
        // 3. Normalize white spaces and trim
        cleanText = cleanText
            .replace(/<(style|script|head|title|nav|footer)[^>]*>([\s\S]*?)<\/\1>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Truncate to maximum of 3000 characters per page
        return cleanText.substring(0, 3000);
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
        // A more lenient regex to capture result blocks in DuckDuckGo HTML
        const resultRegex = /<a class="result__snippet[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = resultRegex.exec(html)) !== null && results.length < 3) {
            let url = match[1];
            // Unescape DuckDuckGo redirect url
            if (url.includes('uddg=')) {
                try {
                    const params = new URLSearchParams(url.split('?')[1]);
                    url = decodeURIComponent(params.get('uddg') || url);
                } catch { /* ignore */ }
            }
            const snippet = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (!url.includes('duckduckgo.com')) {
                results.push({url, snippet});
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
