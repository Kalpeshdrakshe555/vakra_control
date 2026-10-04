import * as fs from 'fs';
import * as path from 'path';
import { getAgentConfig } from '../config';
import { fetchPyPiInfo, fetchNpmInfo, fetchWebContext } from './scraper';

/**
 * Technical Research Distiller Sub-Agent
 * 1. Fetches from 5 to 10 web & package registry sources concurrently.
 * 2. Uses Scout Brain (LLM) to strip ads/nav/marketing and extract pure API signatures & working code.
 * 3. Falls back seamlessly to Main Brain if Scout Brain is absent, unconfigured, or hits token/rate limits.
 * 4. Saves complete research artifact into `.ultra-light-ai/findings/<topic>.md`.
 * 5. Returns a token-efficient summary index to the Main Brain to prevent context bloat.
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
 * Creates an LLM client for distillation with automatic fallback from Scout Brain -> Main Brain.
 */
function getDistillerClient(workspaceRoot: string): { client: any; brainName: string } | null {
    try {
        const config = getAgentConfig(workspaceRoot);
        const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');

        // Tier 1: Try Support Brain (Scout)
        const support = config?.supportBrain;
        if (support && support.model) {
            if (support.providerType === 'local') {
                return {
                    client: new LocalOllamaClient(support.model, support.endpoint || 'http://127.0.0.1:11434', support.apiKey),
                    brainName: `Scout Brain (${support.model})`
                };
            } else {
                const keyStr = support.apiKey?.trim() || '';
                if (keyStr.startsWith('gsk_')) {
                    return {
                        client: new LocalOllamaClient(support.model, 'https://api.groq.com/openai', keyStr),
                        brainName: `Scout Brain (${support.model} - Groq)`
                    };
                } else if (keyStr.startsWith('sk-or-')) {
                    return {
                        client: new LocalOllamaClient(support.model, 'https://openrouter.ai/api', keyStr),
                        brainName: `Scout Brain (${support.model} - OpenRouter)`
                    };
                } else if (keyStr.startsWith('sk-')) {
                    return {
                        client: new LocalOllamaClient(support.model, 'https://api.openai.com', keyStr),
                        brainName: `Scout Brain (${support.model} - OpenAI)`
                    };
                } else {
                    return {
                        client: new GeminiCloudClient([keyStr], support.model || 'gemini-1.5-flash', 60),
                        brainName: `Scout Brain (${support.model})`
                    };
                }
            }
        }

        // Tier 2: Fallback to Main Brain
        const main = config?.mainBrain;
        if (main && main.model) {
            if (main.providerType === 'local') {
                return {
                    client: new LocalOllamaClient(main.model, main.endpoint || 'http://127.0.0.1:11434', main.apiKey),
                    brainName: `Main Brain (${main.model})`
                };
            } else {
                const keyStr = main.apiKey?.trim() || '';
                if (keyStr.startsWith('gsk_')) {
                    return {
                        client: new LocalOllamaClient(main.model, 'https://api.groq.com/openai', keyStr),
                        brainName: `Main Brain (${main.model} - Groq)`
                    };
                } else if (keyStr.startsWith('sk-or-')) {
                    return {
                        client: new LocalOllamaClient(main.model, 'https://openrouter.ai/api', keyStr),
                        brainName: `Main Brain (${main.model} - OpenRouter)`
                    };
                } else if (keyStr.startsWith('sk-')) {
                    return {
                        client: new LocalOllamaClient(main.model, 'https://api.openai.com', keyStr),
                        brainName: `Main Brain (${main.model} - OpenAI)`
                    };
                } else {
                    return {
                        client: new GeminiCloudClient([keyStr], main.model || 'gemini-1.5-pro', 60),
                        brainName: `Main Brain (${main.model})`
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
    workspaceRoot: string
): Promise<string> {
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

        // 2. Discover 5-10 distinct web URLs
        let targetUrls = Array.isArray(providedUrls) ? [...providedUrls] : [];
        if (targetUrls.length < 5) {
            const discovered = await searchMultiUrls(query, 8 - targetUrls.length);
            for (const u of discovered) {
                if (!targetUrls.includes(u)) targetUrls.push(u);
            }
        }

        // 3. Concurrently fetch web context from target URLs (capped at 8 sources max)
        const fetchPromises = targetUrls.slice(0, 8).map(async (url) => {
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

        // 4. Distill using LLM (Scout Brain -> Main Brain fallback)
        let distilledMarkdown = '';
        let brainUsed = 'Deterministic Cleaner (No LLM active)';
        const distiller = getDistillerClient(workspaceRoot);

        if (distiller) {
            try {
                brainUsed = distiller.brainName;
                // Prepare raw material chunked cleanly
                const compiledRaw = rawSources.map((s, idx) => `### Source [${idx + 1}]: ${s.source}\n${s.content.substring(0, 2500)}`).join('\n\n---\n\n');

                const distillationPrompt = `You are a Technical Research Distiller for a software engineering agent.
Your objective: Process the following raw documentation from ${rawSources.length} external sources on "${query}".

RULES:
1. Strip all noise: Remove advertisements, cookie banners, navigation links, author bios, and marketing fluff.
2. Extract exact modern API signatures, parameters, types, and setup commands.
3. Provide 2-3 copy-paste ready, syntactically correct code examples following modern best practices.
4. Highlight breaking changes, deprecated methods, and common gotchas.
5. Return clean, comprehensive Markdown.

Raw Documentation Material:
${compiledRaw}`;

                const response = await distiller.client.complete(distillationPrompt);
                distilledMarkdown = response.text || '';
            } catch (distillErr) {
                console.warn(`Primary distiller (${distiller.brainName}) failed, attempting fallback:`, distillErr);
                // Attempt fallback to Main Brain if Scout failed
                try {
                    const config = getAgentConfig(workspaceRoot);
                    const { LocalOllamaClient, GeminiCloudClient } = require('../router/realClients');
                    const main = config?.mainBrain;
                    if (main && main.model && !distiller.brainName.includes('Main Brain')) {
                        const fallbackClient = main.providerType === 'local'
                            ? new LocalOllamaClient(main.model, main.endpoint || 'http://127.0.0.1:11434', main.apiKey)
                            : new GeminiCloudClient([main.apiKey?.trim() || ''], main.model || 'gemini-1.5-pro', 60);

                        brainUsed = `Main Brain Fallback (${main.model})`;
                        const compiledRaw = rawSources.map((s, idx) => `### Source [${idx + 1}]: ${s.source}\n${s.content.substring(0, 2000)}`).join('\n\n---\n\n');
                        const response = await fallbackClient.complete(`Distill this technical docs into clean API signatures & examples:\n${compiledRaw}`);
                        distilledMarkdown = response.text || '';
                    }
                } catch (fallbackErr) {
                    console.error('Fallback distiller also failed:', fallbackErr);
                }
            }
        }

        // If LLM was unavailable or failed completely, generate structured markdown deterministically
        if (!distilledMarkdown || distilledMarkdown.trim().length < 50) {
            distilledMarkdown = `# Technical Research: ${query}\n\n`;
            distilledMarkdown += `*Compiled from ${rawSources.length} external sources*\n\n`;
            for (const s of rawSources) {
                distilledMarkdown += `## Source: ${s.source}\n\n${s.content}\n\n---\n\n`;
            }
        }

        // 5. Save distilled findings to disk
        const safeTopicSlug = query.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 35).replace(/^_+|_+$/g, '') || 'research';
        const fileName = `${safeTopicSlug}_research.md`;
        const filePath = path.join(findingsDir, fileName);
        
        fs.writeFileSync(filePath, distilledMarkdown, 'utf8');

        // Update findings INDEX.md
        const indexPath = path.join(findingsDir, 'INDEX.md');
        const indexLine = `- **[${fileName}](./${fileName})**: Research on "${query}" (${rawSources.length} sources, distilled by ${brainUsed} on ${new Date().toISOString().split('T')[0]})\n`;
        try {
            if (fs.existsSync(indexPath)) {
                fs.appendFileSync(indexPath, indexLine, 'utf8');
            } else {
                fs.writeFileSync(indexPath, `# Research Findings Index\n\n${indexLine}`, 'utf8');
            }
        } catch {}

        const relPath = path.relative(workspaceRoot, filePath);

        // 6. Format comprehensive research with verified citations directly for the model
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

        // Token-efficient return message for the LLM
        let returnMsg = `### 📚 Technical Research Completed: "${query}"\n`;
        returnMsg += `Archived complete guide to: \`${relPath}\`\n\n`;
        returnMsg += `#### 🔗 Verified Sources:\n${citationsList}\n\n`;
        returnMsg += `#### 💡 Key Distilled Findings (by ${brainUsed}):\n`;
        returnMsg += `${distilledMarkdown.trim().slice(0, 1800)}\n\n`;
        if (distilledMarkdown.length > 1800) {
            returnMsg += `*(Note: Detailed implementations truncated to preserve tokens. Inspect \`${relPath}\` using read_multiple_files for complete code & API tables.)*\n`;
        }

        return {
            topic: query,
            filePath: relPath,
            sources: sourceObjects,
            distilledBy: brainUsed,
            summaryMarkdown: distilledMarkdown,
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
