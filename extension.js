// VS Code only talks to debuggers it knows: this registers the type "tenma" and points it at the
// DAP server of tenma --inspect, which does all the debugging. "launch" starts tenma itself first.
const { spawn } = require('child_process');
const net = require('net');
const vscode = require('vscode');

exports.activate = (context) => {
    const output = vscode.window.createOutputChannel('Tenma');
    // The tenma started for each launch session, ended with it
    const started = new Map();
    context.subscriptions.push(
        output,
        vscode.debug.registerDebugAdapterDescriptorFactory('tenma', {
            createDebugAdapterDescriptor: async (session) => {
                const config = session.configuration;
                if (config.request !== 'launch') {
                    return new vscode.DebugAdapterServer(config.port ?? 9229, config.host ?? '127.0.0.1');
                }
                const port = await freePort();
                // --inspect-wait: the breakpoints apply from the first statement on, and tenma stops
                // there only if stopOnEntry says so (VS Code passes the configuration on)
                const args = [`--inspect-wait=${port}`, ...(config.watch ? ['--watch'] : []), config.program, ...(config.args ?? [])];
                const tenma = spawn(config.runtimeExecutable ?? 'tenma', args, {
                    cwd: config.cwd ?? session.workspaceFolder?.uri.fsPath,
                    env: { ...process.env, ...config.env },
                });
                started.set(session.id, tenma);
                tenma.on('exit', () => {
                    started.delete(session.id);
                    vscode.debug.stopDebugging(session);
                });
                output.show(true);
                await listening(tenma, output);
                return new vscode.DebugAdapterServer(port, '127.0.0.1');
            },
        }),
        vscode.debug.onDidTerminateDebugSession((session) => started.get(session.id)?.kill()),
    );
};

// A port nobody listens on, for tenma's debugger
function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer().on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// Shows tenma's output and resolves once its debugger listens; tenma says so on stderr
function listening(tenma, output) {
    return new Promise((resolve, reject) => {
        // Kept until the debugger listens, for the error if tenma exits before
        let stderr = '';
        tenma.stdout.on('data', (data) => output.append(data.toString()));
        tenma.stderr.on('data', (data) => {
            output.append(data.toString());
            if (stderr === null) return;
            stderr += data;
            if (stderr.includes('debugger (DAP) listening on')) {
                stderr = null;
                resolve();
            }
        });
        tenma.on('error', (error) => reject(new Error(`tenma could not start: ${error.message}`)));
        tenma.on('exit', (code) => reject(new Error(exited(code, stderr ?? ''))));
    });
}

// The first line says what went wrong; the rest (e.g. the usage) stays in the output panel
function exited(code, stderr) {
    if (stderr.includes('Unknown option: --inspect-wait')) {
        return 'This tenma is too old to launch: it lacks --inspect-wait (Tenma 0.1.9 or later). Update it, point runtimeExecutable at a newer one, or use attach.';
    }
    const reason = stderr.trim().split('\n')[0];
    return `tenma exited with code ${code}${reason ? `: ${reason}` : ''} (output panel "Tenma" has the rest)`;
}
