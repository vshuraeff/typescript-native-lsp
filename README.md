# typescript-native-lsp

TypeScript and JavaScript code intelligence for Claude Code from the language server that the native TypeScript 7 compiler has built in (`tsc --lsp --stdio`). It replaces the official `typescript-lsp` plugin, which runs `typescript-language-server`: that server wraps `tsserver.js`, and TypeScript 7 does not ship it.

## Install

From a Claude Code session (Claude Code 2.1.275 or later; on an older version use the shell commands below):

```text
/plugin install typescript-native-lsp --marketplace vshuraeff/typescript-native-lsp
```

Or from the shell:

```sh
claude plugin marketplace add vshuraeff/typescript-native-lsp
claude plugin install typescript-native-lsp@typescript-native-lsp
```

If the official `typescript-lsp` plugin is installed, disable or uninstall it, so the two servers do not both claim `.ts` and `.js` files: `claude plugin uninstall typescript-lsp@claude-plugins-official`. Restart Claude Code after installing.

## Why the relay

Claude Code reads type errors only from pushed `textDocument/publishDiagnostics` notifications. TypeScript 7 serves per-file diagnostics only on request (`textDocument/diagnostic`), so without help Claude never sees the errors an edit introduces ([anthropics/claude-code#101041](https://github.com/anthropics/claude-code/issues/101041)).

`server/relay.ts` sits between the two. It answers the server's `workspace/diagnostic/refresh` request itself, keeps the server's replies to its own diagnostic pulls (Claude Code gets the resulting `publishDiagnostics` instead), forwards all other traffic unchanged, and it also:

- adds pull-diagnostic support to the client capabilities of `initialize`, with the diagnostic details the client accepts for pushed diagnostics;
- requests diagnostics for every open document once 150 ms have passed since the latest `didOpen`, `didChange`, `didSave`, `didClose` or `workspace/diagnostic/refresh`, so continuous typing delays the pull until it pauses; it pulls every open document because a change in one file can change the errors of another;
- pushes each answer to Claude Code as `publishDiagnostics`, and pushes an empty list when a document closes;
- drops an answer that a later open, change, close or refresh has made stale, and cancels the pulls it supersedes;
- pulls a document once more when the server cancels its pull with `ServerCancelled` and does not set `retriggerRequest: false`, and no more than once per round;
- sends no pulls after the client's `shutdown`, and kills the server when the client closes its end and the server does not exit within 2 s.

The relay pulls nothing when the server announces no `diagnosticProvider`. Once Claude Code pulls diagnostics itself, remove the relay: set `command` to `tsc` and `args` to `["--lsp", "--stdio"]` in `.claude-plugin/plugin.json`.

Claude Code starts the server in the project directory. `plugin.json` therefore runs bun with `--no-env-file` and `--config` pointing at the plugin's empty `bunfig.toml`, so a project's `.env` and `bunfig.toml` (a `preload` above all, which could write to stdout and break the LSP stream) do not reach the relay or the server.

## Requirements

- `tsc` on `PATH` is TypeScript 7 or later: `tsc --version`. Install it globally, for example `bun add -g typescript`, `npm install -g typescript` or `brew install typescript`. An older `tsc` earlier on `PATH`, such as a global TypeScript 6 install, has no `--lsp` and the server fails to start.
- `bun` 1.3.3 or later on `PATH` runs the relay (`bun --version`), because the relay starts with `--no-env-file`: <https://bun.sh>.
- The server runs in local Claude Code sessions only: the terminal, the IDE extensions and the desktop app's Code tab. claude.ai chat, Cowork and Claude Code cloud sessions do not start plugin language servers.

## Development

```sh
bun install
bun run typecheck
bun test ./tests
```

`tests/relay.test.ts` starts the server that `.claude-plugin/plugin.json` declares, over the real `tsc --lsp`, from a project directory with its own `bunfig.toml` preload, as a client that reads only pushed diagnostics. It checks that a type error arrives, that a fix in another file clears it, that hover passes through, that a closed document is cleared and that the project preload did not run.

`tests/stale.test.ts` runs the relay over `tests/stub-server.ts`, a stub whose answers the test holds and releases. It covers stale answers after a change, a close and a refresh, the cancellation of superseded pulls, no pulls after `shutdown`, the retry bound, the kill of a server that ignores the end of input and SIGTERM, a project `.env` kept from the server, a non-ASCII URI, and `frames` over a stream split at every byte.

## License

MIT, see [LICENSE](LICENSE).
