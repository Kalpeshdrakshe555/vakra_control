// src/operations/replaceSymbol.ts
// LSP-backed surgical edit: replace a function/class/method by name. No SEARCH block.
import * as vscode from 'vscode';

export interface ReplaceSymbolArgs {
    filepath: string;      // workspace-relative or absolute
    symbolName: string;    // "product_list" or "Product.save"
    newCode: string;       // full new definition (may include decorators)
}

export interface ReplaceSymbolResult {
    success: boolean;
    message: string;
    candidates?: string[];
}

/** Hook for rollback */
export interface Snapshotter {
    snapshot(uri: vscode.Uri): Promise<string>;
    restore(id: string, uri: vscode.Uri): Promise<void>;
}

export const defaultVsCodeSnapshotter: Snapshotter = {
    async snapshot(uri: vscode.Uri): Promise<string> {
        const doc = await vscode.workspace.openTextDocument(uri);
        return doc.getText();
    },
    async restore(savedText: string, uri: vscode.Uri): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, fullRange, savedText);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
    }
};

interface FlatSymbol { path: string; range: vscode.Range; kind: vscode.SymbolKind; }

const CALLABLE_OR_TYPE = new Set<vscode.SymbolKind>([
    vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Class,
    vscode.SymbolKind.Constructor, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct,
    vscode.SymbolKind.Enum, vscode.SymbolKind.Variable, vscode.SymbolKind.Constant, vscode.SymbolKind.Property
]);

function flatten(symbols: vscode.DocumentSymbol[], prefix = ''): FlatSymbol[] {
    const out: FlatSymbol[] = [];
    for (const s of symbols) {
        const p = prefix ? `${prefix}.${s.name}` : s.name;
        // Some servers add "(args)" to names, e.g. "foo(a, b)" — normalize.
        const clean = p.replace(/\(.*\)$/, '');
        out.push({ path: clean, range: s.range, kind: s.kind });
        if (s.children?.length) out.push(...flatten(s.children, clean));
    }
    return out;
}

function resolveUri(p: string): vscode.Uri {
    if (/^[a-zA-Z]:[\\/]|^\//.test(p)) return vscode.Uri.file(p);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error('No workspace folder open');
    return vscode.Uri.joinPath(root, p);
}

async function getSymbols(uri: vscode.Uri, retries = 3): Promise<vscode.DocumentSymbol[]> {
    for (let i = 0; i < retries; i++) {
        const res = await vscode.commands.executeCommand<
            (vscode.DocumentSymbol | vscode.SymbolInformation)[]
        >('vscode.executeDocumentSymbolProvider', uri);
        if (res?.length) {
            // Old-style SymbolInformation has no children; adapt.
            if ('range' in res[0]) return res as vscode.DocumentSymbol[];
            return (res as vscode.SymbolInformation[]).map(s =>
                new vscode.DocumentSymbol(s.name, '', s.kind, s.location.range, s.location.range));
        }
        await new Promise(r => setTimeout(r, 800)); // language server may still be starting
    }
    return [];
}

/** Extend upward over decorators / attribute lines (@app.route, @Injectable(), #[derive]). */
function includeDecorators(doc: vscode.TextDocument, range: vscode.Range): vscode.Range {
    let start = range.start.line;
    while (start > 0) {
        const prev = doc.lineAt(start - 1).text.trim();
        if (prev.startsWith('@') || prev.startsWith('#[')) start--;
        else break;
    }
    return new vscode.Range(start, 0, range.end.line, doc.lineAt(range.end.line).text.length);
}

function leadingWs(s: string) { return /^[ \t]*/.exec(s)![0]; }

/** Dedent model code to column 0, then indent to the target's indentation. */
function reindent(code: string, targetIndent: string): string {
    const lines = code.replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '').split('\n');
    const nonEmpty = lines.filter(l => l.trim());
    const minIndent = Math.min(...nonEmpty.map(l => leadingWs(l).length));
    return lines.map(l => (l.trim() ? targetIndent + l.slice(minIndent) : l)).join('\n');
}

/** Reject the classic small-model failures before touching disk. */
function validateNewCode(code: string, symbolLeaf: string): string | null {
    if (!code.trim()) return 'newCode is empty.';
    if (/(\.\.\.|…)\s*(existing|rest|remaining|unchanged)/i.test(code) ||
        /(#|\/\/)\s*\.\.\.\s*(existing|rest|other)/i.test(code)) {
        return 'newCode contains a placeholder such as "... existing code ...". Provide the COMPLETE definition.';
    }
    if (!new RegExp(`\\b${symbolLeaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code)) {
        return `newCode does not mention "${symbolLeaf}". It must be the full replacement definition of that symbol.`;
    }
    return null;
}

function errorCount(uri: vscode.Uri): number {
    return vscode.languages.getDiagnostics(uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
}

export async function replaceSymbol(
    args: ReplaceSymbolArgs,
    snap: Snapshotter = defaultVsCodeSnapshotter
): Promise<ReplaceSymbolResult> {
    let uri: vscode.Uri;
    try { uri = resolveUri(args.filepath); } catch (e: any) { return { success: false, message: e.message }; }

    let doc: vscode.TextDocument;
    try { doc = await vscode.workspace.openTextDocument(uri); }
    catch { return { success: false, message: `File not found: ${args.filepath}` }; }

    const leaf = args.symbolName.split('.').pop()!;
    const bad = validateNewCode(args.newCode, leaf);
    if (bad) return { success: false, message: `REJECTED: ${bad}` };

    const flat = flatten(await getSymbols(uri)).filter(s => CALLABLE_OR_TYPE.has(s.kind));
    if (flat.length === 0) {
        return { success: false, message: 'No symbols available for this file (language server not ready). Use apply_diff or write_file instead.' };
    }

    // Exact path match, then suffix match ("save" -> "Product.save")
    let matches = flat.filter(s => s.path === args.symbolName);
    if (matches.length === 0) matches = flat.filter(s => s.path.endsWith('.' + args.symbolName) || s.path === leaf);
    if (matches.length === 0) {
        const near = flat.map(s => s.path).filter(p => p.toLowerCase().includes(leaf.toLowerCase())).slice(0, 8);
        return {
            success: false,
            message: `Symbol "${args.symbolName}" not found in ${args.filepath}.`,
            candidates: near.length ? near : flat.map(s => s.path).slice(0, 20)
        };
    }
    if (matches.length > 1) {
        return {
            success: false,
            message: `"${args.symbolName}" is ambiguous. Retry with a dotted path.`,
            candidates: matches.map(m => `${m.path} (line ${m.range.start.line + 1})`)
        };
    }

    const target = matches[0];
    const fullRange = includeDecorators(doc, target.range);
    const indent = leadingWs(doc.lineAt(fullRange.start.line).text);
    const replacement = reindent(args.newCode, indent);

    const before = errorCount(uri);
    const snapId = snap ? await snap.snapshot(uri) : undefined;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, replacement);
    if (!(await vscode.workspace.applyEdit(edit))) {
        return { success: false, message: 'VS Code refused the edit (file may be read-only).' };
    }
    await doc.save();

    // Wait for diagnostics to settle, then compare error counts.
    await new Promise(r => setTimeout(r, 1200));
    const after = errorCount(uri);
    if (after > before) {
        const newErrs = vscode.languages.getDiagnostics(uri)
            .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
            .slice(0, 3)
            .map(d => `line ${d.range.start.line + 1}: ${d.message}`);
        if (snap && snapId) {
            await snap.restore(snapId, uri);
            return { success: false, message: `Edit introduced ${after - before} new error(s) and was rolled back:\n${newErrs.join('\n')}` };
        }
        return { success: true, message: `Replaced ${target.path}, but ${after - before} new error(s) appeared:\n${newErrs.join('\n')}` };
    }
    return {
        success: true,
        message: `Replaced ${target.path} (lines ${fullRange.start.line + 1}-${fullRange.end.line + 1}) in ${args.filepath}.`
    };
}

/** Registry entry for toolRegistry.ts and sidebarProvider.ts */
export const replaceSymbolTool = {
    name: 'replace_symbol',
    description: 'Surgically replaces a whole function, method, class, or interface by symbol name using LSP AST outline without needing fragile SEARCH blocks. Use "Class.method" for class methods.',
    parameters: {
        type: 'object',
        properties: {
            filepath: { type: 'string', description: 'Relative or absolute path to the target file' },
            symbolName: { type: 'string', description: 'Exact name of the symbol to replace (e.g. "calculate_total" or "OrderService.process")' },
            newCode: { type: 'string', description: 'Complete replacement code for the symbol. Do NOT include placeholders like "... existing code ...".' }
        },
        required: ['filepath', 'symbolName', 'newCode']
    }
};
