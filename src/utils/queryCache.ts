import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export function generateCacheKey(systemInstruction: string, history: any[], prompt: string): string {
    const hash = crypto.createHash('sha256');
    hash.update(systemInstruction);
    hash.update(JSON.stringify(history));
    hash.update(prompt);
    return hash.digest('hex');
}

export function getCachePath(workspaceRoot: string): string {
    const aiMetaDir = path.join(workspaceRoot, '.ultra-light-ai');
    if (!fs.existsSync(aiMetaDir)) {
        fs.mkdirSync(aiMetaDir, { recursive: true });
    }
    return path.join(aiMetaDir, 'cache.json');
}

export function checkCache(workspaceRoot: string, key: string): string | null {
    try {
        const cachePath = getCachePath(workspaceRoot);
        if (fs.existsSync(cachePath)) {
            const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cacheData[key]) return cacheData[key];
        }
    } catch (e) { /* ignore read errors */ }
    return null;
}

export function saveCache(workspaceRoot: string, key: string, response: string): void {
    try {
        const cachePath = getCachePath(workspaceRoot);
        let cacheData: Record<string, string> = {};
        if (fs.existsSync(cachePath)) cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        const keys = Object.keys(cacheData);
        if (keys.length > 20) delete cacheData[keys[0]]; // Prevent disk bloat (LRU-style)
        cacheData[key] = response;
        fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), 'utf8');
    } catch (e) { /* ignore write errors */ }
}