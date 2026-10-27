// Mock VS Code module for standalone test runners (Mocha CLI)
try {
    require('vscode');
} catch {
    const Module = require('module');
    const mockVscode = {
        workspace: {
            textDocuments: [],
            workspaceFolders: [],
            getConfiguration: () => ({ get: () => [] }),
            createFileSystemWatcher: () => ({
                onDidChange: () => ({ dispose: () => {} }),
                onDidCreate: () => ({ dispose: () => {} }),
                onDidDelete: () => ({ dispose: () => {} }),
                dispose: () => {}
            }),
            findFiles: () => Promise.resolve([])
        },
        window: {
            createOutputChannel: () => ({ show: () => {}, appendLine: () => {} }),
            terminals: [],
            createTerminal: () => ({}),
            showErrorMessage: () => {},
            showInformationMessage: () => {},
            withProgress: (_opts: any, task: any) => task()
        },
        Uri: {
            file: (fsPath: string) => ({ fsPath, scheme: 'file' })
        },
        commands: {
            executeCommand: () => Promise.resolve([]),
            registerCommand: () => ({ dispose: () => {} })
        },
        languages: {
            getDiagnostics: () => []
        },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        SymbolKind: {
            File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
            Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
            Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
            Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21,
            Struct: 22, Event: 23, Operator: 24, TypeParameter: 25
        },
        StatusBarAlignment: { Left: 1, Right: 2 },
        EventEmitter: class {
            private listeners: Array<(e: any) => any> = [];
            event = (listener: (e: any) => any) => {
                this.listeners.push(listener);
                return { dispose: () => {} };
            };
            fire(data: any) {
                this.listeners.forEach(l => l(data));
            }
            dispose() {}
        },
        Disposable: {
            from: (...disposables: { dispose: () => any }[]) => ({
                dispose: () => {
                    disposables.forEach(d => d.dispose());
                }
            })
        },
        extensions: {
            getExtension: (id: string) => ({ id, isActive: true })
        }
    };

    const origLoad = Module._load;
    Module._load = function (request: string, parent: any, isMain: boolean) {
        if (request === 'vscode') {
            return mockVscode;
        }
        return origLoad.apply(this, arguments);
    };
}
