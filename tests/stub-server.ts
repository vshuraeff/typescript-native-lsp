// stub lsp server for relay tests. it announces pull diagnostics, names in each report the
// document version it saw, and reports what it receives as window/logMessage. modes:
// hold: holds its first pull answer until the next didChange, didClose or test refresh
// slow-shutdown: answers shutdown 300 ms late
// retrigger: cancels every pull of a uri containing "cancel" with ServerCancelled
// stubborn: ignores SIGTERM and the end of its input, so only SIGKILL stops it
import { encode, frames, isMessage } from '../server/relay'

const mode = process.argv[2] ?? 'plain'
if (mode === 'stubborn') process.on('SIGTERM', () => {})
const versions = new Map<string, number>()
let held: { id: unknown; result: unknown } | undefined
let pulls = 0

const send = (msg: object): void => { process.stdout.write(encode({ jsonrpc: '2.0', ...msg })) }
const log = (message: string): void => send({ method: 'window/logMessage', params: { type: 4, message } })
const release = (): void => {
  if (held) send(held)
  held = undefined
}
const docOf = (params: unknown): { uri: string; version: number } => {
  const doc = (params as { textDocument?: { uri?: string; version?: number } } | undefined)?.textDocument
  return { uri: doc?.uri ?? '', version: doc?.version ?? 0 }
}

for await (const value of frames(Bun.stdin.stream())) {
  if (!isMessage(value)) continue
  const { id, method, params } = value
  const { uri, version } = docOf(params)
  if (method === 'initialize') {
    log(`env ${process.env['TS_NATIVE_LSP_ENV_PROBE'] ?? 'unset'}`)
    send({ id, result: { capabilities: { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } } } })
  } else if (method === 'textDocument/didOpen') {
    versions.set(uri, version)
  } else if (method === 'textDocument/didChange') {
    versions.set(uri, version)
    release()
  } else if (method === 'textDocument/didClose') {
    release()
  } else if (method === '$/cancelRequest') {
    // name whether the cancel is for the answer the stub holds
    const cancelled = (params as { id?: unknown } | undefined)?.id
    log(held && cancelled === held.id ? 'cancelled held' : 'cancelled other')
  } else if (method === '$/test/refresh') {
    send({ id: 'stub-refresh', method: 'workspace/diagnostic/refresh' })
    release()
  } else if (method === 'textDocument/diagnostic') {
    pulls++
    log(`pull ${uri}`)
    if (mode === 'retrigger' && uri.includes('cancel')) {
      send({ id, error: { code: -32802, message: 'cancelled' } })
      continue
    }
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
    const answer = (tag: string): { id: unknown; result: unknown } => ({ id, result: { kind: 'full', items: [{ severity: 1, message: `v${versions.get(uri)}${tag}`, range }] } })
    if (mode === 'hold' && pulls === 1) {
      held = answer('-held')
      log('first pull')
    } else send(answer(''))
  } else if (method === 'shutdown') {
    if (mode === 'slow-shutdown') setTimeout(() => send({ id, result: null }), 300)
    else send({ id, result: null })
  } else if (method === 'exit') {
    process.exit(0)
  }
}
if (mode === 'stubborn') setInterval(() => {}, 1000)
