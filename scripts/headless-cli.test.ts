/** Headless CLI (#236): `ps`, `tail`, `statusline` are clients of the local relay's HTTP data. */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { parseCliArgs, runCli, isCliCommand } from './headless-cli'

const OBS = { schema: 1, generatedAt: 5, sessions: [{ id: 's1', runtime: 'claude', status: 'active' }], truncated: false, omittedSessions: 0 }

let server: http.Server
let port = 0
let lastUrl = ''
let sseWrites: string[] = []
let failObservations = false

before(async () => {
  server = http.createServer((req, res) => {
    lastUrl = req.url ?? ''
    const p = new URL(lastUrl, 'http://x').pathname
    if (p === '/observations' && failObservations) { res.writeHead(503); return void res.end('down') }
    if (p === '/observations') { res.writeHead(200, { 'Content-Type': 'application/json' }); return void res.end(JSON.stringify(OBS)) }
    if (p === '/statusline') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return void res.end('lens 1 live 1 active 0 idle\n') }
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const w of sseWrites) res.write(w)
      return // stays open, like the real relay
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})
after(() => { server.closeAllConnections(); server.close() })

function io() {
  const out: string[] = []; const err: string[] = []
  return { out, err, io: { stdout: { write: (s: string) => { out.push(s); return true } }, stderr: { write: (s: string) => { err.push(s); return true } } } }
}
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
const ev = (type: string, sessionId = 's1') => ({ type: 'agent-event', event: { time: 1, type, payload: { agent: 'main' }, sessionId } })

describe('parseCliArgs', () => {
  it('recognises the commands', () => {
    for (const c of ['ps', 'tail', 'statusline']) assert.equal(isCliCommand(c), true)
    for (const c of ['--port', 'serve', undefined]) assert.equal(isCliCommand(c), false)
  })
  it('reads the port from --port, then AGENT_LENS_PORT, then the default', () => {
    assert.equal((parseCliArgs(['--port', '4000'], {}) as { port: number }).port, 4000)
    assert.equal((parseCliArgs([], { AGENT_LENS_PORT: '4100' }) as { port: number }).port, 4100)
    assert.equal(typeof (parseCliArgs([], {}) as { port: number }).port, 'number')
  })
  it('rejects bad values instead of guessing', () => {
    for (const argv of [['--port', 'x'], ['--port', '70000'], ['--count', '0'], ['--count', 'abc'], ['--session', 'a b'], ['--timeout', '-1'], ['--nope']]) {
      assert.ok('error' in parseCliArgs(argv, {}), argv.join(' '))
    }
  })
})

describe('runCli', () => {
  it('ps prints the observations JSON unchanged, one document', async () => {
    const t = io()
    assert.equal(await runCli('ps', ['--port', String(port)], t.io, {}), 0)
    assert.deepEqual(JSON.parse(t.out.join('')), OBS)
    assert.match(lastUrl, /^\/observations\?agents=1$/)
  })
  it('statusline prints the relay line', async () => {
    const t = io()
    assert.equal(await runCli('statusline', ['--port', String(port)], t.io, {}), 0)
    assert.equal(t.out.join(''), 'lens 1 live 1 active 0 idle\n')
  })
  it('exits 1 with a message on stderr, and nothing on stdout, when the relay is unreachable', async () => {
    const dead = http.createServer(); await new Promise<void>(r => dead.listen(0, '127.0.0.1', r))
    const deadPort = (dead.address() as { port: number }).port; dead.close(); await new Promise(r => setTimeout(r, 20))
    for (const c of ['ps', 'statusline', 'tail'] as const) {
      const t = io()
      assert.equal(await runCli(c, ['--port', String(deadPort), '--timeout', '500'], t.io, {}), 1, c)
      assert.equal(t.out.join(''), '', c)
      assert.match(t.err.join(''), /unreachable/i, c)
    }
  })
  it('exits 1 on an HTTP error status, never printing the error body as data', async () => {
    const t = io()
    failObservations = true
    try { assert.equal(await runCli('ps', ['--port', String(port)], t.io, {}), 1) } finally { failObservations = false }
    assert.match(t.err.join(''), /503/); assert.equal(t.out.join(''), '')
  })
  it('tail prints live agent events as NDJSON and stops after --count', async () => {
    sseWrites = [sse({ type: 'session-list', sessions: [] }), sse(ev('agent_spawn')), ': heartbeat\n\n', sse(ev('agent_complete'))]
    const t = io()
    assert.equal(await runCli('tail', ['--port', String(port), '--count', '2'], t.io, {}), 0)
    const lines = t.out.join('').trim().split('\n').map(l => JSON.parse(l))
    assert.deepEqual(lines.map(l => l.type), ['agent_spawn', 'agent_complete'])
    assert.equal(lines[0].sessionId, 's1')
  })
  it('tail ignores the replay of old events unless --replay is given', async () => {
    sseWrites = [sse({ type: 'agent-event-batch', events: [{ time: 1, type: 'agent_spawn', payload: {}, sessionId: 's1' }] }), sse(ev('agent_complete'))]
    const a = io()
    await runCli('tail', ['--port', String(port), '--count', '1'], a.io, {})
    assert.deepEqual(a.out.join('').trim().split('\n').map(l => JSON.parse(l).type), ['agent_complete'])
    const b = io()
    await runCli('tail', ['--port', String(port), '--count', '2', '--replay'], b.io, {})
    assert.deepEqual(b.out.join('').trim().split('\n').map(l => JSON.parse(l).type), ['agent_spawn', 'agent_complete'])
  })
  it('tail skips a single event the relay marks replayed (attach catch-up, #361) unless --replay is given', async () => {
    sseWrites = [sse({ type: 'agent-event', event: { time: 1, type: 'message', payload: {}, sessionId: 's1', replayed: true } }), sse(ev('agent_complete'))]
    const a = io()
    await runCli('tail', ['--port', String(port), '--count', '1'], a.io, {})
    assert.deepEqual(a.out.join('').trim().split('\n').map(l => JSON.parse(l).type), ['agent_complete'])
    const b = io()
    await runCli('tail', ['--port', String(port), '--count', '2', '--replay'], b.io, {})
    const lines = b.out.join('').trim().split('\n').map(l => JSON.parse(l))
    assert.deepEqual(lines.map(l => [l.type, l.replayed]), [['message', true], ['agent_complete', undefined]])
  })
  it('tail passes --session to the relay', async () => {
    sseWrites = [sse(ev('agent_complete'))]
    await runCli('tail', ['--port', String(port), '--count', '1', '--session', 'abc_1'], io().io, {})
    assert.equal(lastUrl, '/events?session=abc_1')
  })
  it('tail stops with code 0 at --timeout, with no events printed', async () => {
    sseWrites = []
    const t = io()
    assert.equal(await runCli('tail', ['--port', String(port), '--timeout', '200'], t.io, {}), 0)
    assert.equal(t.out.join(''), '')
  })
  it('tail drops a line past the size cap and says so on stderr, never truncating JSON', async () => {
    sseWrites = [sse({ type: 'agent-event', event: { time: 1, type: 'message', payload: { text: 'x'.repeat(70 * 1024) }, sessionId: 's1' } }), sse(ev('agent_complete'))]
    const t = io()
    assert.equal(await runCli('tail', ['--port', String(port), '--count', '1'], t.io, {}), 0)
    assert.deepEqual(t.out.join('').trim().split('\n').map(l => JSON.parse(l).type), ['agent_complete'])
    assert.match(t.err.join(''), /dropped 1/i)
  })
})
