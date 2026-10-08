/**
 * Wiring of the normalizer (#51), exercised through the real entry points: TranscriptParser,
 * CodexRolloutParser and a real HookServer on a loopback ephemeral port. Covers what the pure
 * suite cannot: one counter object per session across producers, the parent rule on the Claude
 * path, and the lifecycle code (eviction, cleanup, dispose, flush on session end).
 */
import './helpers/alias-vscode'
import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { CountersRegistry } from '../src/event-normalize'
import {
  HOOK_MAX_SESSIONS, NORM_ID_MAX, NORM_MAX_CHILDREN_PER_AGENT, NORM_STATS_MIN_INTERVAL_MS,
} from '../src/constants'
import type { AgentEvent } from '../src/protocol'
import { TranscriptParser, coerceToolUseBlock, type TranscriptParserDelegate } from '../src/transcript-parser'
import { CodexRolloutParser, createCodexRolloutState } from '../src/codex-rollout-parser'
import { makeSession } from './helpers/teams-fixtures'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-norm-wiring-home-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const statsOf = (events: Array<AgentEvent>, sessionId?: string) =>
  events.filter(e => e.type === 'normalization_stats' && (sessionId === undefined || e.sessionId === sessionId))

const claudeLine = (content: unknown) =>
  JSON.stringify({ type: 'assistant', uuid: 'u', message: { role: 'assistant', content } })

interface Captured { event: AgentEvent; sessionId?: string }

function parserHarness(registry = new CountersRegistry()) {
  const captured: Captured[] = []
  const delegate: TranscriptParserDelegate = {
    emit: (event, sessionId) => { captured.push({ event, sessionId }) },
    elapsed: () => 1, getSession: () => makeSession(), fireSessionLifecycle: () => {}, emitContextUpdate: () => {},
  }
  const parser = new TranscriptParser(delegate, registry)
  const events = () => captured.map(c => c.event)
  const feed = (line: string, agent = 'orchestrator', sessionId = 's1') =>
    parser.processTranscriptLine(line, agent, new Map(), new Set(), sessionId, new Set())
  return { parser, captured, events, feed, registry }
}

describe('Claude path: the parent rule goes through TranscriptParser', () => {
  it('a sub-agent transcript that spawns a child makes that child a real child, not an orphan', () => {
    const { events, feed } = parserHarness()
    feed(claudeLine([{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { name: 'kid', description: 'kid', prompt: 'p' } }]), 'worker-1')
    const spawn = events().find(e => e.type === 'agent_spawn')
    assert.ok(spawn)
    assert.equal(spawn.payload.parent, 'worker-1')
    assert.equal('orphan' in spawn.payload, false)
  })

  it('and still flags a spawn whose parent never showed up in any line', () => {
    const { parser, events } = parserHarness()
    // handleToolUse is reachable without a transcript line, so the acting agent is unknown to the normalizer
    parser.handleToolUse(coerceToolUseBlock({ id: 'agent2', name: 'Agent', input: { name: 'lost', description: 'lost', prompt: 'p' } })!, 'ghost', new Map(), 's1')
    const spawn = events().find(e => e.type === 'agent_spawn')
    assert.ok(spawn)
    assert.equal(spawn.payload.orphan, true)
    assert.equal('parent' in spawn.payload, false)
  })
})

describe('Claude path: wrong-typed tool_use blocks', () => {
  it('coerceToolUseBlock: bounded string id and name, object input, anything else repaired or rejected', () => {
    const ok = coerceToolUseBlock({ type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: '/x' } })
    assert.deepEqual(ok, { type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: '/x' } })
    for (const id of [undefined, null, 5, {}, [], '', true]) assert.equal(coerceToolUseBlock({ id, name: 'Read', input: {} }), null, String(id))
    for (const name of [undefined, null, 5, {}, [], '', true]) assert.equal(coerceToolUseBlock({ id: 'a', name, input: {} })?.name, 'unknown', String(name))
    for (const input of [undefined, null, 5, 'str', [1, 2], true]) assert.deepEqual(coerceToolUseBlock({ id: 'a', name: 'Read', input })?.input, {}, String(input))
    assert.equal(coerceToolUseBlock({ id: 'i'.repeat(NORM_ID_MAX + 1), name: 'Read', input: {} })?.id.length, NORM_ID_MAX)
    assert.equal(coerceToolUseBlock({ id: 'a', name: 'n'.repeat(NORM_ID_MAX + 1), input: {} })?.name.length, NORM_ID_MAX)
    assert.equal(coerceToolUseBlock({ id: 'a', name: 'Re\u0000ad', input: {} })?.name, 'Read')
    assert.equal(coerceToolUseBlock({ id: 'a\u0007b', name: 'Read', input: {} })?.id, 'ab')
    const input = { nested: { a: 1 } }
    assert.equal(coerceToolUseBlock({ id: 'a', name: 'Read', input })?.input, input, 'a real object input is kept as is')
  })

  it('through the parser: a wrong-typed name becomes "unknown", a wrong-typed input becomes empty, an id-less block is malformed', () => {
    const { parser, events, feed } = parserHarness()
    feed(claudeLine([
      { type: 'tool_use', id: 'w1', name: { a: 1 }, input: [1, 2] },
      { type: 'tool_use', id: 'w2', name: 'Read', input: 'str' },
      { type: 'tool_use', id: 'w3', name: ['Read'], input: null },
      { type: 'tool_use', name: 'Read', input: {} },
    ]))
    const starts = events().filter(e => e.type === 'tool_call_start')
    assert.deepEqual(starts.map(e => e.payload.toolUseId), ['w1', 'w2', 'w3'])
    assert.deepEqual(starts.map(e => e.payload.tool), ['unknown', 'Read', 'unknown'])
    assert.equal(parser.getNormalizer('s1').stats.malformed, 1)
  })
})

describe('Claude path: normalizer lifecycle', () => {
  it(`keeps ${HOOK_MAX_SESSIONS} session normalizers; the ${HOOK_MAX_SESSIONS + 1}th evicts the least recently used one`, () => {
    const { parser } = parserHarness()
    const first = Array.from({ length: HOOK_MAX_SESSIONS }, (_, i) => parser.getNormalizer('e' + i))
    assert.equal(parser.getNormalizer('e0'), first[0], 'nothing evicted at the limit')
    parser.getNormalizer('e' + HOOK_MAX_SESSIONS)
    assert.equal(parser.getNormalizer('e' + (HOOK_MAX_SESSIONS - 1)), first[HOOK_MAX_SESSIONS - 1], 'a recent one survives')
    assert.notEqual(parser.getNormalizer('e1'), first[1], 'the oldest (e0 was touched, so e1) was evicted')
  })

  it('an evicted normalizer is disposed: its pending flush never fires', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const { parser, captured } = parserHarness()
      const old = parser.getNormalizer('d0')
      old.noteMalformed() // arms the trailing flush
      for (let i = 1; i <= HOOK_MAX_SESSIONS; i++) parser.getNormalizer('d' + i)
      mock.timers.tick(10 * NORM_STATS_MIN_INTERVAL_MS)
      assert.equal(statsOf(captured.map(c => c.event), 'd0').length, 0)
    } finally { mock.timers.reset() }
  })

  it('a held-back count is published through the delegate, with the session id as the emit argument', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const { parser, captured } = parserHarness()
      parser.getNormalizer('t1').noteMalformed()
      mock.timers.tick(NORM_STATS_MIN_INTERVAL_MS)
      assert.equal(captured.length, 1)
      assert.equal(captured[0].event.type, 'normalization_stats')
      assert.equal(captured[0].event.sessionId, 't1')
      assert.equal(captured[0].sessionId, 't1')
    } finally { mock.timers.reset() }
  })

  it('clearSessionState drops the normalizer of that session (and only that one) and cancels its flush', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const { parser, captured } = parserHarness()
      const gone = parser.getNormalizer('c1')
      const kept = parser.getNormalizer('c2')
      gone.noteMalformed()
      parser.clearSessionState([], 'c1')
      mock.timers.tick(10 * NORM_STATS_MIN_INTERVAL_MS)
      assert.equal(captured.length, 0, 'the cleared session never reports again')
      assert.notEqual(parser.getNormalizer('c1'), gone)
      assert.equal(parser.getNormalizer('c2'), kept)
      // without a session id nothing is dropped
      parser.clearSessionState([])
      assert.equal(parser.getNormalizer('c2'), kept)
    } finally { mock.timers.reset() }
  })

  it('the normalizer of a session shares its counters with the registry; sessions without an id get private ones', () => {
    const { parser, registry } = parserHarness()
    parser.getNormalizer('r1').noteMalformed()
    assert.equal(registry.get('r1').stats.malformed, 1)
    parser.getNormalizer(undefined).noteMalformed()
    assert.equal(registry.size, 1, 'no registry entry for an id-less session')
  })

  it('the pre-scan of an existing transcript counts what it cannot parse, per session, without throwing', () => {
    const { parser } = parserHarness()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-norm-prescan-'))
    try {
      const file = path.join(dir, 't.jsonl')
      fs.writeFileSync(file, [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
        'garbage',
        '[]',
        '',
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [null] } }), // throws inside the scan
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'pre1', name: 'Read', input: {} }] } }),
      ].join('\n') + '\n')
      const session = makeSession({ sessionId: 'p1' })
      let entries: unknown[] = []
      assert.doesNotThrow(() => { entries = parser.prescanExistingContent(file, fs.statSync(file).size, session) })
      assert.equal(parser.getNormalizer('p1').stats.malformed, 3, 'garbage, a non-object and the line that throws')
      assert.ok(entries.length >= 2)
      assert.ok(session.seenToolUseIds.has('pre1'))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('Codex path: lifecycle', () => {
  function codex() {
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: e => events.push(e), elapsed: () => 1 })
    const state = createCodexRolloutState()
    return { events, parser, feed: (line: string) => parser.processLine(line, state) }
  }
  const fnCall = (callId: unknown) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: callId, arguments: '{"command":["ls"]}' } })
  const customCall = (callId: unknown) => JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: callId, input: '*** Begin Patch\n*** Update File: a.ts\n*** End Patch' } })

  it('garbage counted while no event flows is still published (trailing flush reaches the delegate)', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const { events, feed } = codex()
      feed('not json')
      mock.timers.tick(NORM_STATS_MIN_INTERVAL_MS)
      const published = statsOf(events)
      assert.equal(published.length, 1)
      assert.equal(published[0].payload.malformed, 1)
    } finally { mock.timers.reset() }
  })

  it('a custom_tool_call replayed with the same call_id is forwarded once and counted as a duplicate', () => {
    const { events, parser, feed } = codex()
    feed(customCall('cc1'))
    feed(customCall('cc1'))
    assert.equal(events.filter(e => e.type === 'tool_call_start').length, 1)
    assert.equal(parser.normalizer.stats.duplicateEvents, 1)
    feed(customCall('cc2'))
    assert.equal(events.filter(e => e.type === 'tool_call_start').length, 2)
    assert.equal(parser.normalizer.stats.duplicateEvents, 1)
  })

  it('a call_id that is not a string never starts a call (function_call and custom_tool_call)', () => {
    const { events, parser, feed } = codex()
    for (const id of [7, {}, [], true, null]) { feed(fnCall(id)); feed(customCall(id)) }
    assert.equal(events.filter(e => e.type === 'tool_call_start').length, 0)
    assert.equal(parser.normalizer.stats.duplicateEvents, 0)
    assert.equal(parser.normalizer.stats.malformed, 0)
    feed(fnCall('ok1'))
    assert.equal(events.filter(e => e.type === 'tool_call_start').length, 1)
  })
})

// ─── Real HookServer on a loopback ephemeral port ───────────────────────────

describe('HookServer: wiring through the real http entry point', () => {
  type HookServerCtor = typeof import('../src/hook-server').HookServer
  let HookServer: HookServerCtor
  before(async () => { ({ HookServer } = await import('../src/hook-server')) })
  after(() => fs.rmSync(fakeHome, { recursive: true, force: true }))

  function post(port: number, body: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
      req.on('error', reject)
      req.end(body)
    })
  }
  /** An accepted PreToolUse whose Infinity input costs the counters one clamped field. */
  const preTool = (session: string, id: string) =>
    `{"session_id":"${session}","hook_event_name":"PreToolUse","tool_name":"Read","tool_use_id":"${id}","tool_input":{"file_path":"/a.ts","limit":1e999}}`
  const sessionEnd = (session: string) => `{"session_id":"${session}","hook_event_name":"SessionEnd"}`
  const startsOf = (events: AgentEvent[], session: string) => events.filter(e => e.type === 'tool_call_start' && e.sessionId === session)

  /** White-box peek at the server's per-session normalizers (the lifecycle is observable nowhere else). */
  const normalizersOf = (server: object) => (server as unknown as { normalizers: Map<string, { dispose(): void }> }).normalizers

  async function withServer(registry: CountersRegistry, body: (ctx: { server: InstanceType<HookServerCtor>; port: number; events: AgentEvent[] }) => Promise<void>) {
    const server = new HookServer(undefined, registry)
    const port = await server.start()
    const events: AgentEvent[] = []
    server.onEvent(e => events.push(e as AgentEvent))
    try { await body({ server, port, events }) } finally { server.dispose() }
  }

  /** Send many requests while staying under the per-IP rate limit (200 burst, 100/s). */
  async function postPaced(port: number, bodies: string[]): Promise<void> {
    for (let i = 0; i < bodies.length; i++) {
      if (i > 0 && i % 120 === 0) await sleep(1200)
      assert.equal(await post(port, bodies[i]), bodies[i].includes('"tool_input":"nope"') ? 400 : 200)
    }
  }

  it('production wiring: a HookServer and a TranscriptParser built with NO registry share one counter object per session', async () => {
    // claude-runtime.ts calls new HookServer() and session-watcher.ts new TranscriptParser(delegate): the defaults
    // are what make "one counter object per session" true in the real app, so the test must not inject any.
    const server = new HookServer()
    const port = await server.start()
    const events: AgentEvent[] = []
    server.onEvent(e => events.push(e as AgentEvent))
    try {
      const delegate: TranscriptParserDelegate = {
        emit: e => { events.push(e) }, elapsed: () => 1,
        getSession: () => makeSession(), fireSessionLifecycle: () => {}, emitContextUpdate: () => {},
      }
      const parser = new TranscriptParser(delegate)
      const sid = 'prod-default-wiring-1'
      assert.equal(await post(port, '{"session_id":"' + sid + '","hook_event_name":"PreToolUse","tool_input":"nope"}'), 400)
      parser.processTranscriptLine(
        claudeLine([{ type: 'tool_use', id: 'x1', name: 123, input: 'not-an-object' }]),
        'orchestrator', new Map(), new Set(), sid, new Set(),
      )
      const fromHook = server.getNormalizationStats(sid)
      const fromParser = parser.getNormalizer(sid).stats
      assert.ok(fromHook.malformed >= 1, 'the hook side counted its rejected request')
      assert.deepEqual(fromHook, fromParser, 'both producers read the SAME totals (split counters would differ)')
    } finally { server.dispose() }
  })

  it('one counter object per session: hook server and transcript parser publish MERGED totals, never shrinking', async () => {
    const registry = new CountersRegistry()
    await withServer(registry, async ({ server, port, events }) => {
      const { parser, feed } = (() => {
        const delegate: TranscriptParserDelegate = {
          emit: e => { events.push(e) }, elapsed: () => 1,
          getSession: () => makeSession(), fireSessionLifecycle: () => {}, emitContextUpdate: () => {},
        }
        const p = new TranscriptParser(delegate, registry)
        return { parser: p, feed: (line: string) => p.processTranscriptLine(line, 'orchestrator', new Map(), new Set(), 'merge1', new Set()) }
      })()
      assert.equal(await post(port, preTool('merge1', 'h1')), 200)
      const blocks = Array.from({ length: NORM_MAX_CHILDREN_PER_AGENT + 44 }, (_, i) => ({ type: 'tool_use', id: 'tu' + i, name: 'Agent', input: { name: 'c' + i, description: 'd' + i, prompt: 'p' } }))
      feed(claudeLine(blocks))
      assert.equal(await post(port, '{"session_id":"merge1","hook_event_name":"PreToolUse","tool_input":"nope"}'), 400)
      await sleep(NORM_STATS_MIN_INTERVAL_MS + 400)

      const merged = { droppedByCap: 44, malformed: 1, clampedFields: 1 }
      const published = statsOf(events, 'merge1').map(e => e.payload as Record<string, number>)
      const last = published[published.length - 1]
      for (const [k, v] of Object.entries(merged)) assert.equal(last[k], v, `last published ${k}`)
      for (let i = 1; i < published.length; i++) {
        for (const k of Object.keys(published[i])) assert.ok(published[i][k] >= published[i - 1][k], `${k} never shrinks (last-wins in the UI)`)
      }
      // both producers read the very same totals
      assert.deepEqual(server.getNormalizationStats('merge1'), parser.getNormalizer('merge1').stats)
      assert.equal(parser.getNormalizer('merge1').stats.malformed, 1)
      assert.equal(parser.getNormalizer('merge1').stats.droppedByCap, 44)
    })
  })

  it('session end publishes the last counters at once and forgets the session (dedup state starts over)', async () => {
    await withServer(new CountersRegistry(), async ({ server, port, events }) => {
      assert.equal(await post(port, preTool('se1', 'tuA')), 200)
      assert.equal(await post(port, preTool('se1', 'tuB')), 200) // counted, but held back by the throttle
      assert.equal(await post(port, preTool('se1', 'tuB')), 200) // duplicate
      assert.equal(startsOf(events, 'se1').length, 2)
      assert.equal(statsOf(events, 'se1').length, 1, 'only the first change was published so far')
      const disposed = mock.method(normalizersOf(server).get('se1')!, 'dispose')
      assert.equal(await post(port, sessionEnd('se1')), 200)
      assert.equal(disposed.mock.callCount(), 1, 'the normalizer of an ended session is disposed')
      assert.equal(normalizersOf(server).has('se1'), false)
      const published = statsOf(events, 'se1')
      assert.equal(published.length, 2, 'the session end flushed what the throttle held back, without waiting')
      assert.deepEqual(published[1].payload, { ...server.getNormalizationStats('se1') })
      assert.equal((published[1].payload as { clampedFields: number }).clampedFields, 3, 'the repeat was cleaned before being recognised as a repeat')
      assert.equal((published[1].payload as { duplicateEvents: number }).duplicateEvents, 1)
      // the session is over: a tool_use_id seen before is new again
      assert.equal(await post(port, preTool('se1', 'tuA')), 200)
      assert.equal(startsOf(events, 'se1').length, 3)
    })
  })

  it('a session end with nothing new to say publishes no extra stats event', async () => {
    await withServer(new CountersRegistry(), async ({ port, events }) => {
      assert.equal(await post(port, `{"session_id":"se2","hook_event_name":"PreToolUse","tool_name":"Read","tool_use_id":"x","tool_input":{"file_path":"/a.ts"}}`), 200)
      assert.equal(await post(port, sessionEnd('se2')), 200)
      assert.equal(statsOf(events, 'se2').length, 0)
    })
  })

  it('a change held back by the throttle is published by itself once the interval has passed', async () => {
    await withServer(new CountersRegistry(), async ({ port, events }) => {
      assert.equal(await post(port, preTool('tr1', 'a')), 200)
      assert.equal(await post(port, preTool('tr1', 'b')), 200)
      assert.equal(statsOf(events, 'tr1').length, 1)
      await sleep(NORM_STATS_MIN_INTERVAL_MS + 400)
      const published = statsOf(events, 'tr1')
      assert.equal(published.length, 2)
      assert.equal((published[1].payload as { clampedFields: number }).clampedFields, 2)
      assert.equal(published[1].sessionId, 'tr1')
    })
  })

  it('a rejected request on a live session is published by itself too (no further event needed)', async () => {
    await withServer(new CountersRegistry(), async ({ port, events }) => {
      assert.equal(await post(port, `{"session_id":"rj1","hook_event_name":"PreToolUse","tool_name":"Read","tool_use_id":"x","tool_input":{"file_path":"/a.ts"}}`), 200)
      assert.equal(await post(port, '{"session_id":"rj1","hook_event_name":"PreToolUse","tool_input":"nope"}'), 400)
      await sleep(NORM_STATS_MIN_INTERVAL_MS + 400)
      const published = statsOf(events, 'rj1')
      assert.equal(published.length, 1)
      assert.equal((published[0].payload as { malformed: number }).malformed, 1)
    })
  })

  it('dispose cancels every pending flush: nothing is fired after it', async () => {
    const server = new HookServer(undefined, new CountersRegistry())
    const port = await server.start()
    const emitter = (server as unknown as { _onEvent: { fire: (e: unknown) => void } })._onEvent
    const realFire = emitter.fire.bind(emitter)
    let disposed = false
    let firedAfterDispose = 0
    emitter.fire = (e: unknown) => { if (disposed) firedAfterDispose++; realFire(e) }
    assert.equal(await post(port, preTool('dp1', 'a')), 200)
    assert.equal(await post(port, preTool('dp1', 'b')), 200) // pending flush
    assert.equal(await post(port, '{"session_id":"dp1","hook_event_name":"PreToolUse","tool_input":"nope"}'), 400)
    const disposeSpy = mock.method(normalizersOf(server).get('dp1')!, 'dispose')
    server.dispose()
    assert.equal(disposeSpy.mock.callCount(), 1, 'every live normalizer is disposed with the server')
    assert.equal(normalizersOf(server).size, 0)
    disposed = true
    await sleep(NORM_STATS_MIN_INTERVAL_MS + 400)
    assert.equal(firedAfterDispose, 0)
  })

  it(`keeps ${HOOK_MAX_SESSIONS} session normalizers: the oldest is evicted by the ${HOOK_MAX_SESSIONS + 1}th, recent ones keep their state`, async () => {
    await withServer(new CountersRegistry(), async ({ server, port, events }) => {
      const bodies = Array.from({ length: HOOK_MAX_SESSIONS + 1 }, (_, i) => preTool('ev' + i, 'tu'))
      await postPaced(port, bodies.slice(0, HOOK_MAX_SESSIONS)) // ev0 .. ev255: exactly at the limit
      assert.equal(await post(port, preTool('ev0', 'tu')), 200)
      assert.equal(startsOf(events, 'ev0').length, 1, 'at the limit nothing was evicted: the repeat is a duplicate')
      // ev0 was touched, so ev1 is now the oldest
      const evictedSpy = mock.method(normalizersOf(server).get('ev1')!, 'dispose')
      assert.equal(await post(port, bodies[HOOK_MAX_SESSIONS]), 200)
      assert.equal(evictedSpy.mock.callCount(), 1, 'an evicted normalizer is disposed')
      assert.equal(normalizersOf(server).size, HOOK_MAX_SESSIONS)
      assert.equal(await post(port, preTool('ev' + (HOOK_MAX_SESSIONS - 1), 'tu')), 200)
      assert.equal(startsOf(events, 'ev' + (HOOK_MAX_SESSIONS - 1)).length, 1, 'a recent session keeps its state')
      assert.equal(await post(port, preTool('ev1', 'tu')), 200)
      assert.equal(startsOf(events, 'ev1').length, 2, 'the oldest session lost its state')
    })
  })

  it('a flood of rejected requests with invented session ids cannot evict the state of a live session', async () => {
    await withServer(new CountersRegistry(), async ({ port, events }) => {
      assert.equal(await post(port, preTool('live', 'tu')), 200)
      const flood = Array.from({ length: HOOK_MAX_SESSIONS + 20 }, (_, i) => `{"session_id":"junk${i}","hook_event_name":"PreToolUse","tool_input":"nope"}`)
      await postPaced(port, flood)
      assert.equal(await post(port, preTool('live', 'tu')), 200)
      assert.equal(startsOf(events, 'live').length, 1, 'the live session still remembers its tool_use_id')
    })
  })

  it('malformed bodies that name no usable session are counted as unattributed', async () => {
    await withServer(new CountersRegistry(), async ({ server, port }) => {
      for (const body of ['{', '{"session_id":"bad id with spaces!","hook_event_name":"Stop"}', '{"hook_event_name":"Stop"}']) assert.equal(await post(port, body), 400, body)
      assert.equal(server.getNormalizationStats().malformed, 3)
      assert.equal(server.getNormalizationStats('never-seen').malformed, 3, 'an unknown session reads the unattributed counters')
    })
  })
})
