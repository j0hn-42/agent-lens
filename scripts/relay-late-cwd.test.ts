/**
 * A session the relay finds while Claude Code is starting it: the head of its transcript holds only metadata
 * (agent-setting, mode, permission-mode...) and the first entry carrying a cwd comes later. The relay learns the
 * cwd, so the project, when it is written and tells the clients (session-updated): the session joins its workspace
 * without restarting the relay. Own file: the relay is a per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardRequest, listenLoopback } from './server-hardening'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-late-cwd-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.AGENT_LENS_ALL_WORKSPACES
delete process.env.AGENT_LENS_IMPORT

const SESSION = '1a7ec3d0-0000-4000-8000-00000000c3d0'
const line = (o: unknown) => JSON.stringify(o) + '\n'
type Msg = { type: string; sessionId?: string; projectId?: string; projectName?: string; cwd?: string; branch?: string; sessions?: Array<{ id: string; projectId?: string }> }

describe('relay: a cwd written after the session was found', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let req: http.ClientRequest | undefined
  let port = 0
  let buf = ''
  let cwd = ''
  let transcript = ''

  const messages = (): Msg[] => buf.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)) as Msg)
  const waitFor = async (cond: () => boolean, ms = 8000) => {
    const end = Date.now() + ms
    while (Date.now() < end && !cond()) await new Promise(r => setTimeout(r, 20))
  }
  const updated = () => messages().filter(m => m.type === 'session-updated' && m.sessionId === SESSION)

  before(async () => {
    const ws = path.join(fakeHome, 'repo')
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true })
    cwd = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    transcript = path.join(projectDir, `${SESSION}.jsonl`)
    // What Claude Code writes first: no entry carries a cwd yet
    fs.writeFileSync(transcript, [
      line({ type: 'agent-setting', agentSetting: 'default' }),
      line({ type: 'mode', mode: 'normal' }),
      line({ type: 'permission-mode', permissionMode: 'default' }),
    ].join(''))

    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: cwd, runtime: 'claude' })
    server = http.createServer((rq, res) => {
      if (guardRequest(rq, res, { kind: 'api' })) return
      if (rq.url?.startsWith('/events')) return void relay.handleSSE(rq, res)
      res.writeHead(404); res.end()
    })
    port = await listenLoopback(server, 0)
    req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => { res.setEncoding('utf8'); res.on('data', c => { buf += c }) })
    await waitFor(() => messages().some(m => m.type === 'session-list' && !!m.sessions?.some(s => s.id === SESSION)))
  })

  after(() => {
    req?.destroy()
    relay?.dispose()
    server?.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('lists the session without a project while no entry gives its cwd (never guessed)', () => {
    const list = messages().find(m => m.type === 'session-list')
    const s = list?.sessions?.find(x => x.id === SESSION)
    assert.ok(s, 'precondition: the relay watches the session')
    assert.equal(s.projectId, undefined)
  })

  it('learns the cwd when it is written and sends the project in a session-updated, once', async () => {
    fs.appendFileSync(transcript, line({
      type: 'user', uuid: 'u1', cwd, gitBranch: 'feat/late', timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Fix the layout' },
    }))
    await waitFor(() => updated().some(m => m.projectId !== undefined))
    const m = updated().find(x => x.projectId !== undefined)
    assert.ok(m, `the project is sent: ${JSON.stringify(updated())}`)
    assert.equal(m.projectName, 'repo')
    assert.equal(m.cwd, cwd)
    assert.equal(m.branch, 'feat/late')

    // More lines: the header is known, nothing is sent again for it
    fs.appendFileSync(transcript, line({ type: 'assistant', uuid: 'a1', cwd, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }))
    await new Promise(r => setTimeout(r, 1500))
    assert.equal(updated().filter(x => x.projectId !== undefined).length, 1)
  })

  it('a client that connects afterwards gets the project in the session list', async () => {
    let late = ''
    const r = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => { res.setEncoding('utf8'); res.on('data', c => { late += c }) })
    try {
      const list = () => late.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)) as Msg).find(x => x.type === 'session-list')
      await waitFor(() => !!list())
      assert.ok(list()?.sessions?.find(s => s.id === SESSION)?.projectId)
    } finally { r.destroy() }
  })
})
