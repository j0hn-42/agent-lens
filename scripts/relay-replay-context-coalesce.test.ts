/**
 * Replay buffer and context_update (#567): a context reading superseded AT THE SAME INSTANT by a later reading of
 * the same agent is replaced in the relay's replay buffer instead of being kept beside it. Measured on the real
 * relay (createRelay), with the composition of a tool call as the relay emits it from a transcript: message,
 * tool_call_start, context_update, tool_call_end, context_update, context_update.
 *
 * What it proves: the replay keeps more of the session for the same caps (the loss the relay reports shrinks),
 * the graph a client rebuilds from it is the same (agents, last state, current context of each agent), the
 * order of the other events is kept, and a replaced reading is never counted as a loss (it is not one).
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
import { RELAY_MAX_REPLAY_PER_SESSION } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-coalesce-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

/** Tool calls per session: with the 3 opening events, about 1504, 2506, 6004 and 12004 events (the #567 bench). */
const SIZES = [250, 417, 1000, 2000]
/** Each line written on its own, as a live session writes them: the reading of a tool_use and those of its result differ in time. */
const SPACED = 150
const SPACED_SESSION = '68686869-6868-4868-8868-686868686868'
const sessionOf = (i: number) => `6868686${i}-6868-4868-8868-686868686868`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const line = (o: unknown) => JSON.stringify(o) + '\n'
const ts = () => new Date().toISOString()
let realWs = ''
const callLines = (i: number) => [
  line({ type: 'assistant', cwd: realWs, timestamp: ts(), message: { role: 'assistant', content: [{ type: 'text', text: `step ${i}` }, { type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: `echo ${i}` } }] } }) +
  line({ type: 'user', cwd: realWs, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: `out ${i}` }] } }),
]
const call = (i: number) => callLines(i).join('')

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let server: http.Server
let port = 0
const open: http.ClientRequest[] = []
interface Ev { type: string; time: number; sessionId?: string; payload: Record<string, unknown> }
interface Collected { events: Ev[]; loss: Record<string, number> }

/** Connects, collects events (replayed and live) and the event-loss payload for `ms`, then disconnects. */
function collect(query: string, ms: number): Promise<Collected> {
  return new Promise((resolve, reject) => {
    const out: Collected = { events: [], loss: {} }
    let pending = ''
    const req = http.get({ host: '127.0.0.1', port, path: '/events' + query, agent: false }, res => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        const blocks = (pending + chunk).split('\n\n')
        pending = blocks.pop() ?? ''
        for (const b of blocks) {
          if (!b.startsWith('data: ')) continue
          const m = JSON.parse(b.slice(6))
          if (m.type === 'agent-event-batch') out.events.push(...m.events)
          else if (m.type === 'agent-event') out.events.push(m.event)
          else if (m.type === 'event-loss') out.loss = m.evicted ?? {}
        }
      })
      setTimeout(() => { req.destroy(); resolve(out) }, ms)
    })
    open.push(req)
    req.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e) })
  })
}

const key = (e: Ev) => JSON.stringify([e.type, e.time, e.payload])
const isContext = (e: Ev) => e.type === 'context_update'

/** What a client rebuilds that the cap does not already cut: the agents, the last event, the current context of each agent. */
function graphOf(events: readonly Ev[]) {
  const agents = new Set<string>()
  const context = new Map<string, string>()
  for (const e of events) {
    if (e.type === 'agent_spawn') agents.add(String(e.payload.name))
    if (isContext(e)) context.set(String(e.payload.agent), JSON.stringify(e.payload))
  }
  const others = events.filter(e => !isContext(e))
  return { agents: [...agents].sort(), lastEvent: key(others[others.length - 1]), context: [...context].sort() }
}

/** Live context readings followed, at the same instant, by a reading of the same agent: the only ones that may be replaced. */
function supersededAtSameInstant(events: readonly Ev[]): number {
  let n = 0
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (!isContext(e)) continue
    for (let j = i + 1; j < events.length && events[j].time === e.time; j++) {
      if (isContext(events[j]) && events[j].payload.agent === e.payload.agent) { n++; break }
    }
  }
  return n
}

const live = new Map<string, Ev[]>()
const replays = new Map<string, Collected>()

describe('relay: context_update superseded at the same instant in the replay buffer (#567)', () => {
  before(async () => {
    const { createRelay } = await import('./relay')
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    realWs = fs.realpathSync(ws)
    const projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    relay = await createRelay({ workspace: ws, runtime: 'claude' })
    server = http.createServer((req, res) => {
      if (guardRequest(req, res, { kind: 'api' })) return
      if (req.url?.startsWith('/events')) return void relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    port = await listenLoopback(server, 0)
    fs.mkdirSync(projectDir, { recursive: true })
    for (let s = 0; s < SIZES.length; s++) {
      const transcript = path.join(projectDir, `${sessionOf(s)}.jsonl`)
      fs.writeFileSync(transcript, line({ type: 'user', cwd: realWs, timestamp: ts(), message: { role: 'user', content: `go ${s}` } }))
      // A client connected while the session is written receives every event live: the reference
      const watching = collect(`?session=${sessionOf(s)}`, 1_500 + Math.ceil(SIZES[s] / 20) * 60 + 2_000)
      await sleep(1_500)
      for (let i = 0; i < SIZES[s]; i += 20) {
        let chunk = ''
        for (let j = i; j < Math.min(i + 20, SIZES[s]); j++) chunk += call(j)
        fs.appendFileSync(transcript, chunk)
        await sleep(60)
      }
      live.set(sessionOf(s), (await watching).events)
    }
    {
      const transcript = path.join(projectDir, `${SPACED_SESSION}.jsonl`)
      fs.writeFileSync(transcript, line({ type: 'user', cwd: realWs, timestamp: ts(), message: { role: 'user', content: 'go spaced' } }))
      const watching = collect(`?session=${SPACED_SESSION}`, 1_500 + SPACED * 2 * 40 + 2_000)
      await sleep(1_500)
      for (let i = 0; i < SPACED; i++) {
        for (const l of callLines(i)) { fs.appendFileSync(transcript, l); await sleep(40) }
      }
      live.set(SPACED_SESSION, (await watching).events)
    }
    for (let s = 0; s < SIZES.length; s++) replays.set(sessionOf(s), await collect(`?session=${sessionOf(s)}`, 2_500))
    replays.set(SPACED_SESSION, await collect(`?session=${SPACED_SESSION}`, 2_500))
  })

  after(() => {
    for (const r of open) r.destroy()
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('the bench emits a tool call as message, tool_call_start, tool_call_end and 3 context_update', () => {
    const events = live.get(sessionOf(0))!
    assert.equal(events.length, 3 + 6 * SIZES[0])
    assert.equal(events.filter(isContext).length, 1 + 3 * SIZES[0])
  })

  it('lines written one by one: readings of different instants are all kept, the duplicate of a result is replaced', () => {
    const sent = live.get(SPACED_SESSION)!
    const { events: replayed, loss } = replays.get(SPACED_SESSION)!
    assert.equal(sent.length, 3 + 6 * SPACED)
    assert.equal(loss[SPACED_SESSION] ?? 0, 0)
    const replaced = sent.length - replayed.length
    console.log(`[#567] spaced N=${sent.length} replayed=${replayed.length} replaced=${replaced} context sent=${sent.filter(isContext).length}`)
    assert.ok(replaced <= supersededAtSameInstant(sent))
    assert.deepEqual(graphOf(replayed), graphOf(sent))
    assert.deepEqual(replayed.filter(e => !isContext(e)).map(key), sent.filter(e => !isContext(e)).map(key))
    // Every instant that had a reading of an agent still has its last one: a review scrub shows the same gauge
    const lastPerInstant = (evs: readonly Ev[]) => {
      const m = new Map<string, string>()
      for (const e of evs) if (isContext(e)) m.set(`${e.payload.agent}@${e.time}`, JSON.stringify(e.payload))
      return [...m].sort()
    }
    assert.deepEqual(lastPerInstant(replayed), lastPerInstant(sent))
  })

  for (let s = 0; s < SIZES.length; s++) {
    it(`session of ${3 + 6 * SIZES[s]} events: smaller loss, same graph, same order, nothing replaced counted as lost`, () => {
      const sid = sessionOf(s)
      const sent = live.get(sid)!
      const { events: replayed, loss: lossMsg } = replays.get(sid)!
      const n = sent.length
      const loss = lossMsg[sid] ?? 0
      const missing = n - replayed.length
      const replaced = missing - loss
      console.log(`[#567] N=${n} replayed=${replayed.length} loss=${loss} replaced=${replaced} before=${Math.max(0, n - (RELAY_MAX_REPLAY_PER_SESSION + 1))}`)
      assert.equal(sent.length, 3 + 6 * SIZES[s], 'every event reached the live client')

      // Replaced readings are not a loss: the reported loss counts only what the replay does not show
      assert.ok(replaced >= 0, `the loss never exceeds what is missing (${loss} > ${missing})`)
      assert.ok(replaced <= supersededAtSameInstant(sent), 'only readings superseded at the same instant are left out uncounted')

      // Same graph: agents, last event, current context (the LAST context_update of each agent)
      assert.deepEqual(graphOf(replayed), graphOf(sent))

      // The other events keep their order: the re-added lifecycle head, then a contiguous suffix of the live ones
      const sentOthers = sent.filter(e => !isContext(e)).map(key)
      const replayedOthers = replayed.filter(e => !isContext(e)).map(key)
      const body = replayedOthers[0] === sentOthers[0] && replayedOthers.length < sentOthers.length ? replayedOthers.slice(1) : replayedOthers
      assert.deepEqual(body, sentOthers.slice(sentOthers.length - body.length), 'contiguous suffix, in order')
      // The context readings replayed are live ones, in order
      const sentContext = sent.filter(isContext).map(key)
      let at = 0
      for (const k of replayed.filter(isContext).map(key)) {
        at = sentContext.indexOf(k, at)
        assert.ok(at >= 0, 'a replayed reading was sent live, in this order')
        at++
      }

      if (n > RELAY_MAX_REPLAY_PER_SESSION + 1) {
        // Before #567 the loss was exactly N - 2001 (2000 recent events + the re-added agent_spawn)
        const before = n - (RELAY_MAX_REPLAY_PER_SESSION + 1)
        assert.ok(loss < before * 0.75, `the loss shrinks markedly (${loss} vs ${before} before)`)
      } else {
        assert.equal(loss, 0)
      }
    })
  }
})
