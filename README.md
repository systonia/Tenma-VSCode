# Tenma for VS Code

Debug PHP apps running under [Tenma](https://tenma.dev): breakpoints, steps, variables, watch expressions and the debug console, with every request, timer and `Tenma::async()` task as a thread of its own. Tenma's `--inspect` does the debugging; this extension connects VS Code to it.

Needs Tenma 0.1.9 or later on the `PATH`. For Tenma's PHP API in Intelephense, PhpStorm and PHPStan: `composer require --dev tenma/stubs`.

## Launch

F5 starts the script under Tenma and stops at its breakpoints, also those in code that runs at startup. `.vscode/launch.json`:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "tenma",
            "request": "launch",
            "name": "Tenma",
            "program": "${workspaceFolder}/app.php",
            "watch": true
        }
    ]
}
```

| Attribute | |
|---|---|
| `program` | The PHP script, required |
| `args` | Arguments for the script |
| `cwd` | Working directory, the workspace folder by default |
| `env` | Environment variables on top of VS Code's |
| `watch` | Reload on file changes (`tenma --watch`); the breakpoints stay |
| `stopOnEntry` | Stop at the script's first statement |
| `runtimeExecutable` | The `tenma` binary, from the `PATH` by default |

Tenma's own output goes to the output panel "Tenma"; `echo` and the error log also appear in the debug console. Stopping the session ends Tenma.

## Attach

For a Tenma started elsewhere, e.g. in a container: `tenma --inspect app.php` (or `--inspect-wait`, `--inspect-brk`, `--inspect=host:port`), then

```json
{
    "type": "tenma",
    "request": "attach",
    "name": "Attach to tenma --inspect",
    "port": 9229
}
```

`host` (default `127.0.0.1`) and `port` (default `9229`) match `--inspect=host:port`. Only open the debugger to the network when you have to: whoever reaches it can run code.

## Building

Every tag `v*` builds a GitHub release with the `.vsix`, its version taken from the tag. By hand:

```bash
npx @vscode/vsce package
code --install-extension tenma-*.vsix
```

## License

MIT or Apache-2.0, at your option: [LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE).
