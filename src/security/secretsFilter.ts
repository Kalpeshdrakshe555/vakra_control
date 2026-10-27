import * as path from 'path';

export interface RedactionSummary {
    type: string;
    count: number;
}

export interface RedactResult {
    text: string;
    redactions: RedactionSummary[];
}

const SECRET_PATH_PATTERNS: RegExp[] = [
    /^\.env(\..+)?$/i,
    /\.(pem|key|p12|pfx|sqlite3|db)$/i,
    /^id_(rsa|ed25519|ecdsa|dsa)(\..+)?$/i,
    /^credentials(\..+)?$/i,
    /.*secret.*/i,
    /^\.(netrc|npmrc|dockercfg)$/i,
    /^authorized_keys$/i,
    /^known_hosts$/i
];

const SECRET_DIR_PATTERNS: RegExp[] = [
    /^\.git([\\\/].*)?$/i,
    /^node_modules([\\\/].*)?$/i,
    /^(venv|\.venv|env)([\\\/].*)?$/i,
    /^__pycache__([\\\/].*)?$/i,
    /^\.aws([\\\/].*)?$/i,
    /^\.ssh([\\\/].*)?$/i,
    /^\.gnupg([\\\/].*)?$/i
];

/**
 * Checks whether a relative or absolute path points to a sensitive file or directory.
 */
export function isSecretPath(targetPath: string, workspaceRoot?: string): boolean {
    if (!targetPath) return false;
    let relPath = targetPath;
    if (workspaceRoot) {
        try {
            const root = path.resolve(workspaceRoot);
            const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath);
            relPath = path.relative(root, resolved);
        } catch {
            relPath = targetPath;
        }
    }
    const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    const baseName = path.basename(normalized);

    // Check directory components
    const parts = normalized.split('/');
    for (const part of parts) {
        if (!part || part === '.') continue;
        for (const dirPat of SECRET_DIR_PATTERNS) {
            if (dirPat.test(part)) return true;
        }
    }

    // Check file patterns
    for (const pat of SECRET_PATH_PATTERNS) {
        if (pat.test(baseName)) return true;
    }

    return false;
}

/**
 * Redacts API keys, tokens, JWTs, and private keys from outbound text.
 */
export function redact(text: string): RedactResult {
    if (!text) return { text: '', redactions: [] };

    let result = text;
    const counts = new Map<string, number>();

    const record = (type: string, cnt: number = 1) => {
        counts.set(type, (counts.get(type) || 0) + cnt);
    };

    // 1. Private Keys
    const privateKeyRegex = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
    result = result.replace(privateKeyRegex, () => {
        record('private-key');
        return '[REDACTED:PRIVATE_KEY]';
    });

    // 2. AWS Access Key ID
    const awsRegex = /\b(AKIA[0-9A-Z]{16})\b/g;
    result = result.replace(awsRegex, () => {
        record('aws-key');
        return '[REDACTED:AWS_KEY]';
    });

    // 3. Google API Key (AIza...)
    const googleRegex = /\b(AIza[0-9A-Za-z_\-]{35})\b/g;
    result = result.replace(googleRegex, () => {
        record('google-api-key');
        return '[REDACTED:GOOGLE_KEY]';
    });

    // 4. OpenAI / OpenRouter sk-...
    const openAiRegex = /\b(sk-[A-Za-z0-9_\-]{20,})\b/g;
    result = result.replace(openAiRegex, () => {
        record('openai-key');
        return '[REDACTED:API_KEY]';
    });

    // 5. GitHub Personal Access Token
    const githubRegex = /\b(ghp_[A-Za-z0-9]{36})\b/g;
    result = result.replace(githubRegex, () => {
        record('github-token');
        return '[REDACTED:GITHUB_TOKEN]';
    });

    // 6. Slack Token
    const slackRegex = /\b(xox[baprs]-[A-Za-z0-9\-]{10,})\b/g;
    result = result.replace(slackRegex, () => {
        record('slack-token');
        return '[REDACTED:SLACK_TOKEN]';
    });

    // 7. JWT Tokens (eyJ...)
    const jwtRegex = /\b(eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+)\b/g;
    result = result.replace(jwtRegex, () => {
        record('jwt-token');
        return '[REDACTED:JWT]';
    });

    // 8. Generic assignment secrets (e.g. SECRET_KEY = '...', password: '...', api_key = "...")
    const genericSecretRegex = /\b(api[_-]?key|secret(?:_key)?|token|password|passwd|pwd)\s*([:=])\s*(['"]?)([^\s'"\r\n]{6,})\3/gi;
    result = result.replace(genericSecretRegex, (match, keyName, sep, quote, val) => {
        if (typeof val === 'string' && val.startsWith('[REDACTED:')) return match;
        record('credential-kv');
        return `${keyName} ${sep} ${quote}[REDACTED:SECRET]${quote}`;
    });

    const redactions: RedactionSummary[] = Array.from(counts.entries()).map(([type, count]) => ({
        type,
        count
    }));

    return { text: result, redactions };
}
