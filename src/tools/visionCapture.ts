// src/tools/visionCapture.ts
// Screenshot a localhost page with the user's installed Edge/Chrome, collect DOM findings,
// and build an OpenAI/llama-server multimodal message. Zero browser binary download.

import * as fs from 'fs';
import * as vscode from 'vscode';
import puppeteer, { Browser, Page } from 'puppeteer-core';

export interface VisualFinding {
    severity: 'high' | 'medium' | 'low';
    text: string;
}

export interface CaptureResult {
    viewport: 'desktop' | 'mobile';
    pngBase64: string;
    consoleErrors: string[];
    failedRequests: string[];
    findings: VisualFinding[];
}

const BROWSER_CANDIDATES = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

function findBrowser(): string {
    const cfg = vscode.workspace.getConfiguration('ultraLightAI').get<string>('browserPath');
    const p = [cfg, ...BROWSER_CANDIDATES].find(x => x && fs.existsSync(x));
    if (!p) throw new Error('No Chrome or Edge found on the system. Please specify "ultraLightAI.browserPath" in settings.');
    return p;
}

/** Runs inside the page. Fast, deterministic DOM checks that catch layout breakages before the model. */
function domChecks(): Array<{ severity: 'high' | 'medium' | 'low'; text: string }> {
    const out: Array<{ severity: 'high' | 'medium' | 'low'; text: string }> = [];
    const de = document.documentElement;
    const desc = (el: Element) => {
        const e = el as HTMLElement;
        return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
            (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    };
    if (de.scrollWidth > de.clientWidth + 1) {
        out.push({ severity: 'high', text: `Horizontal overflow: page is ${de.scrollWidth}px wide in a ${de.clientWidth}px viewport.` });
        const offenders = Array.from(document.querySelectorAll('body *'))
            .filter((el: any) => el.getBoundingClientRect().right > de.clientWidth + 1).slice(0, 3);
        offenders.forEach((el: any) => out.push({ severity: 'high', text: `Element overflows right edge: ${desc(el)}` }));
    }
    const imgs = Array.from(document.images).filter((i: any) => i.complete && i.naturalWidth === 0);
    imgs.slice(0, 3).forEach((i: any) => out.push({ severity: 'medium', text: `Broken image: ${i.getAttribute('src')}` }));

    document.querySelectorAll('button, a, input, select').forEach((el: any) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if ((r.width === 0 || r.height === 0 || cs.visibility === 'hidden') && cs.display !== 'none') {
            out.push({ severity: 'medium', text: `Interactive element has zero size or is hidden: ${desc(el)}` });
        }
    });
    document.querySelectorAll('p, h1, h2, h3, li, span, button, a').forEach((el: any) => {
        const h = el as HTMLElement;
        if (h.scrollWidth > h.clientWidth + 2 && getComputedStyle(h).overflowX === 'visible' && h.clientWidth > 0 && h.children.length === 0) {
            if (out.length < 15) out.push({ severity: 'low', text: `Text may overflow its box: ${desc(h)}` });
        }
    });
    if (getComputedStyle(document.body).backgroundColor === getComputedStyle(document.body).color) {
        out.push({ severity: 'high', text: 'Body text color equals background color.' });
    }
    return out.slice(0, 12);
}

export class VisionCapture implements vscode.Disposable {
    private browser?: Browser;

    private async ensureBrowser(): Promise<Browser> {
        if (this.browser?.connected) return this.browser;
        this.browser = await puppeteer.launch({
            executablePath: findBrowser(),
            headless: true,
            args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars']
        });
        return this.browser;
    }

    /** Only allow localhost targets for security */
    private assertLocal(url: string) {
        const u = new URL(url);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
            throw new Error('Only localhost URLs are permitted for vision capture.');
        }
    }

    async capture(url: string, viewport: 'desktop' | 'mobile' = 'desktop', waitMs = 800): Promise<CaptureResult> {
        this.assertLocal(url);
        const page: Page = await (await this.ensureBrowser()).newPage();
        const consoleErrors: string[] = [], failedRequests: string[] = [];

        page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
        page.on('pageerror', e => consoleErrors.push(String((e as Error).message).slice(0, 200)));
        page.on('requestfailed', r => failedRequests.push(`${r.url()} (${r.failure()?.errorText})`));
        page.on('response', r => { if (r.status() >= 400) failedRequests.push(`${r.url()} → ${r.status()}`); });

        try {
            await page.setViewport(viewport === 'mobile'
                ? { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }
                : { width: 1280, height: 800, deviceScaleFactor: 1 });

            await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
            await new Promise(r => setTimeout(r, waitMs));

            const findings = await page.evaluate(domChecks);
            const png = await page.screenshot({ type: 'png', fullPage: false }) as Buffer;

            return {
                viewport,
                pngBase64: png.toString('base64'),
                consoleErrors: consoleErrors.slice(0, 6),
                failedRequests: failedRequests.slice(0, 6),
                findings
            };
        } finally {
            await page.close();
        }
    }

    dispose() {
        this.browser?.close().catch(() => {});
    }
}

/**
 * Builds OpenAI / multimodal payload for vision models (Gemma 4 E4B, Claude, GPT-4o).
 */
export function buildVisionMessage(url: string, caps: CaptureResult[]) {
    const report = caps.map(c => {
        const f = c.findings.map(x => `  - [${x.severity}] ${x.text}`).join('\n') || '  - none';
        return `${c.viewport.toUpperCase()}:\n  console errors: ${c.consoleErrors.join(' | ') || 'none'}\n` +
            `  failed requests: ${c.failedRequests.join(' | ') || 'none'}\n  automated layout checks:\n${f}`;
    }).join('\n');

    return {
        role: 'user' as const,
        content: [
            {
                type: 'text',
                text:
                    `[VISUAL UI REVIEW of ${url}] Screenshots captured (${caps.map(c => c.viewport).join(', ')}).\n` +
                    `Automated DOM Diagnostics:\n${report}\n\n` +
                    `Task: Audit visual layout problems in the screenshots (alignment, overflow, clipping, broken styling). ` +
                    `Suggest or execute a code patch to fix the highest severity issue.`
            },
            ...caps.map(c => ({
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${c.pngBase64}` }
            }))
        ]
    };
}

/**
 * Tool Registry definition for capture_localhost_preview
 */
export const captureLocalhostTool = {
    name: 'capture_localhost_preview',
    description: 'Captures a visual screenshot and DOM layout health report of a local dev server (e.g. http://localhost:3000) using the system browser.',
    parameters: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'Local URL to capture (e.g. "http://localhost:3000" or "http://127.0.0.1:8000")' },
            viewport: { type: 'string', enum: ['desktop', 'mobile'], description: 'Viewport mode: "desktop" (1280x800) or "mobile" (390x844)' }
        },
        required: ['url']
    }
};
