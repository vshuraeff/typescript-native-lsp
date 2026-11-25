// relay behaviour over a stub server whose answers the test controls
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { encode, frames, isMessage, type Message } from '../server/relay'

interface Published { uri: string; version?: number; diagnostics: Array<{ message: string }> }

// starts the relay over the stub server and records what reaches the client, in order
// bunFlags and cwd let a test start the relay the way plugin.json does, from a project directory
async function session(mode: string, opts: { bunFlags?: string[]; cwd?: string; env?: Record<string, string> } = {}) {
  const relay = join(import.meta.dir, '../server/relay.ts')
  const stub = join(import.meta.dir, 'stub-server.ts')
  const proc = Bun.spawn(['bun', ...(opts.bunFlags ?? []), relay, 'bun', '--no-env-file', stub, mode],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', ...(opts.cwd ? { cwd: opts.cwd } : {}), env: { ...process.env, ...opts.env } })
  const send = (msg: Message): void => {
    proc.stdin.write(encode({ jsonrpc: '2.0', ...msg }))
    void proc.stdin.flush()
  }
  const events: string[] = []
  const published: Published[] = []
  // the ids of the server requests the client got, as the relay gave them
  const asked: Array<Exclude<Message['id'], undefined>> = []
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
      if (value.id !== undefined && value.method === undefined) {
        const code = (value.error as { code?: number } | undefined)?.code
        if (code !== undefined) note(`error ${value.id} ${code}`)
        note(`answer ${value.id}`)
      }
      if (value.id !== undefined && value.method !== undefined) {
        asked.push(value.id)
        note(`client got ${value.method}`)
      }
      if (value.method === '$/cancelRequest') note(`client got cancel ${String((value.params as { id?: unknown }).id)}`)
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
  // a request and its answer: everything the relay sends the server before the request is logged before it
  let nextId = 100
  const ask = async (uri: string): Promise<void> => {
    const id = nextId++
    send({ id, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 0, character: 0 } } })
    await seen(`answer ${id}`)
  }
  // the opens and changes the server received for a document, as "open|change <version> <text>"
  const sent = (uri: string): string[] => events
    .filter((e) => e.startsWith(`log open ${uri} `) || e.startsWith(`log change ${uri} `))
    .map((e) => e.slice('log '.length).replace(` ${uri}`, ''))
  return { send, events, seen, stop, messages, ask, sent, proc, asked }
}

const open = (uri: string, version = 1, text = 'a'): Message =>
  ({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version, text } } })
const change = (uri: string, version: number, text: string): Message =>
  ({ method: 'textDocument/didChange', params: { textDocument: { uri, version }, contentChanges: [{ text }] } })
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

// runs a test over real files, which the relay keeps in line with the documents the server holds
async function inProject(run: (file: (name: string, text: string) => { path: string; uri: string }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ts-native-lsp-sync-'))
  try {
    await run((name, text) => {
      const path = join(dir, name)
      writeFileSync(path, text)
      return { path, uri: pathToFileURL(path).href }
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a file changed on disk reaches the server before the next request and is pulled again', async () => {
  await inProject(async (file) => {
    const { path, uri } = file('s.ts', 'one')
    const s = await session('plain')
    s.send(open(uri, 1, 'one'))
    await s.seen(`publish ${uri} 1:v1`)
    writeFileSync(path, 'three')
    await s.ask(uri)
    expect(s.events.indexOf(`log change ${uri} 2 three`)).toBeLessThan(s.events.indexOf('log request textDocument/hover'))
    // the server numbers its own versions, the client keeps seeing its own
    await s.seen(`publish ${uri} 1:v2`)
    s.send(change(uri, 2, 'four'))
    await s.seen(`publish ${uri} 2:v3`)
    await s.stop()
    expect(s.sent(uri)).toEqual(['open 1 one', 'change 2 three', 'change 3 four'])
  })
}, 10000)

test('a file whose mtime and size did not change is not read', async () => {
  await inProject(async (file) => {
    const { path, uri } = file('s.ts', 'one')
    utimesSync(path, 1e9, 1e9)
    const s = await session('plain')
    s.send(open(uri, 1, 'one'))
    await s.ask(uri)
    // new text of the same size under the same mtime: the stat says unchanged
    writeFileSync(path, 'two')
    utimesSync(path, 1e9, 1e9)
    await s.ask(uri)
    await s.stop()
    expect(s.sent(uri)).toEqual(['open 1 one'])
  })
}, 10000)

test("the client's own edit and its later disk write reach the server once", async () => {
  await inProject(async (file) => {
    const { path, uri } = file('s.ts', 'one')
    const s = await session('plain')
    s.send(open(uri, 1, 'one'))
    s.send(change(uri, 2, 'two!'))
    // the file still holds the old text: no revert
    await s.ask(uri)
    writeFileSync(path, 'two!')
    await s.ask(uri)
    await s.stop()
    expect(s.sent(uri)).toEqual(['open 1 one', 'change 2 two!'])
  })
}, 10000)

test('a deleted file is closed on the server and a later client change opens it again', async () => {
  await inProject(async (file) => {
    const { path, uri } = file('s.ts', 'one')
    const s = await session('plain')
    s.send(open(uri, 1, 'one'))
    await s.seen(`publish ${uri} 1:v1`)
    rmSync(path)
    await s.ask(uri)
    expect(s.events).toContain(`log close ${uri}`)
    expect(s.messages(uri)).toEqual(['1:v1', '1:'])
    s.send(change(uri, 2, 'back'))
    await s.seen(`publish ${uri} 2:v2`)
    await s.stop()
    expect(s.sent(uri)).toEqual(['open 1 one', 'open 2 back'])
  })
}, 10000)

test('the client closing a document whose file vanished is not forwarded', async () => {
  await inProject(async (file) => {
    const { path, uri } = file('s.ts', 'one')
    const s = await session('plain')
    s.send(open(uri, 1, 'one'))
    await s.ask(uri)
    rmSync(path)
    await s.ask(uri)
    s.send({ method: 'textDocument/didClose', params: { textDocument: { uri } } })
    await s.ask(uri)
    await s.stop()
    expect(s.events.filter((e) => e === `log close ${uri}`).length).toBe(1)
  })
}, 10000)

test('a file back on disk is opened again', async () => {
  await inProject(async (file) => {
    const { path, uri } = file('s.ts', 'one')
    const s = await session('plain')
    s.send(open(uri, 1, 'one'))
    await s.ask(uri)
    rmSync(path)
    await s.ask(uri)
    writeFileSync(path, 'again')
    await s.ask(uri)
    await s.seen(`publish ${uri} 1:v2`)
    await s.stop()
    expect(s.sent(uri)).toEqual(['open 1 one', 'open 2 again'])
  })
}, 10000)

test('a ranged change is followed by the whole file text', async () => {
  await inProject(async (file) => {
    const { uri } = file('s.ts', 'one')
    const s = await session('plain')
    s.send(open(uri, 1, 'one'))
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
    s.send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ range, text: 'x' }] } })
    await s.ask(uri)
    await s.stop()
    expect(s.sent(uri)).toEqual(['open 1 one', 'change 2 x', 'change 3 one'])
  })
}, 10000)

test('a client that pulls diagnostics itself switches the relay pulls off and gets the refresh', async () => {
  const s = await session('hold')
  s.send(open(a))
  await s.seen('log first pull')
  s.send({ id: 100, method: 'textDocument/diagnostic', params: { textDocument: { uri: a } } })
  await s.seen('answer 100')
  expect(s.events).toContain('log cancelled held')
  // the stub releases its held answer on this change; the relay neither publishes it nor pulls again
  s.send(change(a, 2, 'b'))
  s.send({ method: '$/test/refresh', params: {} })
  await s.seen('client got workspace/diagnostic/refresh')
  await Bun.sleep(400)
  await s.stop()
  expect(s.messages(a)).toEqual([])
  expect(s.events.filter((e) => e === `log pull ${a}`).length).toBe(2)
}, 10000)

// the stub's own record of its lifecycle and of what it received, across the relay's restarts
const lifecycle = (log: string): string[] => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
const sinceLastStart = (log: string): string[] => {
  const lines = lifecycle(log)
  return lines.slice(lines.lastIndexOf('start'))
}
const idle = (log: string): { env: Record<string, string> } => ({ env: { TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS: '1', STUB_LOG: log } })
async function eventually(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

test('an idle server is stopped unseen, and a shutdown while it is stopped starts nothing', async () => {
  await inProject(async (file) => {
    const { path: log } = file('stub.log', '')
    const s = await session('plain', idle(log))
    s.send(open(a))
    await s.seen(`publish ${a} 1:v1`)
    const before = s.events.length
    await eventually(() => lifecycle(log).includes('exit'), 'the idle stop')
    expect(lifecycle(log).slice(-2)).toEqual(['shutdown', 'exit'])
    await s.stop()
    expect(s.events.slice(before)).toEqual(['answer 9'])
    expect(s.proc.exitCode).toBe(0)
    expect(lifecycle(log).filter((l) => l === 'start').length).toBe(1)
  })
}, 10000)

test('no idle stop while a client request waits for its answer', async () => {
  await inProject(async (file) => {
    const { path: log } = file('stub.log', '')
    const s = await session('slow-request', idle(log))
    await s.ask(a)
    expect(lifecycle(log)).not.toContain('shutdown')
    await eventually(() => lifecycle(log).includes('exit'), 'the idle stop after the answer')
    await s.stop()
  })
}, 10000)

test('a restart replays initialize, reopens the documents and forwards the queued messages in order', async () => {
  await inProject(async (file) => {
    const { path: log } = file('stub.log', '')
    const s = await session('plain', idle(log))
    s.send(open(a, 1, 'one'))
    s.send(change(a, 2, 'two'))
    await s.seen(`publish ${a} 2:v2`)
    await eventually(() => lifecycle(log).includes('exit'), 'the idle stop')
    s.send(change(a, 3, 'three'))
    const answered = s.ask(a)
    s.send(change(a, 4, 'four'))
    await answered
    // a new pull round pushes the diagnostics again; the server's versions kept rising
    await s.seen(`publish ${a} 4:v5`)
    await s.stop()
    expect(sinceLastStart(log).slice(0, 8)).toEqual(['start', 'initialize with pull', 'env unset', 'initialized',
      `open ${a} 3 two`, `change ${a} 4 three`, 'request textDocument/hover', `change ${a} 5 four`])
  })
}, 10000)

test('a restart that fails answers the queued request with ContentModified and the next message retries', async () => {
  await inProject(async (file) => {
    const { path: log } = file('stub.log', '')
    const s = await session('plain', idle(log))
    s.send(open(a))
    await s.seen(`publish ${a} 1:v1`)
    await eventually(() => lifecycle(log).includes('exit'), 'the idle stop')
    writeFileSync(`${log}.down`, '')
    await s.ask(a)
    expect(s.events).toContain('error 100 -32801')
    rmSync(`${log}.down`)
    await s.ask(a)
    await s.stop()
    expect(s.events.some((e) => e.startsWith('error 101'))).toBe(false)
    expect(lifecycle(log)).toContain('down')
    expect(sinceLastStart(log)).toContain(`open ${a} 2 a`)
  })
}, 10000)

test('an unanswered server request does not hold off the idle stop, and only the new server gets an answer under its id', async () => {
  await inProject(async (file) => {
    const { path: log } = file('stub.log', '')
    const s = await session('plain', idle(log))
    s.send({ method: '$/test/ask', params: { id: 'q' } })
    await s.seen('client got workspace/configuration')
    await eventually(() => lifecycle(log).includes('exit'), 'the idle stop with the request unanswered')
    // the restarted server asks again under the same id of its own
    s.send({ method: '$/test/ask', params: { id: 'q' } })
    await eventually(() => s.asked.length === 2, 'the request of the restarted server')
    const [old = null, current = null] = s.asked
    expect(old).not.toBe(current)
    s.send({ id: old, result: ['old'] })
    s.send({ id: current, result: ['new'] })
    await eventually(() => lifecycle(log).some((l) => l.startsWith('answered')), 'the answer')
    await s.ask(a)
    await s.stop()
    expect(lifecycle(log).filter((l) => l.startsWith('answered'))).toEqual(['answered q ["new"]'])
  })
}, 10000)

// 300 ms: each refresh is pulled, and the pulls must not start the idle period again; 100 ms: the
// pull timer is always set, and a refresh after the period ran out must not put the stop off
for (const every of ['300', '100']) {
  test(`a server that refreshes every ${every} ms is still stopped when idle`, async () => {
    await inProject(async (file) => {
      const { path: log } = file('stub.log', '')
      const s = await session('plain', { env: { ...idle(log).env, STUB_REFRESH_MS: every } })
      s.send(open(a))
      await s.seen(`publish ${a} 1:v1`)
      await eventually(() => lifecycle(log).includes('exit'), 'the idle stop')
      await s.stop()
    })
  }, 10000)
}

test('a pull in flight at the idle deadline delays the stop and its diagnostics are published', async () => {
  await inProject(async (file) => {
    const { path: log } = file('stub.log', '')
    const s = await session('slow-pull', idle(log))
    s.send(open(a))
    // the stub answers 1500 ms after the pull, past the one second idle period
    await Bun.sleep(1300)
    expect(lifecycle(log)).not.toContain('shutdown')
    await s.seen(`publish ${a} 1:v1`)
    const published = Date.now()
    await eventually(() => lifecycle(log).includes('exit'), 'the idle stop after the answer')
    // the stop follows the answer at once, without a new idle period
    expect(Date.now() - published).toBeLessThan(700)
    await s.stop()
  })
}, 10000)

test('an idle period too long for a timer keeps the server running', async () => {
  await inProject(async (file) => {
    const { path: log } = file('stub.log', '')
    const s = await session('plain', { env: { TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS: '9999999', STUB_LOG: log } })
    s.send(open(a))
    await s.seen(`publish ${a} 1:v1`)
    await Bun.sleep(300)
    expect(lifecycle(log)).not.toContain('shutdown')
    await s.stop()
  })
}, 10000)

test('a restart whose initialize gets an error answers the queued request with ContentModified and the next message retries', async () => {
  await inProject(async (file) => {
    const { path: log } = file('stub.log', '')
    const s = await session('plain', idle(log))
    s.send(open(a))
    await s.seen(`publish ${a} 1:v1`)
    await eventually(() => lifecycle(log).includes('exit'), 'the idle stop')
    writeFileSync(`${log}.initerror`, '')
    await s.ask(a)
    expect(s.events).toContain('error 100 -32801')
    rmSync(`${log}.initerror`)
    await s.ask(a)
    await s.stop()
    expect(s.events.some((e) => e.startsWith('error 101'))).toBe(false)
    expect(sinceLastStart(log)).toContain(`open ${a} 2 a`)
  })
}, 10000)

test('the client sees the first server registration once across a restart', async () => {
  await inProject(async (file) => {
    const { path: log } = file('stub.log', '')
    const s = await session('plain', { env: { ...idle(log).env, STUB_REGISTER: '1' } })
    await s.seen('client got client/registerCapability')
    s.send({ id: s.asked[0] ?? null, result: null })
    await eventually(() => lifecycle(log).includes('exit'), 'the idle stop')
    await s.ask(a)
    await eventually(() => lifecycle(log).filter((l) => l === 'answered stub-register').length === 2, 'the local answer')
    await s.stop()
    expect(s.events.filter((e) => e === 'client got client/registerCapability').length).toBe(1)
  })
}, 10000)

test('a refresh answered while the idle stop waits for a pull is made up when a client message cancels the stop', async () => {
  await inProject(async (file) => {
    const { path: log } = file('stub.log', '')
    // the stub refreshes at 1.2 s; its pull answers at about 1.65 s, past the one second idle period
    const s = await session('slow-pull', { env: { ...idle(log).env, STUB_REFRESH_MS: '1200' } })
    const pulls = (): number => lifecycle(log).filter((l) => l === `pull ${a}`).length
    s.send(open(a))
    await eventually(() => lifecycle(log).includes('answered stub-refresh'), 'the refresh')
    expect(pulls()).toBe(1)
    await s.ask(a)
    await eventually(() => pulls() === 2, 'the pull that makes up the refresh')
    // the second pull must come from the same server, not from a restart that reopens the document
    expect(lifecycle(log).filter((l) => l === 'start').length).toBe(1)
    expect(lifecycle(log)).not.toContain('shutdown')
    await s.stop()
  })
}, 10000)

test('a client answer to a server request that comes while the server stops is not written to it', async () => {
  await inProject(async (file) => {
    const { path: log } = file('stub.log', '')
    const s = await session('slow-shutdown', idle(log))
    s.send({ method: '$/test/ask', params: { id: 'q' } })
    await s.seen('client got workspace/configuration')
    await eventually(() => lifecycle(log).includes('shutdown'), 'the idle stop')
    s.send({ id: s.asked[0] ?? null, result: ['late'] })
    await eventually(() => lifecycle(log).includes('exit'), 'the exit')
    await s.stop()
    expect(lifecycle(log).filter((l) => l.startsWith('answered'))).toEqual([])
  })
}, 10000)

test('a server cancel reaches the client under the id the client knows the request by', async () => {
  await inProject(async (file) => {
    const { path: log } = file('stub.log', '')
    const s = await session('plain', { env: { STUB_LOG: log } })
    s.send({ method: '$/test/ask', params: { id: 'q' } })
    await s.seen('client got workspace/configuration')
    s.send({ method: '$/test/cancel', params: { id: 'q' } })
    await s.seen('client got cancel')
    expect(s.asked[0]).not.toBe('q')
    expect(s.events).toContain(`client got cancel ${String(s.asked[0])}`)
    // the client still answers a cancelled request, and that answer reaches the server under its own id
    s.send({ id: s.asked[0] ?? null, result: ['late'] })
    await s.ask(a)
    await s.stop()
    expect(lifecycle(log).filter((l) => l.startsWith('answered'))).toEqual(['answered q ["late"]'])
  })
}, 10000)
