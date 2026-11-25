// lsp relay between claude code and a server that serves diagnostics only on request
// (textDocument/diagnostic), such as typescript 7's tsc --lsp. claude code reads only
// pushed textDocument/publishDiagnostics, so the relay pulls diagnostics for every open
// document after each change and pushes them to the client. everything else passes through.
// usage: bun relay.ts <server command> [args...]

type Id = number | string
export interface Message {
  jsonrpc?: unknown
  id?: Id | null
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

interface Doc { version: number; resultId?: string | undefined; items: unknown[] }
interface Pull { uri: string; doc: Doc; round: number }

const PULL_DELAY_MS = 150
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

function uriOf(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params['textDocument'])) return undefined
  const uri = params['textDocument']['uri']
  return typeof uri === 'string' ? uri : undefined
}

function versionOf(params: unknown): number {
  if (!isRecord(params) || !isRecord(params['textDocument'])) return 0
  const v = params['textDocument']['version']
  return typeof v === 'number' ? v : 0
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

  const server = Bun.spawn([command, ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  const toServer = (msg: unknown): void => { server.stdin.write(encode(msg)); void server.stdin.flush() }
  const toClient = (msg: unknown): void => { process.stdout.write(encode(msg)) }

  const docs = new Map<string, Doc>()
  const pending = new Map<Id, Pull>()
  let pullSupported = false
  let closed = false
  let initializeId: Id | null | undefined
  let seq = 0
  // every open, change, close and refresh starts a new round: an answer from an older round
  // describes text that is gone (in this file or in one it imports), so it is dropped
  let round = 0
  // documents whose pull the server cancelled and was pulled again in this round, so a server
  // that keeps cancelling gets one retry per document, not a loop
  const retried = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const newRound = (): void => { round++; retried.clear() }
  const stop = (): void => {
    closed = true
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const publish = (uri: string, doc: Doc): void =>
    toClient({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: doc.version, diagnostics: doc.items } })

  const pull = (uri: string, doc: Doc): void => {
    const id = `${RELAY_ID_PREFIX}${++seq}`
    pending.set(id, { uri, doc, round })
    toServer({ jsonrpc: '2.0', id, method: 'textDocument/diagnostic',
      params: { textDocument: { uri }, ...(doc.resultId ? { previousResultId: doc.resultId } : {}) } })
  }
  const pullAll = (): void => {
    timer = undefined
    if (closed) return
    for (const id of pending.keys()) toServer({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })
    pending.clear()
    for (const [uri, doc] of docs) pull(uri, doc)
  }
  // a change in one file can change the diagnostics of every other open file, so each pull covers them all
  const schedulePull = (): void => {
    if (!pullSupported || closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(pullAll, PULL_DELAY_MS)
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

  void (async () => {
    for await (const value of frames(Bun.stdin.stream())) {
      // frames the relay cannot read pass through untouched
      if (!isMessage(value)) { toServer(value); continue }
      const msg = value
      if (msg.method === 'initialize' && msg.id !== undefined) {
        initializeId = msg.id
        toServer({ ...msg, params: withPullCapability(msg.params) })
        continue
      }
      // after shutdown the client expects no more traffic for documents
      if (msg.method === 'shutdown' || msg.method === 'exit') stop()
      toServer(msg)
      const uri = uriOf(msg.params)
      if (!uri) continue
      if (msg.method === 'textDocument/didOpen') {
        newRound()
        docs.set(uri, { version: versionOf(msg.params), items: [] })
        schedulePull()
      } else if (msg.method === 'textDocument/didChange') {
        newRound()
        const doc = docs.get(uri)
        if (doc) doc.version = versionOf(msg.params)
        schedulePull()
      } else if (msg.method === 'textDocument/didSave') {
        schedulePull()
      } else if (msg.method === 'textDocument/didClose') {
        newRound()
        docs.delete(uri)
        if (pullSupported) {
          toClient({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } })
          // the new round dropped the answers still in flight for the other open documents
          schedulePull()
        }
      }
    }
    // the client closed its end: stop the server, and kill it if it does not exit on its own
    stop()
    server.stdin.end()
    setTimeout(() => server.kill('SIGKILL'), 2000)
  })()

  const fromServer = (async () => {
    for await (const value of frames(server.stdout)) {
      if (!isMessage(value)) { toClient(value); continue }
      const msg = value
      if (msg.method === undefined && isRelayId(msg.id)) {
        // answers to relay pulls, cancelled ones included, never reach the client
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (p) onAnswer(p, msg)
        continue
      }
      if (msg.method === 'workspace/diagnostic/refresh' && msg.id !== undefined) {
        toServer({ jsonrpc: '2.0', id: msg.id, result: null })
        newRound()
        schedulePull()
        continue
      }
      if (initializeId !== undefined && msg.id === initializeId && msg.method === undefined) {
        const caps = isRecord(msg.result) ? msg.result['capabilities'] : undefined
        pullSupported = isRecord(caps) && caps['diagnosticProvider'] !== undefined
        initializeId = undefined
      }
      toClient(msg)
    }
  })()

  // exit with the server once its last frames are read, written and flushed; a helper that holds
  // the server's stdout open after the server exits delays the exit by at most a second
  void server.exited.then(async (code) => {
    await Promise.race([fromServer, Bun.sleep(1000)])
    await new Promise<void>((resolve) => { process.stdout.write('', () => resolve()) })
    process.exit(code)
  })
}

if (import.meta.main) main(process.argv.slice(2))
