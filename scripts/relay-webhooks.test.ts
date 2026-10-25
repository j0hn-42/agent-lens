/**
 * Relay webhooks (#236) over a real relay and a real transcript: a live agent_complete is notified once, with a
 * whitelisted body; what was read from history at discovery is not.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { waitAttached, touchEvents } from './relay-test-helpers'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-webhook-home-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES
delete process.env.AGENT_LENS_WEBHOOKS

const SESSION = '55555555-5555-4555-8555-555555555555'
const line = (o: unknown) => JSON.stringify(o) + '\n'
const tu = (id: string, description: string) => ({ type: 'tool_use', id, name: 'Agent', input: { description, prompt: 'TOPSECRET prompt', subagent_type: 'general-purpose' } })

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let receiver: http.Server
let sessionFile = ''
const received: Array<Record<string, unknown>> = []
const raws: string[] = []

describe('relay webhooks', () => {
  before(async () => {
    receiver = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => { raws.push(body); received.push(JSON.parse(body)); res.writeHead(204); res.end() })
    })
    await new Promise<void>(r => receiver.listen(0, '127.0.0.1', r))
    const recvPort = (receiver.address() as { port: number }).port

    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'work', 'proj')
    fs.mkdirSync(ws, { recursive: true })
    const realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    sessionFile = path.join(projectDir, `${SESSION}.jsonl`)
    const now = Date.now()
    // History: an agent that already returned before the relay started
    fs.writeFileSync(sessionFile,
      line({ type: 'user', cwd: realWs, timestamp: new Date(now - 5000).toISOString(), message: { role: 'user', content: 'go' } }) +
      line({ type: 'assistant', timestamp: new Date(now - 4000).toISOString(), message: { role: 'assistant', content: [tu('toolu_old', 'Old task')] } }) +
      line({ type: 'user', timestamp: new Date(now - 3000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'done' }] } }))
    relay = await createRelay({ workspace: realWs, runtime: 'claude', webhooks: { destinations: [`http://127.0.0.1:${recvPort}/hook`] } })
    server = http.createServer((req, res) => { if (req.url?.startsWith('/events')) return relay.handleSSE(req, res); res.writeHead(404); res.end() })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    await touchEvents(port)
    // The attach reads the history over several ticks (#651): a line appended before it ends is history, never
    // notified. The tests append live lines, so they start once the transcript is followed, not after a fixed time (#440).
    assert.ok(await waitAttached(relay, 1), 'precondition: the transcript is attached')
  })

  after(() => {
    relay.dispose()
    server.close(); receiver.closeAllConnections(); receiver.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('notifies a live agent_complete once, with the whitelisted body only', async () => {
    fs.appendFileSync(sessionFile,
      line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [tu('toolu_new', 'Scan code')] } }) +
      line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_new', content: 'done' }] } }))
    for (let i = 0; i < 40 && !received.some(r => r.type === 'agent_complete'); i++) await new Promise(r => setTimeout(r, 150))
    const hits = received.filter(r => r.type === 'agent_complete')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].agent, 'Scan code')
    assert.equal(hits[0].sessionId, SESSION)
    assert.deepEqual(Object.keys(hits[0]).sort(), ['agent', 'schema', 'sentAt', 'sessionId', 'source', 'type'])
    assert.ok(!raws.join('').includes('TOPSECRET'))
  })

  it('did not notify what was read from history at discovery', () => {
    assert.equal(received.some(r => r.agent === 'Old task'), false)
  })

  it('counts what it sent', () => {
    assert.equal(relay.webhookStats()?.sent, 1)
    assert.equal(relay.webhookStats()?.failed, 0)
  })
})
