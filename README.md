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

`server/relay.ts` sits between the two. It answers the server's `workspace/diagnostic/refresh` request itself until Claude Code pulls diagnostics on its own, keeps the server's replies to its own diagnostic pulls (Claude Code gets the resulting `publishDiagnostics` instead), numbers the document versions it sends the server itself, forwards the server's requests to Claude Code under ids of its own (see [Idle shutdown](#idle-shutdown)), forwards all other traffic unchanged, and it also:

- adds pull-diagnostic support to the client capabilities of `initialize`, with the diagnostic details the client accepts for pushed diagnostics;
- requests diagnostics for every open document once 150 ms have passed since the latest `didOpen`, `didChange`, `didSave`, `didClose`, `workspace/diagnostic/refresh` or change found on disk, so continuous typing delays the pull until it pauses; it pulls every open document because a change in one file can change the errors of another;
- pushes each answer to Claude Code as `publishDiagnostics`, and pushes an empty list when a document closes;
- drops an answer that a later open, change, close or refresh has made stale, and cancels the pulls it supersedes;
- pulls a document once more when the server cancels its pull with `ServerCancelled` and does not set `retriggerRequest: false`, and no more than once per round;
- sends no pulls after the client's `shutdown`, and kills the server when the client closes its end and the server does not exit within 2 s;
- keeps open documents in line with disk. Claude Code opens a document the first time it edits or queries a file, never closes it, and sends nothing when the file changes outside its Edit and Write tools (a shell command, `git checkout`, a formatter, code generation), while the server trusts an open document over the file. Before each request from Claude Code the relay checks every open `file:` document: when the file's mtime or size changed and its text differs from what the server holds, the server gets the file's text; when the file is gone, the relay closes the document on the server and pushes an empty list, and opens it again when the file comes back or Claude Code changes it. A change found on disk starts new pulls like a `didChange`;
- switches its own pulls off the first time Claude Code sends a `textDocument/diagnostic` request itself: it cancels the pulls in flight, publishes nothing more, and forwards `workspace/diagnostic/refresh` to Claude Code instead of answering it. It decides on that request rather than on the capabilities Claude Code announces.

The relay pulls nothing when the server announces no `diagnosticProvider`. Its disk sync stays on in every case.

Claude Code starts the server in the project directory. `plugin.json` therefore runs bun with `--no-env-file` and `--config` pointing at the plugin's empty `bunfig.toml`, so a project's `.env` and `bunfig.toml` (a `preload` above all, which could write to stdout and break the LSP stream) do not reach the relay or the server.

## Idle shutdown

Claude Code keeps a language server running until the session ends, and `tsc --lsp` keeps every project it has loaded in memory. The relay therefore stops the server after 600 s with no message from Claude Code and no request from Claude Code waiting for its answer. Only Claude Code's messages and the server's answers to its requests start the period again: the server's own traffic (logs, progress, `workspace/diagnostic/refresh`) and the relay's own pulls do not, so a server that refreshes on its own is still stopped. Pulls scheduled or in flight when the period runs out delay the stop until they are answered and their diagnostics published, and a refresh after that point starts no pull of its own: the relay makes it up when a message from Claude Code cancels the stop. A server request that Claude Code leaves unanswered does not hold the stop off: the relay forwards each one under an id made of the server's generation and the server's own id, and passes an answer on, under the server's own id, only to the server that asked, so a late answer to a stopped server never reaches a restarted one that reuses the id. The next message from Claude Code starts it again: the relay replays the session's `initialize` and `initialized`, opens every document the old server held with its text, forwards the messages that came in the meantime in order, and pulls diagnostics again. Claude Code sees nothing of the stop, and of the start only what a starting server sends, such as its log messages; the relay answers the new server's `client/registerCapability` and `client/unregisterCapability` itself, because Claude Code holds the first server's registrations. When the server fails to start, the waiting requests fail with `ContentModified`, which Claude Code retries, and the retry tries the start again. `TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS` in the environment Claude Code runs in sets the period in seconds; `0` keeps the server running, and so does a period above 2147483647 ms, that is above 2147483.647 s (about 24.8 days), which a timer cannot hold.

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

`tests/relay.test.ts` starts the server that `.claude-plugin/plugin.json` declares, over the real `tsc --lsp`, from a project directory with its own `bunfig.toml` preload, as a client that reads only pushed diagnostics. It checks that a type error arrives, that a fix in another file clears it, that hover passes through, that an open file rewritten on disk outside the client is what the next hover and the next diagnostics see, that a closed document is cleared and that the project preload did not run. A second session checks that a server stopped when idle comes back on the next hover, with its diagnostics.

`tests/stale.test.ts` runs the relay over `tests/stub-server.ts`, a stub whose answers the test holds and releases. It covers stale answers after a change, a close and a refresh, the cancellation of superseded pulls, no pulls after `shutdown`, the retry bound, the kill of a server that ignores the end of input and SIGTERM, a project `.env` kept from the server, a non-ASCII URI, `frames` over a stream split at every byte, the disk sync of open documents (a change sent before the next request, an unchanged mtime and size, the client's own edit and its disk write, a deleted and a restored file, a ranged change, the server's own version numbers) the switch-off when the client pulls diagnostics itself, the idle stop (unseen by the client, held off by a waiting request, delayed by a pull in flight without a new period, not held off by a server request the client has not answered or by a server that keeps refreshing, a period too long for a timer, a shutdown while the server is stopped) and the restart (the replayed `initialize`, the reopened documents, the queued messages in order, a failed start, an `initialize` answered with an error included, answered with `ContentModified`, the first server's capability registration seen by the client once, a late answer to the old server's request dropped while the new server's answer under the same id of its own goes through).

## License

MIT, see [LICENSE](LICENSE).
