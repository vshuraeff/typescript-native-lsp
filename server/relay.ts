// lsp relay between claude code and a server that serves diagnostics only on request
// (textDocument/diagnostic), such as typescript 7's tsc --lsp. claude code reads only
// pushed textDocument/publishDiagnostics, so the relay pulls diagnostics for every open
// document after each change and pushes them to the client. it also keeps every open document in
// line with its file on disk, which changes outside the client too, and stops the server when it
// has been idle, starting it again on the next client message. everything else passes through.
// usage: bun relay.ts <server command> [args...]

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type Id = number | string
export interface Message {
  jsonrpc?: unknown
  id?: Id | null
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

interface Doc {
  // the client's version, which publishDiagnostics echoes
  version: number
  resultId?: string | undefined
  items: unknown[]
  languageId: string
  // the relay's own version toward the server, raised with every open or change it sends
  sent: number
  // the text the server holds, undefined after a ranged change the relay cannot apply
  text: string | undefined
  // false once the file vanished from disk and the relay closed the document on the server
  open: boolean
  // the file of a file: uri, and its stat at the last look; other documents are not synced with disk
  path: string | undefined
  stat: string | undefined
}
interface Pull { uri: string; doc: Doc; round: number }
interface Conn { proc: Bun.Subprocess<'pipe', 'pipe', 'inherit'>; reader: Promise<void> }

const PULL_DELAY_MS = 150
const IDLE_DEFAULT_SECONDS = 600
// the longest delay setTimeout takes: a longer one fires after 1 ms
const MAX_TIMER_MS = 2 ** 31 - 1
// a restart whose initialize gets no answer within this time has failed
const RESTART_TIMEOUT_MS = 60000
const KILL_AFTER_MS = 2000
// the error claude code retries, up to three times with a backoff
const CONTENT_MODIFIED = -32801
const GONE = 'gone'
const SERVER_CANCELLED = -32802
// a random part keeps relay request ids out of the id space of the client's requests
const RELAY_ID_PREFIX = `relay-diagnostic-${crypto.randomUUID()}-`
const isRelayId = (id: Id | null | undefined): id is string => typeof id === 'string' && id.startsWith(RELAY_ID_PREFIX)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// a json-rpc message whose id and method have the types the relay branches on
export function isMessage(v: unknown): v is Message {
  if (!isRecord(v)) return false
  const id = v['id']
  const method = v['method']
  return (id === undefined || id === null || typeof id === 'number' || typeof id === 'string')
    && (method === undefined || typeof method === 'string')
}

export function encode(msg: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

// splits a byte stream into the json values of lsp messages framed by Content-Length headers
export async function* frames(stream: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  let buf = Buffer.alloc(0)
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      const head = buf.indexOf('\r\n\r\n')
      if (head < 0) break
      const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, head).toString('ascii'))?.[1])
      if (!Number.isFinite(len)) throw new Error('lsp frame without Content-Length')
      if (buf.length < head + 4 + len) break
      const value: unknown = JSON.parse(buf.subarray(head + 4, head + 4 + len).toString('utf8'))
      buf = buf.subarray(head + 4 + len)
      yield value
    }
  }
}

// adds pull-diagnostic support to the client capabilities of an initialize request, with the
// diagnostic details the client already accepts for pushed diagnostics
function withPullCapability(params: unknown): unknown {
  if (!isRecord(params)) return params
  const caps = isRecord(params['capabilities']) ? params['capabilities'] : {}
  const text = isRecord(caps['textDocument']) ? caps['textDocument'] : {}
  const workspace = isRecord(caps['workspace']) ? caps['workspace'] : {}
  const pushed = isRecord(text['publishDiagnostics']) ? text['publishDiagnostics'] : {}
  const { versionSupport: _versionSupport, ...details } = pushed
  const own = isRecord(text['diagnostic']) ? text['diagnostic'] : {}
  return {
    ...params,
    capabilities: {
      ...caps,
      textDocument: { ...text, diagnostic: { ...details, ...own, dynamicRegistration: false, relatedDocumentSupport: false } },
      workspace: { ...workspace, diagnostics: { refreshSupport: true } },
    },
  }
}

// a client request that waits for an answer, as opposed to a notification or an answer
function isRequest(msg: Message): msg is Message & { id: Id; method: string } {
  return msg.id !== undefined && msg.id !== null && msg.method !== undefined
}

const ends = (msg: unknown): boolean => isMessage(msg) && (msg.method === 'shutdown' || msg.method === 'exit')

// TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS: seconds without activity before the server stops, 0 never;
// a period setTimeout cannot hold (over about 24 days) is never as well
function idleMsOf(value: string | undefined): number {
  const seconds = value === undefined || value.trim() === '' ? Number.NaN : Number(value)
  const ms = (Number.isFinite(seconds) && seconds >= 0 ? seconds : IDLE_DEFAULT_SECONDS) * 1000
  return ms > MAX_TIMER_MS ? 0 : ms
}

function docField(params: unknown, key: string): unknown {
  return isRecord(params) && isRecord(params['textDocument']) ? params['textDocument'][key] : undefined
}

function uriOf(params: unknown): string | undefined {
  const uri = docField(params, 'uri')
  return typeof uri === 'string' ? uri : undefined
}

function versionOf(params: unknown): number {
  const v = docField(params, 'version')
  return typeof v === 'number' ? v : 0
}

// the text a didChange leaves: the last change when it replaces the whole text, else unknown
function fullText(params: unknown): string | undefined {
  const last = isRecord(params) && Array.isArray(params['contentChanges']) ? params['contentChanges'].at(-1) : undefined
  return isRecord(last) && last['range'] === undefined && typeof last['text'] === 'string' ? last['text'] : undefined
}

// a didOpen or didChange with the version the relay numbers toward the server
function withVersion(msg: Message, version: number): Message {
  if (!isRecord(msg.params) || !isRecord(msg.params['textDocument'])) return msg
  return { ...msg, params: { ...msg.params, textDocument: { ...msg.params['textDocument'], version } } }
}

function pathOf(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined
  try { return fileURLToPath(uri) } catch { return undefined }
}

// mtime and size of a file, GONE when no file is there, undefined when the stat itself failed
function statOf(path: string): string | undefined {
  try {
    const s = statSync(path, { bigint: true })
    return s.isFile() ? `${s.mtimeNs}:${s.size}` : GONE
  } catch (e) {
    const code = isRecord(e) ? e['code'] : undefined
    return code === 'ENOENT' || code === 'ENOTDIR' ? GONE : undefined
  }
}

// a cancelled pull the server asks to repeat; retriggerRequest defaults to true when absent
function retriggers(error: unknown): boolean {
  if (!isRecord(error) || error['code'] !== SERVER_CANCELLED) return false
  return !isRecord(error['data']) || error['data']['retriggerRequest'] !== false
}

export function main(argv: string[]): void {
  const [command, ...args] = argv
  if (!command) {
    console.error('usage: bun relay.ts <server command> [args...]')
    process.exit(2)
  }

  const idleMs = idleMsOf(process.env['TYPESCRIPT_NATIVE_LSP_IDLE_SECONDS'])
  let conn: Conn | undefined
  const write = (c: Conn, msg: unknown): void => { c.proc.stdin.write(encode(msg)); void c.proc.stdin.flush() }
  // goes to the running server; with none, which happens only for the messages queued for a start
  // that failed, a client request is answered with ContentModified and anything else is dropped,
  // since docs keep what the next start reopens
  const toServer = (msg: unknown): void => {
    const request = isMessage(msg) && isRequest(msg) && !isRelayId(msg.id) ? msg.id : undefined
    if (state === 'running' && conn) {
      if (request !== undefined) inflight.add(request)
      write(conn, msg)
    } else if (request !== undefined) {
      toClient({ jsonrpc: '2.0', id: request, error: { code: CONTENT_MODIFIED, message: 'the typescript server failed to start' } })
    }
  }
  const toClient = (msg: unknown): void => { process.stdout.write(encode(msg)) }

  const docs = new Map<string, Doc>()
  const pending = new Map<Id, Pull>()
  let pullSupported = false
  // set by the client's first own textDocument/diagnostic request: from then on it pulls for itself
  let clientPulls = false
  let closed = false
  let initializeId: Id | null | undefined
  let seq = 0
  // every open, change, close, refresh and change found on disk starts a new round: an answer from
  // an older round describes text that is gone (in this file or in one it imports), so it is dropped
  let round = 0
  // documents whose pull the server cancelled and was pulled again in this round, so a server
  // that keeps cancelling gets one retry per document, not a loop
  const retried = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const newRound = (): void => { round++; retried.clear() }
  const clearPullTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const stop = (): void => {
    closed = true
    clearPullTimer()
  }
  // the relay pulls and publishes only while the server serves pulls and the client does not pull itself
  const bridging = (): boolean => pullSupported && !clientPulls && !closed
  const publish = (uri: string, doc: Doc): void =>
    toClient({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: doc.version, diagnostics: doc.items } })

  const pull = (uri: string, doc: Doc): void => {
    const id = `${RELAY_ID_PREFIX}${++seq}`
    pending.set(id, { uri, doc, round })
    toServer({ jsonrpc: '2.0', id, method: 'textDocument/diagnostic',
      params: { textDocument: { uri }, ...(doc.resultId ? { previousResultId: doc.resultId } : {}) } })
  }
  const cancelPulls = (): void => {
    for (const id of pending.keys()) toServer({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })
    pending.clear()
  }
  const pullAll = (): void => {
    timer = undefined
    if (closed || state !== 'running') return
    cancelPulls()
    for (const [uri, doc] of docs) if (doc.open) pull(uri, doc)
    if (idleDue) idleStop()
  }
  // a change in one file can change the diagnostics of every other open file, so each pull covers them all
  const schedulePull = (): void => {
    if (!bridging() || state !== 'running') return
    if (timer) clearTimeout(timer)
    timer = setTimeout(pullAll, PULL_DELAY_MS)
  }

  // monotonic per document, and equal to the client's version while the relay has sent nothing of its own
  const nextVersion = (doc: Doc): number => (doc.sent = Math.max(doc.sent + 1, doc.version))
  const sendOpen = (uri: string, doc: Doc, text: string): void => {
    nextVersion(doc)
    doc.text = text
    doc.open = true
    doc.resultId = undefined
    toServer({ jsonrpc: '2.0', method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: doc.languageId, version: doc.sent, text } } })
  }
  // claude code has no unsaved buffers and says nothing when a file changes outside its own tools
  // (shell commands, git, formatters), so disk is the truth: the server gets each document's file
  // text when it differs from what the server holds, and a closed document when the file is gone
  const syncWithDisk = (): void => {
    let changed = false
    for (const [uri, doc] of docs) {
      if (!doc.path) continue
      const stat = statOf(doc.path)
      if (stat === undefined || stat === doc.stat) continue
      if (stat === GONE) {
        doc.stat = stat
        if (!doc.open) continue
        toServer({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } })
        doc.open = false
        doc.resultId = undefined
        doc.items = []
        if (bridging()) publish(uri, doc)
        changed = true
        continue
      }
      let text: string
      try { text = readFileSync(doc.path, 'utf8') } catch { continue }
      doc.stat = stat
      if (doc.open && text === doc.text) continue
      if (!doc.open) sendOpen(uri, doc, text)
      else {
        nextVersion(doc)
        doc.text = text
        toServer({ jsonrpc: '2.0', method: 'textDocument/didChange',
          params: { textDocument: { uri, version: doc.sent }, contentChanges: [{ text }] } })
      }
      changed = true
    }
    // a file changed on disk is a change like didChange: it can change other files' diagnostics too
    if (changed) {
      newRound()
      schedulePull()
    }
  }

  const onAnswer = (p: Pull, msg: Message): void => {
    if (closed || p.round !== round) return
    const report = msg.result
    if (msg.error !== undefined) {
      if (retriggers(msg.error) && !retried.has(p.uri) && docs.get(p.uri) === p.doc) {
        retried.add(p.uri)
        pull(p.uri, p.doc)
      }
      return
    }
    if (!isRecord(report)) return
    if (typeof report['resultId'] === 'string' || report['kind'] === 'full') {
      p.doc.resultId = typeof report['resultId'] === 'string' ? report['resultId'] : undefined
    }
    if (report['kind'] === 'full' && Array.isArray(report['items'])) p.doc.items = report['items']
    publish(p.uri, p.doc)
  }

  // the server's life: running until an idle stop, stopping until it exits, stopped until the next
  // client message, and starting until it answers the initialize the relay replays to it
  // (asserted wide: the closures below assign it, which narrowing of the initial value does not see)
  let state = 'running' as 'running' | 'stopping' | 'stopped' | 'starting'
  // client messages that came while the server was not running, handled in order once it runs again
  const queue: unknown[] = []
  // client requests the server has not answered
  const inflight = new Set<Id>()
  // server requests forwarded to the client: the id the client sees, made of the server's generation
  // and its own id, mapped to that own id; an answer under an earlier generation's id is dropped,
  // since a restarted server can reuse the id
  const serverRequests = new Map<Id, Id>()
  let generation = 0
  // the client's initialize params with the injected capability, which every restart replays
  let initParams: unknown
  let initialized = false
  // the relay's own shutdown or initialize toward the server, and its kill or give-up timer
  let ownId: string | undefined
  let lifecycleTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let clientEnded = false
  // set by the first restart: the client holds the first server's registrations already
  let restarted = false

  const exitRelay = async (code: number): Promise<void> => {
    await new Promise<void>((resolve) => { process.stdout.write('', () => resolve()) })
    process.exit(code)
  }
  const clearLifecycleTimer = (): void => {
    if (lifecycleTimer) clearTimeout(lifecycleTimer)
    lifecycleTimer = undefined
  }

  // claude code keeps the server until the session ends, and tsc keeps every project it loaded in
  // memory, so a server with nothing to do is stopped; the next client message starts it again.
  // only the client's messages and the answers to its requests start the idle period again: the
  // server's own traffic and the relay's pulls do not, or a server that refreshes on its own would
  // never stop. a client request waiting for its answer holds the stop off; pulls scheduled or in
  // flight when the period runs out delay it until they settle, so their diagnostics are published
  let idleDue = false
  // a refresh answered while the stop waits starts no pull; when a client message cancels the stop,
  // the refresh is made up, and a start pulls every document anyway
  let refreshMissed = false
  const activity = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = undefined
    idleDue = false
    if (refreshMissed) {
      refreshMissed = false
      newRound()
      schedulePull()
    }
    if (idleMs > 0 && state === 'running' && inflight.size === 0 && initParams !== undefined && !closed) {
      idleTimer = setTimeout(idleStop, idleMs)
    }
  }
  const idleStop = (): void => {
    idleTimer = undefined
    idleDue = false
    const c = conn
    if (state !== 'running' || !c || inflight.size > 0 || closed) return
    idleDue = pending.size > 0 || timer !== undefined
    if (idleDue) return
    newRound()
    state = 'stopping'
    // an answer the client still owes the stopping server goes nowhere
    serverRequests.clear()
    ownId = `${RELAY_ID_PREFIX}shutdown-${++seq}`
    write(c, { jsonrpc: '2.0', id: ownId, method: 'shutdown' })
    lifecycleTimer = setTimeout(() => c.proc.kill('SIGKILL'), KILL_AFTER_MS)
  }

  const start = (): void => {
    state = 'starting'
    restarted = true
    generation++
    serverRequests.clear()
    refreshMissed = false
    try {
      conn = spawnServer()
    } catch {
      failStart()
      return
    }
    ownId = `${RELAY_ID_PREFIX}initialize-${++seq}`
    write(conn, { jsonrpc: '2.0', id: ownId, method: 'initialize', params: initParams })
    lifecycleTimer = setTimeout(failStart, RESTART_TIMEOUT_MS)
  }
  const onStarted = (c: Conn): void => {
    clearLifecycleTimer()
    if (initialized) write(c, { jsonrpc: '2.0', method: 'initialized', params: {} })
    state = 'running'
    // the new server knows no document: each one the old server held goes back with the text it had
    for (const [uri, doc] of docs) {
      if (!doc.open) continue
      let text = doc.text
      if (text === undefined && doc.path) {
        try { text = readFileSync(doc.path, 'utf8') } catch { text = undefined }
      }
      if (text === undefined) doc.open = false
      else sendOpen(uri, doc, text)
    }
    newRound()
    for (const msg of queue.splice(0)) handle(msg)
    schedulePull()
    activity()
  }
  // the server did not start: the queued requests fail with ContentModified, which claude code
  // retries, and the retry starts the server again; the queued document changes stay in docs
  const failStart = (): void => {
    if (state !== 'starting') return
    clearLifecycleTimer()
    const c = conn
    conn = undefined
    state = 'stopped'
    c?.proc.kill('SIGKILL')
    for (const msg of queue.splice(0)) handle(msg)
  }

  const onServerExit = async (c: Conn, code: number): Promise<void> => {
    if (c !== conn) return
    clearLifecycleTimer()
    if (!clientEnded && state === 'stopping') {
      conn = undefined
      state = 'stopped'
      if (queue.length > 0 && !closed) start()
      return
    }
    if (!clientEnded && state === 'starting') {
      failStart()
      return
    }
    // the server exited on its own or after the client's exit: the relay exits with it once the
    // server's last frames are read; a helper that holds the server's stdout open after the server
    // exits delays the exit by at most a second
    await Promise.race([c.reader, Bun.sleep(1000)])
    await exitRelay(code)
  }

  const readServer = async (c: Conn): Promise<void> => {
    for await (const value of frames(c.proc.stdout)) {
      // a stopped or stopping server is the relay's business alone
      if (c !== conn) continue
      if (isMessage(value) && value.method === undefined && value.id !== undefined && value.id === ownId) {
        if (state === 'stopping') {
          write(c, { jsonrpc: '2.0', method: 'exit' })
          c.proc.stdin.end()
        } else if (state === 'starting') {
          if (value.error !== undefined) failStart()
          else onStarted(c)
        }
        continue
      }
      if (state === 'stopping') continue
      if (!isMessage(value)) { toClient(value); continue }
      const msg = value
      if (msg.method === undefined && isRelayId(msg.id)) {
        // answers to relay pulls, cancelled ones included, never reach the client
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (p) onAnswer(p, msg)
        if (idleDue) idleStop()
        continue
      }
      // a restarted server registers what the client holds from the first one: answered here, not forwarded
      if (restarted && isRequest(msg) && (msg.method === 'client/registerCapability' || msg.method === 'client/unregisterCapability')) {
        write(c, { jsonrpc: '2.0', id: msg.id, result: null })
        continue
      }
      // once the client pulls itself, the refresh is its business and is forwarded; one that comes
      // after the idle period ran out is made up when the stop is cancelled (see activity)
      if (msg.method === 'workspace/diagnostic/refresh' && msg.id !== undefined && !clientPulls) {
        write(c, { jsonrpc: '2.0', id: msg.id, result: null })
        if (idleDue) refreshMissed = true
        else {
          newRound()
          schedulePull()
        }
        continue
      }
      // the server cancels its own request by the id it asked with, which the client knows scoped;
      // the client still answers a cancelled request, so the mapping stays until that answer
      if (msg.method === '$/cancelRequest' && msg.id === undefined && isRecord(msg.params)) {
        const id = `${generation}:${JSON.stringify(msg.params['id'])}`
        if (serverRequests.has(id)) {
          toClient({ ...msg, params: { ...msg.params, id } })
          continue
        }
      }
      if (initializeId !== undefined && msg.id === initializeId && msg.method === undefined) {
        const caps = isRecord(msg.result) ? msg.result['capabilities'] : undefined
        pullSupported = isRecord(caps) && caps['diagnosticProvider'] !== undefined
        initializeId = undefined
      }
      if (msg.id !== undefined && msg.id !== null && msg.method !== undefined) {
        // json keeps a number id apart from a string id with the same digits
        const id = `${generation}:${JSON.stringify(msg.id)}`
        serverRequests.set(id, msg.id)
        toClient({ ...msg, id })
        continue
      }
      if (msg.id !== undefined && msg.id !== null) inflight.delete(msg.id)
      toClient(msg)
      if (msg.method === undefined) activity()
    }
  }
  const spawnServer = (): Conn => {
    const proc = Bun.spawn([command, ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
    const c: Conn = { proc, reader: Promise.resolve() }
    c.reader = readServer(c)
    void proc.exited.then((code) => onServerExit(c, code))
    return c
  }

  const handle = (value: unknown): void => {
    // frames the relay cannot read pass through untouched
    if (!isMessage(value)) { toServer(value); return }
    const msg = value
    if (msg.method === 'initialize' && msg.id !== undefined) {
      initializeId = msg.id
      initParams = withPullCapability(msg.params)
      toServer({ ...msg, params: initParams })
      return
    }
    if (msg.method === 'initialized') initialized = true
    // after shutdown the client expects no more traffic for documents
    if (ends(msg)) stop()
    if (state !== 'running' && ends(msg)) {
      // no server is running to answer: the relay answers for it and starts none
      if (msg.method === 'exit') {
        conn?.proc.kill('SIGKILL')
        void exitRelay(0)
      } else if (msg.id !== undefined) toClient({ jsonrpc: '2.0', id: msg.id, result: null })
      return
    }
    if (msg.method === 'textDocument/diagnostic' && isRequest(msg) && !clientPulls) {
      // decided on the request itself: claude code advertises capabilities it does not use
      clientPulls = true
      clearPullTimer()
      cancelPulls()
    }
    // a request reads the server's view of the documents, so that view must match disk first
    if (isRequest(msg) && !closed) syncWithDisk()
    const uri = uriOf(msg.params)
    const doc = uri === undefined ? undefined : docs.get(uri)
    if (uri === undefined) {
      toServer(msg)
    } else if (msg.method === 'textDocument/didOpen') {
      newRound()
      const path = pathOf(uri)
      const languageId = docField(msg.params, 'languageId')
      const text = docField(msg.params, 'text')
      // the stat at open time: the client opens with the file's text, or with the text the file is about to get
      const opened: Doc = { version: versionOf(msg.params), items: [], languageId: typeof languageId === 'string' ? languageId : '',
        sent: 0, text: typeof text === 'string' ? text : undefined, open: true, path, stat: path === undefined ? undefined : statOf(path) }
      docs.set(uri, opened)
      toServer(withVersion(msg, nextVersion(opened)))
      schedulePull()
    } else if (msg.method === 'textDocument/didChange' && doc) {
      newRound()
      doc.version = versionOf(msg.params)
      const text = fullText(msg.params)
      if (doc.open) {
        doc.text = text
        // a ranged change leaves the text unknown: the next sync compares the file and sends it whole
        if (text === undefined) doc.stat = undefined
        toServer(withVersion(msg, nextVersion(doc)))
      } else if (text !== undefined) {
        // the relay closed it when its file vanished, and typescript 7 crashes on a change to a
        // document it never saw opened
        sendOpen(uri, doc, text)
      }
      schedulePull()
    } else if (msg.method === 'textDocument/didSave') {
      if (!doc || doc.open) toServer(msg)
      schedulePull()
    } else if (msg.method === 'textDocument/didClose') {
      newRound()
      docs.delete(uri)
      // the relay already closed it on the server when its file vanished
      if (!doc || doc.open) toServer(msg)
      if (bridging()) {
        toClient({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } })
        // the new round dropped the answers still in flight for the other open documents
        schedulePull()
      }
    } else {
      toServer(msg)
    }
  }

  conn = spawnServer()
  void (async () => {
    for await (const value of frames(Bun.stdin.stream())) {
      if (isMessage(value) && value.method === undefined && value.id !== undefined && value.id !== null) {
        // an answer to a request of the running server goes to it under the id it asked with
        const id = serverRequests.get(value.id)
        if (conn && id !== undefined && serverRequests.delete(value.id)) write(conn, { ...value, id })
      } else if (state === 'running' && queue.length === 0) {
        handle(value)
      } else if (queue.length === 0 && state !== 'starting' && ends(value)) {
        handle(value)
      } else {
        queue.push(value)
        if (state === 'stopped' && !closed) start()
      }
      activity()
    }
    // the client closed its end: stop the server, and kill it if it does not exit on its own
    clientEnded = true
    stop()
    const c = conn
    if (!c) {
      await exitRelay(0)
      return
    }
    c.proc.stdin.end()
    setTimeout(() => c.proc.kill('SIGKILL'), KILL_AFTER_MS)
  })()
}

if (import.meta.main) main(process.argv.slice(2))
