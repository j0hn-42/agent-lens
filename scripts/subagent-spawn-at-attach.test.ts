/**
 * End to end (#446): real relay (createRelay, extension pipeline) over a synthetic ~/.claude tree in a fake
 * HOME, SSE /events, then the web reducer. A background subagent launched before the relay started and still
 * working must exist on the web side, announced before its first event and under the name its events use.
 * A subagent whose end is in the history must not come back.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { processEventBatch } from '../web/hooks/simulation/process-event'
import { createEmptyState } from '../web/hooks/simulation/types'
import { stampEventTimes } from '../web/hooks/simulation/stamp-time'
import type { SimulationEvent } from '../web/lib/agent-types'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-446-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR

const LEAD = '44444444-4444-4444-8444-444444444446'
const OPEN_ID = 'a0000000000000aa1'
const DONE_ID = 'a0000000000000dd2'

type Ev = { type: string; payload: Record<string, unknown>; sessionId?: string; time: number; replayed?: boolean }

const line = (o: unknown) => JSON.stringify(o) + '\n'
const dispatch = (id: string, description: string) => ({
  type: 'assistant', uuid: `a-${id}`,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description, prompt: 'x', run_in_background: true } }] },
})
const receipt = (id: string, agentId: string) => ({
  type: 'user', uuid: `u-${id}`, toolUseResult: { isAsync: true, status: 'async_launched', agentId },
  message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'Async agent launched' }] },
})
const subLines = (agentId: string, n: number) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `step ${n}` }] } }) +
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `${agentId}-t${n}`, name: 'Bash', input: { command: 'pnpm test' } }] } })

describe('relay attached to a session whose background subagent is already running (#446)', () => {
  let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
  let server: http.Server
  let req: http.ClientRequest
  const received: Ev[] = []
  /** The events as the relay sent them (before the page marks a batch as replayed) */
  const sent: Ev[] = []

  before(async () => {
    const ws = path.join(fakeHome, 'work', 'demo')
    fs.mkdirSync(ws, { recursive: true })
    const realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    const subDir = path.join(projectDir, LEAD, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const t = new Date(Date.now() - 60_000).toISOString()
    // History: two background launches, the second one already notified as completed, then the user's next prompt
    fs.writeFileSync(path.join(projectDir, `${LEAD}.jsonl`),
      line({ type: 'user', cwd: realWs, timestamp: t, message: { role: 'user', content: 'Audit the parser' } }) +
      line(dispatch('toolu_open', 'Open audit')) + line(receipt('toolu_open', OPEN_ID)) +
      line(dispatch('toolu_done', 'Done audit')) + line(receipt('toolu_done', DONE_ID)) +
      line({ type: 'user', uuid: 'n-done', message: { role: 'user', content: `<task-notification>\n<task-id>${DONE_ID}</task-id>\n<tool-use-id>toolu_done</tool-use-id>\n<status>completed</status>\n<result>Report.</result>\n</task-notification>` } }) +
      line({ type: 'user', cwd: realWs, message: { role: 'user', content: 'je dois m\'absenter' } }))
    for (const [agentId, toolUseId, description] of [[OPEN_ID, 'toolu_open', 'Open audit'], [DONE_ID, 'toolu_done', 'Done audit']]) {
      fs.writeFileSync(path.join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description, toolUseId }))
      fs.writeFileSync(path.join(subDir, `agent-${agentId}.jsonl`),
        line({ type: 'user', message: { role: 'user', content: 'Do it' } }) +
        line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `${agentId}-t1`, name: 'Read', input: { file_path: '/a.ts' } }] } }) +
        line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${agentId}-t1`, content: 'ok' }] } }))
    }

    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude', hooksProbe: () => false })
    server = http.createServer((rq, res) => relay.handleSSE(rq, res))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    let buf = ''
    let consumed = 0
    const drain = () => {
      const parts = buf.slice(consumed).split('\n\n')
      const complete = parts.slice(0, -1)
      consumed += complete.reduce((n, p) => n + p.length + 2, 0)
      for (const b of complete) {
        if (!b.startsWith('data: ')) continue
        const m = JSON.parse(b.slice(6))
        if (m.type === 'agent-event-batch') {
          sent.push(...(m.events ?? []))
          received.push(...(m.events ?? []).map((e: Ev) => ({ ...e, replayed: true })))
        } else if (m.type === 'agent-event' && m.event) { sent.push(m.event); received.push(m.event) }
      }
    }
    req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
      res.setEncoding('utf8')
      res.on('data', (c: string) => { buf += c; drain() })
    })
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const ofLead = () => received.filter(e => e.sessionId === LEAD)
    for (let i = 0; i < 40 && !ofLead().some(e => e.type === 'agent_spawn'); i++) await sleep(100)
    await sleep(300)
    // Both subagents keep writing after the attach (the finished one too: it must stay finished)
    fs.appendFileSync(path.join(subDir, `agent-${OPEN_ID}.jsonl`), subLines(OPEN_ID, 2))
    fs.appendFileSync(path.join(subDir, `agent-${DONE_ID}.jsonl`), subLines(DONE_ID, 2))
    // fs.watch or the poll fallback (3 s) picks the lines up
    for (let i = 0; i < 80 && !ofLead().some(e => e.type === 'tool_call_start' && e.payload.agent === 'Open audit'); i++) await sleep(100)
    await sleep(300)
  })

  after(() => {
    req?.destroy()
    relay?.dispose()
    server?.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  const ofLead = () => received.filter(e => e.sessionId === LEAD)

  it('the relay announces the running subagent once, before its first event, under the name its events use', () => {
    const evs = ofLead()
    const spawns = evs.filter(e => e.type === 'agent_spawn' && e.payload.name === 'Open audit')
    assert.equal(spawns.length, 1)
    const start = evs.findIndex(e => e.type === 'tool_call_start' && e.payload.agent === 'Open audit')
    assert.ok(start >= 0, 'its live work reaches the client')
    assert.ok(evs.indexOf(spawns[0]) < start, 'spawn before its first event')
  })

  it('the relay marks that spawn as read from history (#361): it proves no live work', () => {
    const spawn = sent.find(e => e.sessionId === LEAD && e.type === 'agent_spawn' && e.payload.name === 'Open audit')
    assert.equal(spawn?.replayed, true)
  })

  it('the subagent finished in the history is not announced again', () => {
    assert.ok(!ofLead().some(e => e.type === 'agent_spawn' && e.payload.name === 'Done audit'))
  })

  it('the web reducer has the running subagent, with its tool call, and not the finished one', () => {
    const ctx = { syncForceSimulation: () => {}, findToolSlot: () => ({ x: 0, y: 0 }), getContextWindowSize: () => 200_000, blockIdCounter: { current: 0 }, skipForceSync: true }
    const stamped = stampEventTimes(ofLead(), 0, 0) as unknown as SimulationEvent[]
    const { state } = processEventBatch(stamped, createEmptyState(), ctx, { advanceClock: true })
    const agents = [...state.agents.values()]
    const open = agents.find(a => a.name === 'Open audit')
    assert.ok(open, `web agents: ${agents.map(a => a.name).join(', ')}`)
    assert.ok(open.toolCalls >= 1, 'its tool call is counted, not dropped')
    assert.ok(!agents.some(a => a.name === 'Done audit'))
  })
})
