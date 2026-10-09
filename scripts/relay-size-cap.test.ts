/**
 * Relay size cap (#208): a watched session whose transcript grows past the cap is no longer followed.
 * The relay must say so (session-ended to SSE clients, a warning) and count it in GET /status.
 * The relay is a per-process singleton, so this lives in its own test file.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isStatusPath } from '../extension/src/relay-guards'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-size-cap-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const SID = '55555555-5555-4555-8555-555555555555'
const CAP = 4096
const line = (o: unknown) => JSON.stringify(o) + '\n'

describe('relay: a session that grows past the size cap', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let port = 0
  let transcript = ''
  let sse: http.ClientRequest | undefined
  const messages: Array<Record<string, unknown>> = []

  const get = (urlPath: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, agent: false }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })

  const waitFor = async (pred: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise(r => setTimeout(r, 50))
    }
  }

  before(async () => {
    const ws = path.join(fakeHome, 'work', 'demo')
    fs.mkdirSync(ws, { recursive: true })
    const realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    transcript = path.join(projectDir, `${SID}.jsonl`)
    fs.writeFileSync(transcript, line({ type: 'user', cwd: realWs, message: { role: 'user', content: 'Long orchestration' } }))

    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude', maxSessionFileBytes: CAP })
    server = http.createServer((req, res) => {
      if (isStatusPath(req.url)) return relay.handleStatus(req, res)
      return relay.handleSSE(req, res)
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port

    await new Promise<void>((resolve, reject) => {
      sse = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
        res.setEncoding('utf8')
        let buf = ''
        res.on('data', (c: string) => {
          buf += c
          const blocks = buf.split('\n\n')
          buf = blocks.pop() ?? ''
          for (const b of blocks) if (b.startsWith('data: ')) messages.push(JSON.parse(b.slice(6)))
        })
        resolve()
      })
      sse.on('error', reject)
    })
  })

  after(() => {
    sse?.destroy()
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('sends session-ended to SSE clients, warns, and counts the session in /status', async () => {
    await waitFor(() => messages.some(m => m.type === 'session-list' || m.type === 'session-started'))
    const warn = mock.method(console, 'warn', () => {})
    try {
      const filler = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(CAP) }] } }
      fs.appendFileSync(transcript, line(filler))
      await waitFor(() => messages.some(m => m.type === 'session-ended' && m.sessionId === SID))
      assert.ok(
        warn.mock.calls.some(c => c.arguments.map(String).join(' ').includes(SID.slice(0, 8))),
        'a warning names the session',
      )
    } finally { warn.mock.restore() }

    const status = JSON.parse((await get('/status')).body)
    assert.deepEqual(status.skippedSessions, { watchLimit: 0, sizeLimit: 1 })
  })
})
