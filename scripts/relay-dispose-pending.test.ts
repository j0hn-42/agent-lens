/**
 * An SSE client accepted while sessions are still being attached waits for them before it joins (#651). If the relay
 * is disposed meanwhile (tests, hot reload), that client is closed with the rest: it must not join afterwards, which
 * would start the shared tickers and timers again on a dead relay (#613). Own file: the relay is a per-process
 * singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-dp-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.AGENT_LENS_ALL_WORKSPACES

const BIG = '61361361-0613-4613-8613-000000000001'
/** Big enough for the attach to outlast the connection and the dispose (checked below) */
const HISTORY_BYTES = 48 * 1024 * 1024
const line = (o: unknown) => JSON.stringify(o) + '\n'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function history(cwd: string, bytes: number): string {
  const pad = 'x'.repeat(2000)
  const t = new Date(Date.now() - 60_000).toISOString()
  const out: string[] = [line({ type: 'user', uuid: 'u0', cwd, timestamp: t, message: { role: 'user', content: 'Old turn' } })]
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const pair = line({ type: 'assistant', uuid: `a${i}`, timestamp: t, message: { role: 'assistant', content: [{ type: 'text', text: pad }, { type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: `/src/${i}.ts` } }] } })
      + line({ type: 'user', uuid: `r${i}`, timestamp: t, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: pad }] } })
    out.push(pair)
    size += pair.length
  }
  out.push(line({ type: 'user', uuid: 'u-last', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Audit the code' } }))
  return out.join('')
}

describe('relay: dispose closes the clients still waiting to join (#613)', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let port = 0
  const open: http.ClientRequest[] = []

  before(async () => {
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    const cwd = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${BIG}.jsonl`), history(cwd, HISTORY_BYTES))
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: cwd, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(() => {
    for (const r of open) r.destroy()
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('a waiting client is closed by dispose and never starts the tickers again', async () => {
    assert.equal(relay.debugState().attaching, true, 'precondition: the attach is still running')
    let ended = false
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
        res.on('close', () => { ended = true })
        res.resume()
        resolve()
      })
      open.push(req)
      req.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e) })
    })
    assert.equal(relay.debugState().sseClients, 0, 'precondition: it waits, it has not joined')
    assert.equal(relay.debugState().attaching, true, 'precondition: still attaching when it waits')
    relay.dispose()
    // Past the end of the attach the dropped session would have let it join
    await sleep(3_000)
    const state = relay.debugState()
    assert.equal(ended, true, 'the waiting client was closed')
    assert.equal(state.sseClients, 0, 'it never joined')
    assert.equal(state.scanTimerActive, false)
    assert.equal(state.runtimeScanTimerActive, false)
    assert.equal(state.heartbeatTimerActive, false)
    assert.equal(state.systemTimerActive, false)
  })
})
