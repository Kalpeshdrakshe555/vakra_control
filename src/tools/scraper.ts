/**
 * Fetches HTML context from a web resource, strips HTML tags, and truncates content.
 * Serves as a zero-dependency local RAG utility.
 */
export async function fetchWebContext(url: string): Promise<string> {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch web resource. HTTP status: ${response.status}`);
        }

        const html = await response.text();

        // 1. Strip script, style and head tags including their nested contents
        // 2. Strip all remaining tags
        // 3. Normalize white spaces and trim
        const cleanText = html
            .replace(/<(style|script|head|title)[^>]*>([\s\S]*?)<\/\1>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Truncate to maximum of 2000 characters to stay within context tokens configuration limits
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
        
        const results: string[] = [];
        // A more lenient regex to capture result blocks in DuckDuckGo HTML
        const resultRegex = /<a class="result__snippet[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        let count = 0;
        while ((match = resultRegex.exec(html)) !== null && count < 5) {
            let url = match[1];
            // Unescape DuckDuckGo redirect url
            if (url.includes('uddg=')) {
                try {
                    const params = new URLSearchParams(url.split('?')[1]);
                    url = decodeURIComponent(params.get('uddg') || url);
                } catch { /* ignore */ }
            }
            const snippet = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            results.push(`[Source ${count+1}] ${url}\n${snippet}`);
            count++;
        }
        
        if (results.length === 0) {
            return "No search results found.";
        }
        
        return "--- WEB SEARCH RESULTS FOR '" + query + "' ---\n\n" + results.join('\n\n');
    } catch (error) {
        console.error("Search error:", error);
        return "Search failed.";
    }
}
