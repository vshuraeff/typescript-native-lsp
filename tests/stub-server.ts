// stub lsp server for relay tests. it announces pull diagnostics, names in each report the
// document version it saw, reports what it receives as window/logMessage (each open, change and
// close with the version and text it carries) and answers other requests with null. modes:
// hold: holds its first pull answer until the next didChange, didClose or test refresh
// slow-shutdown: answers shutdown 300 ms late
// retrigger: cancels every pull of a uri containing "cancel" with ServerCancelled
// stubborn: ignores SIGTERM and the end of its input, so only SIGKILL stops it
// slow-request: answers the requests it has no other use for 1200 ms late
// slow-pull: answers every pull 1500 ms late
// with STUB_LOG set it also appends what it logs and its own lifecycle to that file, one line per
// event, so a test can follow it across relay restarts; while <STUB_LOG>.down exists it fails to start,
// and while <STUB_LOG>.initerror exists it answers initialize with an error. with STUB_REGISTER set
// it sends client/registerCapability after initialized, and with STUB_REFRESH_MS set it sends
// workspace/diagnostic/refresh every that many milliseconds once initialized. a $/test/ask
// notification makes it send a request under the given id, and $/test/cancel cancels that request
import { appendFileSync, existsSync } from 'node:fs'

import { encode, frames, isMessage } from '../server/relay'

const mode = process.argv[2] ?? 'plain'
const lifeLog = process.env['STUB_LOG']
const record = (line: string): void => { if (lifeLog) appendFileSync(lifeLog, `${line}\n`) }
if (lifeLog && existsSync(`${lifeLog}.down`)) {
  record('down')
  process.exit(3)
}
record('start')
if (mode === 'stubborn') process.on('SIGTERM', () => {})
const versions = new Map<string, number>()
let held: { id: unknown; result: unknown } | undefined
let pulls = 0

const send = (msg: object): void => { process.stdout.write(encode({ jsonrpc: '2.0', ...msg })) }
const log = (message: string): void => {
  record(message)
  send({ method: 'window/logMessage', params: { type: 4, message } })
}
const release = (): void => {
  if (held) send(held)
  held = undefined
}
const docOf = (params: unknown): { uri: string; version: number; text: string } => {
  const doc = (params as { textDocument?: { uri?: string; version?: number; text?: string } } | undefined)?.textDocument
  return { uri: doc?.uri ?? '', version: doc?.version ?? 0, text: doc?.text ?? '' }
}
const changesOf = (params: unknown): string =>
  ((params as { contentChanges?: Array<{ text?: string }> } | undefined)?.contentChanges ?? []).map((c) => c.text).join('|')

for await (const value of frames(Bun.stdin.stream())) {
  if (!isMessage(value)) continue
  const { id, method, params } = value
  const { uri, version, text } = docOf(params)
  if (method === 'initialize') {
    const pullCapability = (params as { capabilities?: { textDocument?: { diagnostic?: unknown } } } | undefined)?.capabilities?.textDocument?.diagnostic
    record(`initialize ${pullCapability ? 'with' : 'without'} pull`)
    log(`env ${process.env['TS_NATIVE_LSP_ENV_PROBE'] ?? 'unset'}`)
    if (lifeLog && existsSync(`${lifeLog}.initerror`)) send({ id, error: { code: -32603, message: 'initialize failed' } })
    else send({ id, result: { capabilities: { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } } } })
  } else if (method === 'initialized') {
    record('initialized')
    if (process.env['STUB_REGISTER']) send({ id: 'stub-register', method: 'client/registerCapability', params: { registrations: [] } })
    const every = Number(process.env['STUB_REFRESH_MS'])
    if (every > 0) setInterval(() => send({ id: 'stub-refresh', method: 'workspace/diagnostic/refresh' }), every)
  } else if (method === 'textDocument/didOpen') {
    versions.set(uri, version)
    log(`open ${uri} ${version} ${text}`)
  } else if (method === 'textDocument/didChange') {
    versions.set(uri, version)
    log(`change ${uri} ${version} ${changesOf(params)}`)
    release()
  } else if (method === 'textDocument/didClose') {
    log(`close ${uri}`)
    release()
  } else if (method === '$/cancelRequest') {
    // name whether the cancel is for the answer the stub holds
    const cancelled = (params as { id?: unknown } | undefined)?.id
    log(held && cancelled === held.id ? 'cancelled held' : 'cancelled other')
  } else if (method === '$/test/cancel') {
    send({ method: '$/cancelRequest', params: { id: (params as { id?: unknown } | undefined)?.id } })
  } else if (method === '$/test/ask') {
    const asked = String((params as { id?: unknown } | undefined)?.id)
    log(`asked ${asked}`)
    send({ id: asked, method: 'workspace/configuration', params: { items: [] } })
  } else if (method === undefined && id !== undefined) {
    const result = (value as { result?: unknown }).result
    log(`answered ${String(id)}${result === null || result === undefined ? '' : ` ${JSON.stringify(result)}`}`)
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
    } else if (mode === 'slow-pull') setTimeout(() => send(answer('')), 1500)
    else send(answer(''))
  } else if (method === 'shutdown') {
    record('shutdown')
    if (mode === 'slow-shutdown') setTimeout(() => send({ id, result: null }), 300)
    else send({ id, result: null })
  } else if (method === 'exit') {
    record('exit')
    process.exit(0)
  } else if (id !== undefined && method !== undefined) {
    log(`request ${method}`)
    if (mode === 'slow-request') setTimeout(() => send({ id, result: null }), 1200)
    else send({ id, result: null })
  }
}
if (mode === 'stubborn') setInterval(() => {}, 1000)
