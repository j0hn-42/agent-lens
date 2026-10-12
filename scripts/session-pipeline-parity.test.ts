/**
 * Same transcript, two entry points (#218): the extension (SessionWatcher) and the relay (createRelay)
 * must emit the same event stream, whatever the entry point. Only timestamps (`time`) differ between runs.
 * Own file: the relay is a per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardRequest, listenLoopback } from './server-hardening'
import type { AgentEvent } from '../extension/src/protocol'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-pipeline-parity-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.AGENT_LENS_ALL_WORKSPACES
delete process.env.AGENT_LENS_IMPORT

const SESSION = '88888888-8888-4888-8888-888888888888'
const line = (o: unknown) => JSON.stringify(o) + '\n'

/** Event minus what legitimately differs between two runs of the same file. */
const comparable = (e: AgentEvent) => { const { time: _time, ...rest } = e as AgentEvent & { time?: number }; return rest }

describe('one transcript through the extension and through the relay', () => {
  let cwd = ''
  const fromExtension: AgentEvent[] = []
  let fromRelay: AgentEvent[] = []
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let req: http.ClientRequest | undefined

  before(async () => {
    cwd = fs.realpathSync(process.cwd())
    const projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    const now = Date.now()
    const ts = (s: number) => new Date(now - 60_000 + s * 1000).toISOString()
    const file = path.join(projectDir, `${SESSION}.jsonl`)
    fs.writeFileSync(file, line({ type: 'user', uuid: 'u1', cwd, timestamp: ts(0), message: { role: 'user', content: 'Run the build' } }))

    // Extension entry point
    const vscodeShim = require('vscode') as { window: Record<string, unknown> }
    vscodeShim.window.setStatusBarMessage = () => ({ dispose() {} })
    const { SessionWatcher } = await import('../extension/src/session-watcher')
    const extensionWatcher = new SessionWatcher()
    const watcher = extensionWatcher
    watcher.onEvent(e => { if (e.sessionId === SESSION) fromExtension.push(e) })
    watcher.start()

    // Relay entry point
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: cwd, runtime: 'claude' })
    server = http.createServer((rq, res) => {
      if (guardRequest(rq, res, { kind: 'api' })) return
      if (rq.url?.startsWith('/events')) return void relay.handleSSE(rq, res)
      res.writeHead(404); res.end()
    })
    const port = await listenLoopback(server, 0)
    let buf = ''
    req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => { res.setEncoding('utf8'); res.on('data', c => { buf += c }) })
    const read = () => buf.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)) as Record<string, unknown>)
      .flatMap(m => m.type === 'agent-event-batch' ? (m.events as AgentEvent[]) : m.type === 'agent-event' ? [m.event as AgentEvent] : [])
      .filter(e => e.sessionId === SESSION)
    const waitFor = async (cond: () => boolean) => {
      const end = Date.now() + 10_000
      while (Date.now() < end && !cond()) await new Promise(r => setTimeout(r, 20))
    }
    await waitFor(() => read().some(e => e.type === 'context_update') && fromExtension.some(e => e.type === 'context_update'))
    // Live part: both watchers read what is appended after the attach
    fs.appendFileSync(file, line({ type: 'assistant', uuid: 'a1', timestamp: ts(1), message: { role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm build' } }] } })
      + line({ type: 'user', uuid: 'u2', timestamp: ts(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }))
    await waitFor(() => read().some(e => e.type === 'tool_call_end') && fromExtension.some(e => e.type === 'tool_call_end'))
    fromRelay = read()
    extensionWatcher.dispose()
  })

  after(() => {
    req?.destroy()
    relay?.dispose()
    server?.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('both emit events for the session', () => {
    assert.ok(fromExtension.some(e => e.type === 'tool_call_end'), `extension: ${fromExtension.map(e => e.type).join(',')}`)
    assert.ok(fromRelay.some(e => e.type === 'tool_call_end'), `relay: ${fromRelay.map(e => e.type).join(',')}`)
  })

  it('context_update carries tokenSource estimated from either entry point', () => {
    for (const [name, events] of [['extension', fromExtension], ['relay', fromRelay]] as const) {
      const updates = events.filter(e => e.type === 'context_update')
      assert.ok(updates.length > 0, `${name} emitted a context_update`)
      for (const u of updates) assert.equal(u.payload.tokenSource, 'estimated', `${name}: ${JSON.stringify(u.payload)}`)
    }
  })

  it('the event streams are identical, timestamps aside', () => {
    assert.deepEqual(fromRelay.map(comparable), fromExtension.map(comparable))
  })
})
