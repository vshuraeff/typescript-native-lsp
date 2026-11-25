// end-to-end check of the server plugin.json declares: it starts the relay over the real tsc --lsp,
// speaks as a client that reads only pushed diagnostics, and checks what arrives.
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { encode, frames, isMessage, type Message } from '../server/relay'

interface Server { command: string; args: string[] }
interface Published { uri: string; diagnostics: Array<{ severity?: number; message: string }> }

const root = join(import.meta.dir, '..')

function typescriptServer(manifest: unknown): Server {
  const server = (manifest as { lspServers?: { typescript?: { command?: unknown; args?: unknown } } } | null)?.lspServers?.typescript
  if (typeof server?.command !== 'string' || !Array.isArray(server.args) || !server.args.every((a) => typeof a === 'string')) {
    throw new Error('plugin.json declares no typescript server with a command and string args')
  }
  return { command: server.command, args: server.args }
}

test('diagnostics, a cross-file fix, hover and close over the real tsc', async () => {
  const server = typescriptServer(JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')))
  const dir = mkdtempSync(join(tmpdir(), 'ts-native-lsp-'))
  const a = join(dir, 'a.ts')
  const b = join(dir, 'b.ts')
  const aUri = pathToFileURL(a).href
  const bUri = pathToFileURL(b).href
  const aNumber = 'export const value: number = 1\n'
  const aString = 'export const value: string = "one"\n'
  const bText = 'import { value } from "./a"\nexport const label: string = value\n'
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }))
  writeFileSync(a, aNumber)
  writeFileSync(b, bText)

  const args = server.args.map((s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', root))
  // run from the project directory, as claude code does, so a project bunfig.toml would be in reach
  writeFileSync(join(dir, 'bunfig.toml'), 'preload = ["./noise.ts"]\n')
  writeFileSync(join(dir, 'noise.ts'), 'await Bun.write(import.meta.dir + "/preload-ran", "")\n')
  const proc = Bun.spawn([server.command, ...args], { cwd: dir, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  const send = (msg: Message): void => {
    proc.stdin.write(encode({ jsonrpc: '2.0', ...msg }))
    void proc.stdin.flush()
  }
  const waiters: Array<(m: Message) => boolean> = []
  const until = (match: (m: Message) => boolean, what: string, ms = 20000): Promise<Message> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
      waiters.push((m) => {
        if (!match(m)) return false
        clearTimeout(timer)
        resolve(m)
        return true
      })
    })
  const published = (uri: string, errors: 'some' | 'none') => (m: Message): boolean => {
    if (m.method !== 'textDocument/publishDiagnostics') return false
    const p = m.params as Published
    const n = p.diagnostics.filter((d) => d.severity === 1).length
    return p.uri === uri && (errors === 'some' ? n > 0 : n === 0)
  }
  void (async () => {
    for await (const value of frames(proc.stdout)) {
      if (!isMessage(value)) continue
      // answer the server's own requests, as a client does
      if (value.id !== undefined && value.method) send({ id: value.id, result: null })
      const i = waiters.findIndex((w) => w(value))
      if (i >= 0) waiters.splice(i, 1)
    }
  })()

  try {
    const init = until((m) => m.id === 1, 'initialize')
    // no textDocument.diagnostic: the client reads only pushed diagnostics, as claude code does
    send({ id: 1, method: 'initialize', params: { processId: process.pid, rootUri: pathToFileURL(dir).href,
      workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'probe' }],
      capabilities: { textDocument: { hover: {}, publishDiagnostics: { relatedInformation: true }, synchronization: { didSave: true } } } } })
    expect((await init).error).toBeUndefined()
    send({ method: 'initialized', params: {} })

    const error = until(published(bUri, 'some'), 'an error in b.ts')
    send({ method: 'textDocument/didOpen', params: { textDocument: { uri: aUri, languageId: 'typescript', version: 1, text: aNumber } } })
    send({ method: 'textDocument/didOpen', params: { textDocument: { uri: bUri, languageId: 'typescript', version: 1, text: bText } } })
    expect(JSON.stringify((await error).params)).toContain('not assignable')

    const fixed = until(published(bUri, 'none'), 'b.ts without errors')
    writeFileSync(a, aString)
    send({ method: 'textDocument/didChange', params: { textDocument: { uri: aUri, version: 2 }, contentChanges: [{ text: aString }] } })
    send({ method: 'textDocument/didSave', params: { textDocument: { uri: aUri } } })
    await fixed

    const hover = until((m) => m.id === 2, 'hover')
    send({ id: 2, method: 'textDocument/hover', params: { textDocument: { uri: bUri }, position: { line: 1, character: 14 } } })
    expect(JSON.stringify((await hover).result)).toContain('string')

    const cleared = until((m) => m.method === 'textDocument/publishDiagnostics' && (m.params as Published).uri === bUri
      && (m.params as Published).diagnostics.length === 0, 'cleared b.ts')
    send({ method: 'textDocument/didClose', params: { textDocument: { uri: bUri } } })
    await cleared
    expect(await Bun.file(join(dir, 'preload-ran')).exists()).toBe(false)
  } finally {
    send({ id: 99, method: 'shutdown' })
    send({ method: 'exit' })
    proc.stdin.end()
    const timer = setTimeout(() => proc.kill(), 3000)
    await proc.exited
    clearTimeout(timer)
    rmSync(dir, { recursive: true, force: true })
  }
}, 60000)
