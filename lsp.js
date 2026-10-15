// Starts `tenma lsp`, the language server that runs next to the editor's own PHP extension, and talks
// LSP to it without a client library: completion, hover, definition and diagnostics for PHP files.
// VS Code merges its answers with those of the PHP extension. Only in trusted workspaces: the server
// loads the project's autoloader, and with it the project's code.
const { spawn } = require('child_process');
const vscode = require('vscode');

const SELECTOR = { language: 'php', scheme: 'file' };

exports.start = (context, output) => {
    const diagnostics = vscode.languages.createDiagnosticCollection('tenma');
    let server = null;
    const run = () => {
        const enabled = vscode.workspace.getConfiguration('tenma').get('lsp.enable', true);
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!enabled || !vscode.workspace.isTrusted || !folder || server) return;
        const started = new Server(folder, output, diagnostics, () => {
            if (server === started) server = null;
        });
        server = started;
    };
    const restart = () => {
        server?.stop();
        server = null;
        run();
    };
    const ask = async (method, document, position) => {
        if (!server || document.uri.scheme !== 'file') return null;
        await server.ready;
        server.sync(document);
        return server.request(method, { textDocument: { uri: document.uri.toString() }, position: { line: position.line, character: position.character } });
    };
    context.subscriptions.push(
        diagnostics,
        { dispose: () => server?.stop() },
        vscode.commands.registerCommand('tenma.restartLanguageServer', restart),
        vscode.workspace.onDidGrantWorkspaceTrust(run),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('tenma')) restart();
        }),
        vscode.workspace.onDidOpenTextDocument((document) => server?.sync(document)),
        vscode.workspace.onDidChangeTextDocument((event) => server?.sync(event.document)),
        vscode.workspace.onDidSaveTextDocument((document) => server?.notify('textDocument/didSave', { textDocument: { uri: document.uri.toString() } })),
        vscode.workspace.onDidCloseTextDocument((document) => server?.close(document)),
        vscode.languages.registerCompletionItemProvider(SELECTOR, {
            provideCompletionItems: async (document, position) => {
                const result = await ask('textDocument/completion', document, position);
                return (result?.items ?? []).map((item) => {
                    const completion = new vscode.CompletionItem(item.label, (item.kind ?? 1) - 1);
                    completion.detail = item.detail;
                    completion.insertText = item.insertText;
                    return completion;
                });
            },
        }, '>', '"', '<', ' ', '-'),
        vscode.languages.registerHoverProvider(SELECTOR, {
            provideHover: async (document, position) => {
                const result = await ask('textDocument/hover', document, position);
                return result ? new vscode.Hover(new vscode.MarkdownString(result.contents.value)) : null;
            },
        }),
        vscode.languages.registerDefinitionProvider(SELECTOR, {
            provideDefinition: async (document, position) => {
                const result = await ask('textDocument/definition', document, position);
                return result ? new vscode.Location(vscode.Uri.parse(result.uri), new vscode.Position(result.range.start.line, result.range.start.character)) : null;
            },
        }),
    );
    run();
};

class Server {
    constructor(folder, output, diagnostics, ended) {
        this.output = output;
        this.diagnostics = diagnostics;
        this.next = 0;
        this.pending = new Map();
        // uri => version last sent
        this.open = new Map();
        this.buffer = Buffer.alloc(0);
        this.stopping = false;
        const executable = vscode.workspace.getConfiguration('tenma').get('executable', 'tenma');
        this.process = spawn(executable, ['lsp'], { cwd: folder.uri.fsPath });
        this.process.stdout.on('data', (data) => this.receive(data));
        // Writing to a server that has ended: the exit handler below says why
        this.process.stdin.on('error', () => {});
        this.process.stderr.on('data', (data) => output.append(data.toString()));
        this.process.on('error', (error) => output.appendLine(`tenma lsp could not start: ${error.message}`));
        this.process.on('exit', (code) => {
            for (const { resolve } of this.pending.values()) resolve(null);
            this.pending.clear();
            this.diagnostics.clear();
            if (!this.stopping) output.appendLine(`tenma lsp ended with code ${code}. It needs Tenma 0.1.9 or later; "Tenma: Restart Language Server" or a changed setting starts it again.`);
            ended();
        });
        this.ready = this.request('initialize', { processId: process.pid, rootUri: folder.uri.toString(), capabilities: {} }).then(() => {
            this.notify('initialized', {});
            for (const document of vscode.workspace.textDocuments) this.sync(document);
        });
    }

    send(message) {
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
        this.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.process.stdin.write(body);
    }

    request(method, params) {
        const id = ++this.next;
        return new Promise((resolve) => {
            this.pending.set(id, { resolve });
            this.send({ id, method, params });
        });
    }

    notify(method, params) {
        this.send({ method, params });
    }

    // Sends a PHP file's text when it is new to the server or changed since
    sync(document) {
        if (document.languageId !== 'php' || document.uri.scheme !== 'file') return;
        const uri = document.uri.toString();
        const version = this.open.get(uri);
        if (version === document.version) return;
        this.open.set(uri, document.version);
        if (version === undefined) {
            this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'php', version: document.version, text: document.getText() } });
        } else {
            this.notify('textDocument/didChange', { textDocument: { uri, version: document.version }, contentChanges: [{ text: document.getText() }] });
        }
    }

    close(document) {
        const uri = document.uri.toString();
        if (this.open.delete(uri)) this.notify('textDocument/didClose', { textDocument: { uri } });
    }

    receive(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
        for (;;) {
            const end = this.buffer.indexOf('\r\n\r\n');
            if (end < 0) return;
            const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1] ?? 0);
            if (this.buffer.length < end + 4 + length) return;
            const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString());
            this.buffer = this.buffer.subarray(end + 4 + length);
            this.handle(message);
        }
    }

    handle(message) {
        if (message.id !== undefined && this.pending.has(message.id)) {
            this.pending.get(message.id).resolve(message.result ?? null);
            this.pending.delete(message.id);
            if (message.error) this.output.appendLine(`tenma lsp: ${message.error.message}`);
            return;
        }
        if (message.method === 'textDocument/publishDiagnostics') {
            const uri = vscode.Uri.parse(message.params.uri);
            this.diagnostics.set(uri, message.params.diagnostics.map((found) => {
                const range = new vscode.Range(found.range.start.line, found.range.start.character, found.range.end.line, found.range.end.character);
                const diagnostic = new vscode.Diagnostic(range, found.message, (found.severity ?? 1) - 1);
                diagnostic.source = found.source;
                return diagnostic;
            }));
        }
    }

    stop() {
        this.stopping = true;
        this.request('shutdown', null).then(() => this.notify('exit', null));
        setTimeout(() => this.process.kill(), 1000);
    }
}
