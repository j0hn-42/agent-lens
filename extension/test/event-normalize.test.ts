/**
 * Input normalization (#51): helpers, per-session counters and caps, and a malformed-event corpus
 * pushed through every ingestion path (Claude JSONL, Codex rollout, hook server). Nothing may
 * throw, counters must be exact, caps must hold.
 */
import './helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  ostr, num, oneOf, isUuid, ts, boundedArray, boundedEntries, sanitizeValue, parseJsonLine,
  createStats, isTruncated, SessionNormalizer, CountersRegistry,
} from '../src/event-normalize'
import {
  NORM_TEXT_MAX, NORM_ID_MAX, NORM_NUM_MAX, NORM_TS_MAX_MS, NORM_EVENT_TIME_MAX_S, NORM_MAX_DEPTH,
  NORM_MAX_ARRAY, NORM_MAX_KEYS, NORM_MAX_CHILDREN_PER_AGENT, NORM_MAX_NODES_PER_SESSION,
  NORM_MAX_EVENTS_PER_BATCH, NORM_MAX_LINE_CHARS, NORM_STATS_MIN_INTERVAL_MS,
} from '../src/constants'
import type { AgentEvent } from '../src/protocol'
import { TranscriptParser, type TranscriptParserDelegate } from '../src/transcript-parser'
import { CodexRolloutParser, createCodexRolloutState } from '../src/codex-rollout-parser'
import { makeSession } from './helpers/teams-fixtures'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-norm-home-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome

/** Fails when any value of the events breaks the documented caps. */
function assertClean(events: AgentEvent[]): void {
  const walk = (v: unknown, depth: number, where: string): void => {
    assert.ok(depth <= NORM_MAX_DEPTH + 2, `${where}: too deep`)
    if (typeof v === 'string') {
      assert.ok(v.length <= NORM_TEXT_MAX, `${where}: string of ${v.length} chars`)
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v), `${where}: control character`)
    } else if (typeof v === 'number') {
      assert.ok(Number.isFinite(v) && Math.abs(v) <= NORM_TS_MAX_MS, `${where}: number ${v}`)
    } else if (Array.isArray(v)) {
      assert.ok(v.length <= NORM_MAX_ARRAY, `${where}: array of ${v.length}`)
      v.forEach((x, i) => walk(x, depth + 1, `${where}[${i}]`))
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v)
      assert.ok(keys.length <= NORM_MAX_KEYS, `${where}: ${keys.length} keys`)
      for (const k of keys) {
        assert.ok(!['__proto__', 'constructor', 'prototype'].includes(k), `${where}: forbidden key ${k}`)
        walk((v as Record<string, unknown>)[k], depth + 1, `${where}.${k}`)
      }
    }
  }
  for (const e of events) {
    assert.ok(Number.isFinite(e.time) && e.time >= 0 && e.time <= NORM_EVENT_TIME_MAX_S, `time ${e.time}`)
    walk(e.payload, 0, e.type)
  }
}

const spawn = (name: string, parent?: string, extra: Record<string, unknown> = {}): AgentEvent => ({
  time: 1, type: 'agent_spawn', payload: { name, ...(parent ? { parent } : {}), task: 't', ...extra },
})

describe('leaf helpers', () => {
  it('ostr strips control characters, caps the length and counts each altered field', () => {
    const stats = createStats()
    assert.equal(ostr('a\u0000b\u0007c', 10, stats), 'abc')
    assert.equal(stats.clampedFields, 1)
    assert.equal(ostr('x'.repeat(50), 10, stats), 'x'.repeat(10))
    assert.equal(stats.clampedFields, 2)
    assert.equal(ostr('clean', 10, stats), 'clean')
    assert.equal(stats.clampedFields, 2, 'an untouched string is not counted')
    assert.equal(ostr(42, 10, stats), undefined)
    assert.equal(ostr({}, 10, stats), undefined)
  })

  it('ostr keeps newlines of free text but strips them from identifiers', () => {
    assert.equal(ostr('a\nb\tc', 10, undefined, true), 'a\nb\tc')
    assert.equal(ostr('a\nb', 10), 'ab')
    assert.equal(ostr('a b', 10, undefined, true), 'ab')
  })

  it('num rejects NaN/Infinity and clamps to the documented range', () => {
    const stats = createStats()
    assert.equal(num(NaN, stats), undefined)
    assert.equal(num(Infinity, stats), undefined)
    assert.equal(num(-Infinity, stats), undefined)
    assert.equal(num('5', stats), undefined)
    assert.equal(num(7, stats), 7)
    assert.equal(stats.clampedFields, 0)
    assert.equal(num(1e300, stats), NORM_NUM_MAX)
    assert.equal(num(-1e300, stats), -NORM_NUM_MAX)
    assert.equal(num(5, stats, 10, 20), 10)
    assert.equal(stats.clampedFields, 3)
  })

  it('oneOf, isUuid', () => {
    assert.equal(oneOf('a', ['a', 'b'] as const), 'a')
    assert.equal(oneOf('c', ['a', 'b'] as const), undefined)
    assert.equal(oneOf(1, ['a'] as const), undefined)
    assert.equal(isUuid('123e4567-e89b-12d3-a456-426614174000'), true)
    assert.equal(isUuid('123e4567-e89b-12d3-a456-42661417400'), false)
    assert.equal(isUuid('zzze4567-e89b-12d3-a456-426614174000'), false)
    assert.equal(isUuid(null), false)
  })

  it('ts keeps plausible epoch-ms values, clamps far-future ones, drops negative ones and garbage', () => {
    const stats = createStats()
    assert.equal(ts(1_700_000_000_000, stats), 1_700_000_000_000)
    assert.equal(stats.clampedFields, 0)
    assert.equal(ts(-5, stats), undefined, 'a negative time is implausible: dropped, not shown as 1970')
    assert.equal(ts(9e15, stats), NORM_TS_MAX_MS)
    assert.equal(ts(NaN, stats), undefined)
    assert.equal(ts('1700000000000', stats), undefined)
    assert.equal(stats.clampedFields, 1, 'only the far-future clamp is counted by ts; the container counts a drop')
  })

  it('boundedArray / boundedEntries cut and count; forbidden keys never pass', () => {
    const stats = createStats()
    assert.equal(boundedArray([1, 2, 3], 2, stats)?.length, 2)
    assert.equal(stats.clampedFields, 1)
    assert.equal(boundedArray('no', 2, stats), undefined)
    const poisoned = JSON.parse('{"__proto__":{"polluted":1},"constructor":2,"prototype":3,"ok":4}')
    const entries = boundedEntries(poisoned, 10, stats)
    assert.deepEqual(entries, [['ok', 4]])
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
  })
})

describe('sanitizeValue', () => {
  it('cleans nested garbage: depth, array and key caps, NaN, prototype keys', () => {
    const stats = createStats()
    let deep: Record<string, unknown> = { leaf: 'x' }
    for (let i = 0; i < 40; i++) deep = { n: deep }
    const wide: Record<string, number> = {}
    for (let i = 0; i < NORM_MAX_KEYS + 50; i++) wide['k' + i] = i
    const input = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as Record<string, unknown>
    Object.assign(input, {
      deep, wide, list: new Array(NORM_MAX_ARRAY + 10).fill(1), bad: NaN, inf: Infinity, huge: 1e300,
      big: 'y'.repeat(NORM_TEXT_MAX * 3), name: 'n'.repeat(NORM_ID_MAX * 2), joinedAt: -1, startTime: 9e15,
      fn: () => 1, nothing: null,
    })
    const out = sanitizeValue(input, stats) as Record<string, unknown>
    assertClean([{ time: 0, type: 'message', payload: out }])
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
    assert.equal(Object.keys(out.wide as object).length, NORM_MAX_KEYS)
    assert.equal((out.list as unknown[]).length, NORM_MAX_ARRAY)
    assert.equal((out.big as string).length, NORM_TEXT_MAX)
    assert.equal((out.name as string).length, NORM_ID_MAX)
    assert.equal('bad' in out, false)
    assert.equal('inf' in out, false)
    assert.equal(out.huge, NORM_NUM_MAX)
    assert.equal('joinedAt' in out, false, 'a negative timestamp is dropped')
    assert.equal(out.startTime, NORM_TS_MAX_MS)
    assert.equal('fn' in out, false)
    assert.ok(stats.clampedFields >= 10)
  })
})

describe('parseJsonLine', () => {
  it('blank lines are silent; invalid, non-object and oversized lines are malformed', () => {
    const stats = createStats()
    assert.equal(parseJsonLine('   ', stats), undefined)
    assert.equal(stats.malformed, 0)
    for (const bad of ['{', 'nope', '[]', '123', 'null', '"s"', 'true']) assert.equal(parseJsonLine(bad, stats), undefined)
    assert.equal(stats.malformed, 7)
    assert.equal(parseJsonLine('x'.repeat(NORM_MAX_LINE_CHARS + 1), stats), undefined)
    assert.equal(parseJsonLine(42, stats), undefined)
    assert.equal(stats.malformed, 9)
    assert.deepEqual(parseJsonLine('{"a":1}', stats), { a: 1 })
    assert.equal(stats.malformed, 9)
  })
})

describe('SessionNormalizer', () => {
  it('forwards a clean event unchanged and counts nothing', () => {
    const n = new SessionNormalizer('s1')
    const ev: AgentEvent = { time: 2.5, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read', toolUseId: 't1' } }
    assert.deepEqual(n.process(ev), [ev])
    assert.deepEqual(n.stats, createStats())
    assert.equal(isTruncated(n.stats), false)
  })

  it('non-objects and events without a string type are malformed; unknown types are ignored', () => {
    const n = new SessionNormalizer()
    for (const bad of [null, 5, 'str', [], { payload: {} }, { type: 7, payload: {} }, { type: 'message' }, { type: 'message', payload: [] }]) {
      assert.deepEqual(n.process(bad).filter(e => e.type !== 'normalization_stats'), [], JSON.stringify(bad))
    }
    assert.equal(n.stats.malformed, 8)
    assert.deepEqual(n.process({ type: 'from_the_future', payload: {} }).filter(e => e.type !== 'normalization_stats'), [])
    assert.equal(n.stats.ignoredEvents, 1)
    // a producer cannot forge the stats event
    n.process({ type: 'normalization_stats', time: 0, payload: { ignoredEvents: 99 } })
    assert.equal(n.stats.ignoredEvents, 2)
  })

  it('clamps time: negative, NaN and far-future values', () => {
    const n = new SessionNormalizer()
    const times = [-10, NaN, Infinity, 1e15, 12.5].map(time => n.process({ time, type: 'agent_idle', payload: { name: 'orchestrator' } })[0].time)
    assert.deepEqual(times, [0, 0, 0, NORM_EVENT_TIME_MAX_S, 12.5])
    assert.equal(n.stats.clampedFields, 4)
  })

  it('drops exact tool-call repeats and counts them as duplicates, not as truncation', () => {
    const n = new SessionNormalizer()
    const start: AgentEvent = { time: 1, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read', toolUseId: 't1' } }
    const end: AgentEvent = { time: 2, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Read', toolUseId: 't1' } }
    assert.equal(n.process(start).filter(e => e.type === 'tool_call_start').length, 1)
    assert.equal(n.process(start).filter(e => e.type === 'tool_call_start').length, 0)
    assert.equal(n.process(end).filter(e => e.type === 'tool_call_end').length, 1)
    assert.equal(n.process(end).filter(e => e.type === 'tool_call_end').length, 0)
    assert.equal(n.stats.duplicateEvents, 2)
    assert.equal(isTruncated(n.stats), false)
  })

  it('a spawn whose parent never existed becomes a detached orphan, never a guessed parent', () => {
    const n = new SessionNormalizer()
    const [orphan] = n.process(spawn('lost', 'ghost-parent'))
    assert.equal(orphan.payload.orphan, true)
    assert.equal('parent' in orphan.payload, false)
    // a known parent keeps its link and is not flagged
    n.process(spawn('orchestrator'))
    const [kid] = n.process(spawn('kid', 'orchestrator'))
    assert.equal(kid.payload.parent, 'orchestrator')
    assert.equal('orphan' in kid.payload, false)
    const [grandkid] = n.process(spawn('grandkid', 'kid'))
    assert.equal(grandkid.payload.parent, 'kid')
    // an agent seen acting is a valid parent too
    n.noteAgent('sub-from-watcher')
    assert.equal(n.process(spawn('x', 'sub-from-watcher'))[0].payload.parent, 'sub-from-watcher')
  })

  it(`caps children per agent at ${NORM_MAX_CHILDREN_PER_AGENT}: 10k spawns forward exactly the cap, the rest is counted`, () => {
    const n = new SessionNormalizer()
    let forwarded = 0
    for (let i = 0; i < 10_000; i++) forwarded += n.process(spawn('c' + i, 'orchestrator')).filter(e => e.type === 'agent_spawn').length
    assert.equal(forwarded, NORM_MAX_CHILDREN_PER_AGENT)
    assert.equal(n.stats.droppedByCap, 10_000 - NORM_MAX_CHILDREN_PER_AGENT)
    assert.equal(isTruncated(n.stats), true)
  })

  it(`caps nodes per session at ${NORM_MAX_NODES_PER_SESSION}, and the events of a dropped node are ignored`, () => {
    const n = new SessionNormalizer()
    let forwarded = 0
    // every node is its own parent chain root (no parent): only the node cap applies
    for (let i = 0; i < NORM_MAX_NODES_PER_SESSION + 20; i++) forwarded += n.process(spawn('n' + i)).filter(e => e.type === 'agent_spawn').length
    assert.equal(forwarded, NORM_MAX_NODES_PER_SESSION)
    assert.equal(n.stats.droppedByCap, 20)
    const last = 'n' + (NORM_MAX_NODES_PER_SESSION + 19)
    const out = n.process({ time: 1, type: 'tool_call_start', payload: { agent: last, tool: 'Read', toolUseId: 'z' } })
    assert.equal(out.filter(e => e.type === 'tool_call_start').length, 0)
    assert.equal(n.stats.ignoredEvents, 1)
    // an already-known node still passes (re-activation)
    assert.equal(n.process(spawn('n0')).filter(e => e.type === 'agent_spawn').length, 1)
  })

  it('a dispatch counts against the same caps as its spawn', () => {
    const n = new SessionNormalizer('s', { childrenCap: 2 })
    const dispatch = (child: string): AgentEvent => ({ time: 1, type: 'subagent_dispatch', payload: { parent: 'orchestrator', child, task: 't' } })
    const kinds = ['a', 'b', 'c'].map(c => n.process(dispatch(c)).filter(e => e.type === 'subagent_dispatch').length)
    assert.deepEqual(kinds, [1, 1, 0])
    assert.equal(n.stats.droppedByCap, 1)
    // the spawn that follows the dropped dispatch is ignored, the others pass
    assert.equal(n.process(spawn('c', 'orchestrator')).filter(e => e.type === 'agent_spawn').length, 0)
    assert.equal(n.process(spawn('a', 'orchestrator')).filter(e => e.type === 'agent_spawn').length, 1)
  })

  it(`processBatch keeps ${NORM_MAX_EVENTS_PER_BATCH} events and ignores the rest`, () => {
    const n = new SessionNormalizer()
    const batch = Array.from({ length: NORM_MAX_EVENTS_PER_BATCH + 7 }, (_, i) => ({ time: i, type: 'agent_idle', payload: { name: 'orchestrator' } }))
    assert.equal(n.processBatch(batch).filter(e => e.type === 'agent_idle').length, NORM_MAX_EVENTS_PER_BATCH)
    assert.equal(n.stats.ignoredEvents, 7)
    assert.deepEqual(n.processBatch('nope').filter(e => e.type !== 'normalization_stats'), [])
    assert.equal(n.stats.malformed, 1)
  })

  it('emits a normalization_stats event with the exact counters, throttled, and only when they changed', () => {
    let now = 1000
    const n = new SessionNormalizer('s9', { now: () => now })
    const idle: AgentEvent = { time: 1, type: 'agent_idle', payload: { name: 'orchestrator' } }
    assert.equal(n.process(idle).length, 1, 'no stats event while nothing was discarded')
    const first = n.process({ type: 'weird', payload: {} })
    assert.equal(first.length, 1)
    assert.equal(first[0].type, 'normalization_stats')
    assert.equal(first[0].sessionId, 's9')
    assert.deepEqual(first[0].payload, { ...createStats(), ignoredEvents: 1 })
    now += NORM_STATS_MIN_INTERVAL_MS - 1
    assert.equal(n.process({ type: 'weird', payload: {} }).length, 0, 'throttled')
    now += 1
    const again = n.process(idle)
    assert.equal(again[again.length - 1].type, 'normalization_stats')
    assert.equal((again[again.length - 1].payload as { ignoredEvents: number }).ignoredEvents, 2)
    assert.equal(n.process(idle).length, 1, 'unchanged counters: no repeat')
    n.stats.malformed++
    assert.equal(n.flush()?.type, 'normalization_stats', 'flush ignores the throttle')
    assert.equal(n.flush(), null)
  })
})

// ─── Corpus through each ingestion path ──────────────────────────────────────

const claudeLine = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', uuid: 'u', sessionId: 's1', message: { role: 'assistant', content }, ...extra })

function transcriptHarness(elapsed: () => number = () => 1) {
  const events: AgentEvent[] = []
  const delegate: TranscriptParserDelegate = {
    emit: e => { events.push(e) }, elapsed,
    getSession: () => makeSession(), fireSessionLifecycle: () => {}, emitContextUpdate: () => {},
  }
  const parser = new TranscriptParser(delegate, new CountersRegistry())
  const feed = (line: string) => parser.processTranscriptLine(line, 'orchestrator', new Map(), new Set(), 's1', new Set())
  return { parser, events, feed }
}

describe('corpus: Claude JSONL', () => {
  it('survives wrong types, garbage lines and prototype-pollution keys without throwing, with exact counters', () => {
    const { parser, events, feed } = transcriptHarness()
    const lines: Array<[string, number]> = [ // [line, expected malformed increments]
      ['', 0],
      ['   ', 0],
      ['not json at all', 1],
      ['{', 1],
      ['[]', 1],
      ['123', 1],
      ['null', 1],
      ['"string"', 1],
      ['x'.repeat(NORM_MAX_LINE_CHARS + 1), 1],
      [JSON.stringify({ type: 'user', message: null }), 1],
      [JSON.stringify({ type: 'user', message: 'str' }), 1],
      [JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'plain string content' } }), 0],
      [claudeLine([null, 5, 'str', true]), 4],
      [claudeLine([{ type: 'tool_use' }, { type: 'tool_use', id: 5 }, { type: 'tool_use', name: 'Read', id: { a: 1 } }]), 3],
      [claudeLine([{ type: 'tool_result', tool_use_id: 7 }, { type: 'tool_result' }]), 2],
      [JSON.stringify({ type: 'progress', data: 'nope' }), 0],
      [JSON.stringify({ type: 'unknown-kind' }), 0],
    ]
    let expected = 0
    for (const [line, bad] of lines) {
      assert.doesNotThrow(() => feed(line), line.slice(0, 40))
      expected += bad
    }
    assert.equal(parser.getNormalizer('s1').stats.malformed, expected)

    const before = events.length
    // wrong-typed but recoverable blocks: tool name/input of the wrong type still never throw
    feed(claudeLine([{ type: 'tool_use', id: 'weird1', name: { a: 1 }, input: [1, 2] }, { type: 'tool_use', id: 'weird2', name: 'Read', input: 'str' }]))
    assert.ok(events.length > before)
    assertClean(events)
  })

  it('prototype-pollution keys in a transcript line never reach an emitted event or Object.prototype', () => {
    const { events, feed } = transcriptHarness()
    feed('{"type":"assistant","__proto__":{"polluted":true},"message":{"role":"assistant","content":[{"type":"tool_use","id":"p1","name":"Read","input":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"file_path":"/a.ts"}}]}}')
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
    assert.ok(events.some(e => e.type === 'tool_call_start'))
    assert.ok(!JSON.stringify(events).includes('polluted'))
    assertClean(events)
  })

  it('huge strings and control characters are capped and stripped in emitted events', () => {
    const { parser, events, feed } = transcriptHarness()
    feed(claudeLine([{ type: 'tool_use', id: 'big1', name: 'Re\u0000ad\u0007', input: { file_path: '/a/' + 'p'.repeat(2_000_000) } }]))
    const start = events.find(e => e.type === 'tool_call_start')
    assert.ok(start)
    assert.equal(start.payload.tool, 'Read')
    assertClean(events)
    assert.ok(parser.getNormalizer('s1').stats.clampedFields >= 1)
  })

  it('absurd elapsed times (negative, NaN, Infinity, far future) are clamped to the valid range', () => {
    for (const bad of [-5, NaN, Infinity, 1e15]) {
      const { parser, events, feed } = transcriptHarness(() => bad)
      feed(claudeLine([{ type: 'text', text: 'hello' }]))
      assert.ok(events.length > 0)
      assertClean(events)
      assert.ok(parser.getNormalizer('s1').stats.clampedFields >= 1, `elapsed ${bad}`)
    }
  })

  it('10k children in one line: the spawns and dispatches stay under the cap and the drops are counted', async () => {
    const { parser, events, feed } = transcriptHarness()
    const blocks = Array.from({ length: 10_000 }, (_, i) => ({ type: 'tool_use', id: 'tu' + i, name: 'Agent', input: { name: 'c' + i, description: 'd' + i, prompt: 'p' } }))
    assert.doesNotThrow(() => feed(claudeLine(blocks)))
    const spawns = events.filter(e => e.type === 'agent_spawn')
    const dispatches = events.filter(e => e.type === 'subagent_dispatch')
    assert.equal(spawns.length, NORM_MAX_CHILDREN_PER_AGENT)
    assert.equal(dispatches.length, NORM_MAX_CHILDREN_PER_AGENT)
    const stats = parser.getNormalizer('s1').stats
    assert.equal(stats.droppedByCap, 10_000 - NORM_MAX_CHILDREN_PER_AGENT)
    assert.equal(isTruncated(stats), true)
    // the UI is told: once the throttle interval has passed, the final counters are published
    await new Promise(r => setTimeout(r, NORM_STATS_MIN_INTERVAL_MS + 300))
    const reported = events.filter(e => e.type === 'normalization_stats').pop()
    assert.ok(reported)
    assert.equal(reported.payload.droppedByCap, stats.droppedByCap)
    assertClean(events)
  })

  it('a line that makes processing throw is contained and counted as malformed', () => {
    let boom = true
    const { parser, feed } = transcriptHarness(() => { if (boom) throw new Error('boom'); return 1 })
    assert.doesNotThrow(() => feed(claudeLine([{ type: 'text', text: 'hello' }])))
    assert.equal(parser.getNormalizer('s1').stats.malformed, 1)
    boom = false
    assert.doesNotThrow(() => feed(claudeLine([{ type: 'text', text: 'hello again' }])))
    assert.equal(parser.getNormalizer('s1').stats.malformed, 1)
  })

  it('a duplicate tool_use id replayed on another line is forwarded once', () => {
    const { events, feed } = transcriptHarness()
    const line = claudeLine([{ type: 'tool_use', id: 'dup1', name: 'Read', input: { file_path: '/a.ts' } }])
    feed(line)
    // the parser's own seen-set is per call here (fresh Set), so the normalizer is what stops the repeat
    feed(line)
    assert.equal(events.filter(e => e.type === 'tool_call_start').length, 1)
  })
})

describe('corpus: Codex rollout', () => {
  function codexHarness() {
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: e => events.push(e), elapsed: () => 1 })
    const state = createCodexRolloutState()
    return { events, parser, state, feed: (line: string) => parser.processLine(line, state) }
  }

  it('survives garbage lines and wrong-typed payloads with exact malformed counts', () => {
    const { events, parser, feed } = codexHarness()
    const bad = ['not json', '{', '[]', '7', 'null', '"s"', 'x'.repeat(NORM_MAX_LINE_CHARS + 1)]
    for (const l of bad) assert.doesNotThrow(() => feed(l))
    assert.equal(parser.normalizer.stats.malformed, bad.length)
    for (const l of ['', '   ']) feed(l)
    assert.equal(parser.normalizer.stats.malformed, bad.length, 'blank lines are not malformed')
    const wrongTypes = [
      { type: 'session_meta', payload: 'str' }, { type: 'session_meta', payload: 5 }, { type: 'session_meta', payload: { cwd: 5, base_instructions: 'x' } },
      { type: 'turn_context', payload: null }, { type: 'turn_context', payload: { model: { a: 1 } } },
      { type: 'response_item', payload: 'str' }, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 5 } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [null, 5, { text: 9 }] } },
      { type: 'response_item', payload: { type: 'function_call', name: { a: 1 }, arguments: 5, call_id: [] } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: {}, output: 7 } },
      { type: 'event_msg', payload: 'str' }, { type: 'event_msg', payload: { type: 'token_count', info: 'x' } },
      { type: 'compacted', payload: { replacement_history: 'nope' } }, { type: {}, payload: {} },
    ]
    for (const r of wrongTypes) assert.doesNotThrow(() => feed(JSON.stringify(r)), JSON.stringify(r))
    assertClean(events)
  })

  it('huge strings, control characters and prototype keys are capped and removed', () => {
    const { events, feed } = codexHarness()
    feed('{"type":"response_item","__proto__":{"polluted":true},"payload":{"type":"function_call","name":"shell\\u0000","call_id":"c1","arguments":"{\\"command\\":[\\"ls\\"],\\"__proto__\\":{\\"polluted\\":true}}"}}')
    feed(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(3_000_000) }] } }))
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
    assert.ok(events.length >= 2)
    assertClean(events) // no own __proto__/constructor key anywhere (the args summary is display text, not an object)
  })

  it('a repeated call_id is forwarded once', () => {
    const { events, parser, feed } = codexHarness()
    const line = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'same', arguments: '{"command":["ls"]}' } })
    feed(line)
    feed(line)
    assert.equal(events.filter(e => e.type === 'tool_call_start').length, 1)
    assert.equal(parser.normalizer.stats.duplicateEvents, 1)
    assert.equal(isTruncated(parser.normalizer.stats), false)
  })

  it('a record that makes processing throw is contained and counted as malformed', () => {
    const parser = new CodexRolloutParser({ emit: () => {}, elapsed: () => { throw new Error('boom') } })
    const state = createCodexRolloutState()
    assert.doesNotThrow(() => parser.processLine(JSON.stringify({ type: 'turn_context', payload: { model: 'm' } }), state))
    assert.equal(parser.normalizer.stats.malformed, 1)
  })
})

describe('corpus: hook server', () => {
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

  it('rejected requests are counted as malformed (per session when attributable), accepted ones are cleaned', async () => {
    const server = new HookServer(undefined, new CountersRegistry())
    const port = await server.start()
    const events: AgentEvent[] = []
    server.onEvent(e => events.push(e as AgentEvent))
    try {
      // unattributable: invalid JSON, wrong root type, invalid session_id
      for (const body of ['{', '[]', '"x"', '{"session_id":42,"hook_event_name":"Stop"}']) assert.equal(await post(port, body), 400, body)
      assert.equal(server.getNormalizationStats().malformed, 4)
      // attributable to s1: valid id, invalid field
      assert.equal(await post(port, '{"session_id":"s1","hook_event_name":"PreToolUse","tool_input":"nope"}'), 400)
      assert.equal(await post(port, '{"session_id":"s1","hook_event_name":"PreToolUse","agent_id":{"a":1}}'), 400)
      assert.equal(await post(port, '{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Re\\u0000ad"}'), 400, 'control character in a name')
      assert.equal(server.getNormalizationStats('s1').malformed, 3)
      assert.equal(events.length, 0, 'a rejected request emits nothing')

      // accepted but hostile: 1e999 parses to Infinity, __proto__ keys, control chars, huge text
      const hostile = '{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Read","tool_use_id":"tu1","__proto__":{"polluted":true},'
        + '"tool_input":{"file_path":"/a.ts","limit":1e999,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"deep":'
        + '{"a":'.repeat(30) + '1' + '}'.repeat(30) + ',"big":"' + 'z'.repeat(HOOK_BIG) + '"}}'
      assert.equal(await post(port, hostile), 200)
      assert.equal(await post(port, hostile), 200, 'the same tool_use_id again')
      assert.equal(({} as Record<string, unknown>).polluted, undefined)
      const starts = events.filter(e => e.type === 'tool_call_start')
      assert.equal(starts.length, 1, 'the repeat is dropped')
      assert.equal(starts[0].payload.tool, 'Read')
      assert.ok(!JSON.stringify(events).includes('polluted'))
      assertClean(events)
      const stats = server.getNormalizationStats('s1')
      assert.equal(stats.duplicateEvents, 1)
      assert.equal(stats.malformed, 3)
      // the counters are published to the UI with the events of that session
      const reported = events.filter(e => e.type === 'normalization_stats').pop()
      assert.ok(reported)
      assert.equal(reported.sessionId, 's1')
      assert.equal(reported.payload.malformed, 3)
    } finally { server.dispose() }
  })
})

const HOOK_BIG = 3000
