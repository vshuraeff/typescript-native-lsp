// relay behaviour over a stub server whose answers the test controls
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encode, frames, isMessage, type Message } from '../server/relay'

interface Published { uri: string; version?: number; diagnostics: Array<{ message: string }> }

// starts the relay over the stub server and records what reaches the client, in order
// bunFlags and cwd let a test start the relay the way plugin.json does, from a project directory
async function session(mode: string, opts: { bunFlags?: string[]; cwd?: string } = {}) {
  const relay = join(import.meta.dir, '../server/relay.ts')
  const stub = join(import.meta.dir, 'stub-server.ts')
  const proc = Bun.spawn(['bun', ...(opts.bunFlags ?? []), relay, 'bun', '--no-env-file', stub, mode],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', ...(opts.cwd ? { cwd: opts.cwd } : {}) })
  const send = (msg: Message): void => {
    proc.stdin.write(encode({ jsonrpc: '2.0', ...msg }))
    void proc.stdin.flush()
  }
  const events: string[] = []
  const published: Published[] = []
  const waiters: Array<{ match: string; resolve: () => void }> = []
  const note = (event: string): void => {
    events.push(event)
    for (const w of waiters.filter((w) => event.includes(w.match))) w.resolve()
  }
  const seen = (match: string): Promise<void> => new Promise((resolve) => {
    if (events.some((e) => e.includes(match))) resolve()
    else waiters.push({ match, resolve })
  })
  void (async () => {
    for await (const value of frames(proc.stdout)) {
      if (!isMessage(value)) continue
      if (value.id === 1) note('initialized')
      if (value.method === 'window/logMessage') note(`log ${(value.params as { message: string }).message}`)
      if (value.method === 'textDocument/publishDiagnostics') {
        const p = value.params as Published
        published.push(p)
        note(`publish ${p.uri} ${p.version}:${p.diagnostics.map((d) => d.message).join(',')}`)
      }
    }
  })()
  send({ id: 1, method: 'initialize', params: { processId: process.pid, rootUri: null, capabilities: {} } })
  await seen('initialized')
  send({ method: 'initialized', params: {} })
  // exitDelay holds exit back, so the relay outlives shutdown the way a slow server makes it
  const stop = async (exitDelay = 0): Promise<void> => {
    send({ id: 9, method: 'shutdown' })
    if (exitDelay) await Bun.sleep(exitDelay)
    send({ method: 'exit' })
    proc.stdin.end()
    await proc.exited
  }
  const messages = (uri: string): string[] =>
    published.filter((p) => p.uri === uri).map((p) => `${p.version}:${p.diagnostics.map((d) => d.message).join(',')}`)
  return { send, events, seen, stop, messages, proc }
}

const open = (uri: string, version = 1): Message =>
  ({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version, text: 'a' } } })
const a = 'file:///probe/a.ts'
const b = 'file:///probe/b.ts'

test('an answer that a change overtook is dropped', async () => {
  const s = await session('hold')
  s.send(open(a))
  await s.seen('log first pull')
  // the stub releases its held v1 answer on this change, before the relay pulls again
  s.send({ method: 'textDocument/didChange', params: { textDocument: { uri: a, version: 2 }, contentChanges: [{ text: 'b' }] } })
  await s.seen(`publish ${a} 2:v2`)
  await s.stop()
  expect(s.messages(a)).toEqual(['2:v2'])
}, 10000)

test('closing one document still delivers the others', async () => {
  const s = await session('hold')
  s.send(open(a))
  s.send(open(b))
  await s.seen('log first pull')
  s.send({ method: 'textDocument/didClose', params: { textDocument: { uri: b } } })
  await s.seen(`publish ${a} 1:v1`)
  await s.stop()
  expect(s.messages(a).some((m) => m.includes('held'))).toBe(false)
}, 10000)

test('a superseded pull is cancelled', async () => {
  const s = await session('hold')
  s.send(open(a))
  await s.seen('log first pull')
  s.send({ method: 'textDocument/didSave', params: { textDocument: { uri: a } } })
  await s.seen('log cancelled held')
  await s.stop()
}, 10000)

test('a refresh drops the answer in flight', async () => {
  const s = await session('hold')
  s.send(open(a))
  await s.seen('log first pull')
  s.send({ method: '$/test/refresh', params: {} })
  await s.seen(`publish ${a} 1:v1`)
  await s.stop()
  expect(s.messages(a)).toEqual(['1:v1'])
}, 10000)

test('no pull goes out after shutdown', async () => {
  const s = await session('slow-shutdown')
  s.send(open(a))
  await s.seen(`publish ${a} 1:v1`)
  s.send({ method: 'textDocument/didChange', params: { textDocument: { uri: a, version: 2 }, contentChanges: [{ text: 'b' }] } })
  await Bun.sleep(50)
  s.events.push('shutdown sent')
  await s.stop(400)
  const after = s.events.slice(s.events.indexOf('shutdown sent'))
  expect(after.some((e) => e.startsWith('log pull'))).toBe(false)
}, 10000)

test('a server that keeps cancelling gets one retry per document', async () => {
  const s = await session('retrigger')
  const c = 'file:///probe/cancel.ts'
  s.send(open(c))
  s.send(open(b))
  await s.seen(`publish ${b} 1:v1`)
  await Bun.sleep(500)
  await s.stop()
  expect(s.events.filter((e) => e === `log pull ${c}`).length).toBe(2)
  expect(s.events.filter((e) => e === `log pull ${b}`).length).toBe(1)
}, 10000)

test('a non-ascii uri passes through the relay', async () => {
  const s = await session('plain')
  const u = 'file:///probe/тест.ts'
  s.send(open(u))
  await s.seen(`publish ${u} 1:v1`)
  await s.stop()
}, 10000)

test('frames reassembles messages split at every byte', async () => {
  const messages = [{ jsonrpc: '2.0', method: 'm', params: { text: 'тест ✓' } }, { jsonrpc: '2.0', id: 1, result: 'ünï' }]
  const bytes = Buffer.concat(messages.map((m) => Buffer.from(encode(m))))
  async function* oneByte(): AsyncGenerator<Uint8Array> {
    for (const byte of bytes) yield Uint8Array.of(byte)
  }
  const got: unknown[] = []
  for await (const value of frames(oneByte())) got.push(value)
  expect(got).toEqual(messages)
})

test('a server that ignores the end of input and SIGTERM is killed', async () => {
  const s = await session('stubborn')
  // the client goes away without shutdown or exit
  s.proc.stdin.end()
  const exited = await Promise.race([s.proc.exited.then(() => true), Bun.sleep(5000).then(() => false)])
  if (!exited) s.proc.kill('SIGKILL')
  expect(exited).toBe(true)
}, 10000)

test('a project .env does not reach the server', async () => {
  // the bun flags plugin.json puts before the relay script
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../.claude-plugin/plugin.json'), 'utf8')) as unknown
  const args = (manifest as { lspServers?: { typescript?: { args?: unknown } } }).lspServers?.typescript?.args
  if (!Array.isArray(args)) throw new Error('plugin.json declares no args')
  const root = join(import.meta.dir, '..')
  const flags = args.slice(0, args.findIndex((a) => String(a).endsWith('/server/relay.ts')))
    .map((a) => String(a).replaceAll('${CLAUDE_PLUGIN_ROOT}', root))
  const dir = mkdtempSync(join(tmpdir(), 'ts-native-lsp-env-'))
  writeFileSync(join(dir, '.env'), 'TS_NATIVE_LSP_ENV_PROBE=loaded\n')
  try {
    const s = await session('plain', { bunFlags: flags, cwd: dir })
    await s.seen('log env')
    await s.stop()
    expect(s.events).toContain('log env unset')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 10000)
