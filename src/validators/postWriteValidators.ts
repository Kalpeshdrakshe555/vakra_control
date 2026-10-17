import * as fs from 'fs';
import * as path from 'path';
import { runProcess } from '../platform/process';
import { resolvePython } from '../platform/python';

export interface ValidationResult {
    ok: boolean;
    validator: string;
    skipped?: boolean;
    line?: number;
    column?: number;
    message?: string;
    snippet?: string;
}

export interface ValidatorContext {
    workspaceRoot: string;
    userPythonPath?: string;
}

/**
 * Validates a newly written or edited file based on extension.
 */
export async function validateFile(
    filePath: string,
    ctx: ValidatorContext
): Promise<ValidationResult[]> {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    const ext = path.extname(filePath).toLowerCase();
    const results: ValidationResult[] = [];

    try {
        if (ext === '.py') {
            const pyRes = await validatePython(filePath, ctx);
            results.push(pyRes);
        } else if (ext === '.json') {
            results.push(validateJson(filePath));
        } else if (['.js', '.mjs', '.cjs'].includes(ext)) {
            const jsRes = await validateJavaScript(filePath);
            results.push(jsRes);
        } else if (ext === '.css') {
            results.push(validateCss(filePath));
        } else if (['.html', '.htm'].includes(ext)) {
            results.push(validateHtml(filePath));
        }
    } catch {
        // Validation should never throw
    }

    return results;
}

/**
 * Validates Python syntax using in-memory ast.parse via stdin.
 */
async function validatePython(filePath: string, ctx: ValidatorContext): Promise<ValidationResult> {
    const python = await resolvePython(ctx.workspaceRoot, path.dirname(filePath), ctx.userPythonPath);
    if (!python.ok) {
        return { ok: true, validator: 'python-ast', skipped: true, message: 'Python interpreter not found' };
    }

    let code: string;
    try {
        code = fs.readFileSync(filePath, 'utf8');
    } catch (err: any) {
        return { ok: false, validator: 'python-ast', message: `Cannot read file: ${err.message}` };
    }

    // Script that reads stdin and parses AST
    const script = `import sys, ast
try:
    source = sys.stdin.read()
    ast.parse(source)
    sys.exit(0)
except SyntaxError as e:
    sys.stderr.write(f"SyntaxError: {e.msg} at line {e.lineno} col {e.offset}\\n")
    sys.exit(1)
except Exception as e:
    sys.stderr.write(f"Error: {e}\\n")
    sys.exit(1)
`;

    const res = await runProcess({
        exe: python.exe,
        args: [...python.preArgs, '-c', script],
        stdinText: code,
        timeoutMs: 5000
    });

    if (res.ok) {
        return { ok: true, validator: 'python-ast' };
    }

    const errText = res.stderr || res.stdout || 'Unknown Python syntax error';
    const match = errText.match(/SyntaxError:\s*(.*?)\s+at\s+line\s+(\d+)\s+col\s+(\d+)/i);
    const line = match ? parseInt(match[2], 10) : undefined;
    const col = match ? parseInt(match[3], 10) : undefined;
    const msg = match ? match[1] : errText.trim();

    return {
        ok: false,
        validator: 'python-ast',
        line,
        column: col,
        message: msg,
        snippet: line ? extractSnippet(code, line) : undefined
    };
}

/**
 * Validates JSON files using JSON.parse.
 */
function validateJson(filePath: string): ValidationResult {
    let content: string = '';
    try {
        content = fs.readFileSync(filePath, 'utf8');
        JSON.parse(content);
        return { ok: true, validator: 'json-parse' };
    } catch (err: any) {
        const msg = err?.message || 'JSON Parse Error';
        // Try extract position: "Unexpected token at position 123" or "line X column Y"
        let line: number | undefined;
        let column: number | undefined;

        const lineColMatch = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
        if (lineColMatch) {
            line = parseInt(lineColMatch[1], 10);
            column = parseInt(lineColMatch[2], 10);
        } else {
            const posMatch = msg.match(/position\s+(\d+)/i);
            if (posMatch && content!) {
                const pos = parseInt(posMatch[1], 10);
                const prefix = content.slice(0, pos);
                const lines = prefix.split('\n');
                line = lines.length;
                column = lines[lines.length - 1].length + 1;
            } else if (content) {
                // Heuristic fallback: find first line with trailing dangling comma/colon
                const lines = content.split('\n');
                for (let idx = 0; idx < lines.length; idx++) {
                    if (lines[idx].trim().endsWith(':')) {
                        line = idx + 1;
                        column = lines[idx].length;
                        break;
                    }
                }
            }
        }

        return {
            ok: false,
            validator: 'json-parse',
            line: line ?? 1,
            column: column ?? 1,
            message: msg,
            snippet: line ? extractSnippet(content!, line) : undefined
        };
    }
}

/**
 * Validates JS syntax using `node --check`.
 */
async function validateJavaScript(filePath: string): Promise<ValidationResult> {
    const res = await runProcess({
        exe: 'node',
        args: ['--check', filePath],
        timeoutMs: 5000
    });

    if (res.ok) {
        return { ok: true, validator: 'node-check' };
    }

    if (res.error?.includes('ENOENT')) {
        return { ok: true, validator: 'node-check', skipped: true };
    }

    const err = res.stderr || res.stdout || '';
    const lineMatch = err.match(/:(\d+)(?::(\d+))?/);
    const line = lineMatch ? parseInt(lineMatch[1], 10) : undefined;
    const column = lineMatch && lineMatch[2] ? parseInt(lineMatch[2], 10) : undefined;

    return {
        ok: false,
        validator: 'node-check',
        line,
        column,
        message: err.trim(),
        snippet: line && fs.existsSync(filePath) ? extractSnippet(fs.readFileSync(filePath, 'utf8'), line) : undefined
    };
}

/**
 * Validates CSS brace/paren balance.
 */
function validateCss(filePath: string): ValidationResult {
    try {
        const text = fs.readFileSync(filePath, 'utf8');
        let braces = 0;
        let inComment = false;
        let inString: string | null = null;
        let line = 1;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const next = i + 1 < text.length ? text[i + 1] : '';

            if (ch === '\n') line++;

            if (inComment) {
                if (ch === '*' && next === '/') {
                    inComment = false;
                    i++;
                }
                continue;
            }

            if (inString) {
                if (ch === inString && text[i - 1] !== '\\') {
                    inString = null;
                }
                continue;
            }

            if (ch === '/' && next === '*') {
                inComment = true;
                i++;
                continue;
            }

            if (ch === '"' || ch === "'") {
                inString = ch;
                continue;
            }

            if (ch === '{') braces++;
            else if (ch === '}') {
                braces--;
                if (braces < 0) {
                    return {
                        ok: false,
                        validator: 'css-balance',
                        line,
                        message: 'Unmatched closing brace "}"',
                        snippet: extractSnippet(text, line)
                    };
                }
            }
        }

        if (braces !== 0) {
            return {
                ok: false,
                validator: 'css-balance',
                message: `Unbalanced CSS braces: ${braces > 0 ? 'missing closing brace' : 'extra closing brace'}`
            };
        }

        return { ok: true, validator: 'css-balance' };
    } catch {
        return { ok: true, validator: 'css-balance', skipped: true };
    }
}

/**
 * Validates basic HTML delimiter balancing for Django/Jinja template tags.
 */
function validateHtml(filePath: string): ValidationResult {
    try {
        const text = fs.readFileSync(filePath, 'utf8');
        
        // Count Jinja/Django template block markers
        const blockOpen = (text.match(/\{%/g) || []).length;
        const blockClose = (text.match(/%\}/g) || []).length;
        if (blockOpen !== blockClose) {
            return {
                ok: false,
                validator: 'html-template',
                message: `Mismatched template tags ({% count: ${blockOpen}, %} count: ${blockClose})`
            };
        }

        const varOpen = (text.match(/\{\{/g) || []).length;
        const varClose = (text.match(/\}\}/g) || []).length;
        if (varOpen !== varClose) {
            return {
                ok: false,
                validator: 'html-template',
                message: `Mismatched template variable brackets ({{ count: ${varOpen}, }} count: ${varClose})`
            };
        }

        return { ok: true, validator: 'html-template' };
    } catch {
        return { ok: true, validator: 'html-template', skipped: true };
    }
}

/**
 * Extracts a 3-line snippet around the target line.
 */
function extractSnippet(code: string, targetLine: number): string {
    const lines = code.split('\n');
    const start = Math.max(0, targetLine - 2);
    const end = Math.min(lines.length, targetLine + 1);

    return lines.slice(start, end).map((l, idx) => {
        const lineNum = start + idx + 1;
        const marker = lineNum === targetLine ? ' >>' : '   ';
        return `${marker} ${lineNum} | ${l}`;
    }).join('\n');
}

/**
 * Formats validation results into the standard [VALIDATION] block.
 */
export function formatValidationReport(filePath: string, results: ValidationResult[]): string {
    if (results.length === 0) return '';
    const baseName = path.basename(filePath);

    const lines: string[] = ['\n[VALIDATION]'];
    let hasFailure = false;

    for (const r of results) {
        if (r.skipped) continue;
        if (r.ok) {
            lines.push(`${baseName}: OK (${r.validator})`);
        } else {
            hasFailure = true;
            const loc = r.line ? ` line ${r.line}${r.column ? ` col ${r.column}` : ''}` : '';
            lines.push(`${baseName}: SYNTAX ERROR${loc}: ${r.message || 'Syntax validation failed'}`);
            if (r.snippet) {
                lines.push(r.snippet);
            }
        }
    }

    return hasFailure ? lines.join('\n') : '';
}
