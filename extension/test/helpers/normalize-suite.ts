/**
 * Behaviour suite of the normalization module (#51), written once and run against BOTH copies of
 * the module (extension/src/event-normalize.ts and its web mirror), so a bug that only one copy
 * has cannot hide behind the "verbatim mirror" source comparison.
 *
 * Every named threshold is pinned at the limit, one below and one above.
 */
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

export interface Stats { ignoredEvents: number; clampedFields: number; droppedByCap: number; malformed: number; duplicateEvents: number }
export interface Ev { time: number; type: string; payload: Record<string, unknown>; sessionId?: string }

interface NormalizerLike {
  readonly stats: Stats
  process(raw: unknown): Ev[]
  processBatch(raw: unknown): Ev[]
  noteMalformed(n?: number): void
  noteAgent(name: string): void
  flush(): Ev | null
  dispose(): void
  parseLine(line: unknown): Record<string, unknown> | undefined
}

interface NormalizerOptions {
  counters?: { stats: Stats }
  now?: () => number
  onTrailing?: (event: Ev) => void
  nodeCap?: number
  childrenCap?: number
  batchCap?: number
  knownCap?: number
}

export interface NormalizeApi {
  ostr(v: unknown, max: number, stats?: Stats, multiline?: boolean): string | undefined
  num(v: unknown, stats?: Stats, min?: number, max?: number): number | undefined
  ts(v: unknown, stats?: Stats): number | undefined
  boundedArray(v: unknown, max: number, stats?: Stats): unknown[] | undefined
  boundedEntries(v: unknown, max: number, stats?: Stats): Array<[string, unknown]> | undefined
  sanitizeValue(v: unknown, stats?: Stats, key?: string, depth?: number): unknown
  parseJsonLine(line: unknown, stats?: Stats): Record<string, unknown> | undefined
  createStats(): Stats
  SessionNormalizer: new (sessionId?: string, opts?: NormalizerOptions) => NormalizerLike
  SessionCounters: new () => { stats: Stats }
  CountersRegistry: new (max?: number) => {
    get(id: string): { stats: Stats }; has(id: string): boolean; delete(id: string): void; readonly size: number
  }
  /** The NORM_* caps of the module under test. */
  caps: Record<string, number>
}

const spawn = (name: string, parent?: string): Ev => ({ time: 1, type: 'agent_spawn', payload: { name, ...(parent ? { parent } : {}), task: 't' } })
const toolStart = (agent: string, id: string): Ev => ({ time: 1, type: 'tool_call_start', payload: { agent, tool: 'Read', toolUseId: id } })
const only = (events: Ev[], type: string) => events.filter(e => e.type === type)

/** Number of nested object (or array) levels of a value. */
function levels(v: unknown): number {
  if (v === null || typeof v !== 'object') return 0
  const kids = Array.isArray(v) ? v : Object.values(v)
  return 1 + Math.max(0, ...kids.map(levels))
}

export function normalizeSuite(label: string, api: NormalizeApi): void {
  const { caps } = api
  const {
    NORM_TEXT_MAX, NORM_ID_MAX, NORM_NUM_MAX, NORM_TS_MAX_MS, NORM_MAX_DEPTH, NORM_MAX_ARRAY, NORM_MAX_KEYS, NORM_KEY_MAX,
    NORM_MAX_LINE_CHARS, NORM_MAX_SEEN_KEYS, NORM_MAX_DROPPED_NAMES, NORM_MAX_KNOWN_AGENTS, NORM_MAX_TRACKED_SESSIONS,
    NORM_STATS_MIN_INTERVAL_MS,
  } = caps

  describe(`${label}: thresholds at the limit, one below and one above`, () => {
    it('ostr: a string of exactly max chars is untouched and uncounted; max+1 is cut and counted once', () => {
      const s = api.createStats()
      assert.equal(api.ostr('x'.repeat(10), 10, s), 'x'.repeat(10))
      assert.equal(s.clampedFields, 0)
      assert.equal(api.ostr('x'.repeat(9), 10, s), 'x'.repeat(9))
      assert.equal(s.clampedFields, 0)
      assert.equal(api.ostr('x'.repeat(11), 10, s), 'x'.repeat(10))
      assert.equal(s.clampedFields, 1)
      // cut AND stripped is still one altered field
      assert.equal(api.ostr('a\u0000' + 'x'.repeat(20), 10, s), 'a' + 'x'.repeat(8))
      assert.equal(s.clampedFields, 2)
    })

    it('ostr: the cut is made before the control characters are removed; the extra char being a control still counts', () => {
      const s = api.createStats()
      // 10 kept chars, the 11th is a control character: cut, so altered
      assert.equal(api.ostr('x'.repeat(10) + '\u0000', 10, s), 'x'.repeat(10))
      assert.equal(s.clampedFields, 1)
      // a control inside the first 10 shortens the result below max
      assert.equal(api.ostr('xx\u0007' + 'y'.repeat(7), 10, s), 'xx' + 'y'.repeat(7))
      assert.equal(s.clampedFields, 2)
      assert.equal(api.ostr('a\nb', 10, s, true), 'a\nb')
      assert.equal(s.clampedFields, 2, 'multiline keeps newlines and counts nothing')
      assert.equal(api.ostr('a\nb', 10, s), 'ab')
      assert.equal(s.clampedFields, 3)
    })

    it('num: min and max are kept as they are, one beyond is clamped and counted', () => {
      const s = api.createStats()
      assert.equal(api.num(10, s, 10, 20), 10)
      assert.equal(api.num(20, s, 10, 20), 20)
      assert.equal(api.num(15, s, 10, 20), 15)
      assert.equal(s.clampedFields, 0)
      assert.equal(api.num(9, s, 10, 20), 10)
      assert.equal(s.clampedFields, 1)
      assert.equal(api.num(21, s, 10, 20), 20)
      assert.equal(s.clampedFields, 2)
      // default range
      assert.equal(api.num(NORM_NUM_MAX, s), NORM_NUM_MAX)
      assert.equal(api.num(-NORM_NUM_MAX, s), -NORM_NUM_MAX)
      assert.equal(s.clampedFields, 2)
      assert.equal(api.num(NORM_NUM_MAX + 1, s), NORM_NUM_MAX)
      assert.equal(api.num(-NORM_NUM_MAX - 1, s), -NORM_NUM_MAX)
      assert.equal(s.clampedFields, 4)
    })

    it('num: NaN, Infinity and non-numbers are dropped WITHOUT being counted (the one who drops the field counts it)', () => {
      const s = api.createStats()
      for (const bad of [NaN, Infinity, -Infinity, '1', null, undefined, {}]) assert.equal(api.num(bad, s), undefined)
      assert.equal(s.clampedFields, 0)
    })

    it('ts: 0 and the maximum are kept; above the maximum is clamped; a negative time is dropped, never shown as 1970', () => {
      const s = api.createStats()
      assert.equal(api.ts(0, s), 0)
      assert.equal(api.ts(NORM_TS_MAX_MS, s), NORM_TS_MAX_MS)
      assert.equal(s.clampedFields, 0)
      assert.equal(api.ts(NORM_TS_MAX_MS + 1, s), NORM_TS_MAX_MS)
      assert.equal(s.clampedFields, 1)
      assert.equal(api.ts(-1, s), undefined)
      assert.equal(api.ts(-1e300, s), undefined)
      assert.equal(s.clampedFields, 1, 'ts itself does not count the drop; the container does')
    })

    it('boundedArray: exactly max keeps everything; max+1 is cut and counted once', () => {
      const s = api.createStats()
      assert.deepEqual(api.boundedArray([1, 2, 3], 3, s), [1, 2, 3])
      assert.equal(s.clampedFields, 0)
      assert.deepEqual(api.boundedArray([1, 2], 3, s), [1, 2])
      assert.deepEqual(api.boundedArray([1, 2, 3, 4], 3, s), [1, 2, 3])
      assert.equal(s.clampedFields, 1)
      assert.equal(api.boundedArray({}, 3, s), undefined)
    })

    it('boundedEntries: exactly max entries are kept; max+1 is cut and counted; forbidden keys never take a slot', () => {
      const s = api.createStats()
      const obj = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['k' + i, i]))
      assert.equal(api.boundedEntries(obj(5), 5, s)?.length, 5)
      assert.equal(s.clampedFields, 0)
      assert.equal(api.boundedEntries(obj(4), 5, s)?.length, 4)
      assert.equal(api.boundedEntries(obj(6), 5, s)?.length, 5)
      assert.equal(s.clampedFields, 1)
      const poisoned = JSON.parse('{"__proto__":1,"constructor":2,"prototype":3,"a":1,"b":2,"c":3}')
      const s2 = api.createStats()
      assert.deepEqual(api.boundedEntries(poisoned, 3, s2)?.map(([k]) => k), ['a', 'b', 'c'])
      assert.equal(s2.clampedFields, 3, 'one per forbidden key, and the 3 valid ones fit exactly')
    })

    it(`keys: a key of ${NORM_KEY_MAX} chars is kept, ${NORM_KEY_MAX + 1} is dropped and counted once, a 1,000,000-char key never survives`, () => {
      const s = api.createStats()
      const keep = 'k'.repeat(NORM_KEY_MAX)
      const out = api.sanitizeValue({ [keep]: 1, ['k'.repeat(NORM_KEY_MAX + 1)]: 2, ['z'.repeat(1_000_000)]: 3, ok: 4 }, s) as Record<string, number>
      assert.deepEqual(Object.keys(out), [keep, 'ok'])
      assert.equal(s.clampedFields, 2, 'two dropped entries, each counted exactly once')
      const s2 = api.createStats()
      api.sanitizeValue({ [keep]: 1 }, s2)
      assert.equal(s2.clampedFields, 0)
    })

    it(`keys: ${NORM_MAX_KEYS} keys are all kept, ${NORM_MAX_KEYS + 1} lose the last one and count once`, () => {
      const obj = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['k' + i, i]))
      const s = api.createStats()
      assert.equal(Object.keys(api.sanitizeValue(obj(NORM_MAX_KEYS), s) as object).length, NORM_MAX_KEYS)
      assert.equal(s.clampedFields, 0)
      assert.equal(Object.keys(api.sanitizeValue(obj(NORM_MAX_KEYS + 1), s) as object).length, NORM_MAX_KEYS)
      assert.equal(s.clampedFields, 1)
    })

    it(`arrays: ${NORM_MAX_ARRAY} items are all kept, ${NORM_MAX_ARRAY + 1} lose the last one and count once`, () => {
      const s = api.createStats()
      assert.equal((api.sanitizeValue(new Array(NORM_MAX_ARRAY).fill(1), s) as unknown[]).length, NORM_MAX_ARRAY)
      assert.equal(s.clampedFields, 0)
      assert.equal((api.sanitizeValue(new Array(NORM_MAX_ARRAY + 1).fill(1), s) as unknown[]).length, NORM_MAX_ARRAY)
      assert.equal(s.clampedFields, 1)
    })

    it(`depth: ${NORM_MAX_DEPTH} nested object levels are kept, the ${NORM_MAX_DEPTH + 1}th is dropped and counted once`, () => {
      const chain = (n: number): Record<string, unknown> => (n <= 1 ? { v: 1 } : { a: chain(n - 1) })
      const s = api.createStats()
      const kept = api.sanitizeValue(chain(NORM_MAX_DEPTH), s)
      assert.equal(levels(kept), NORM_MAX_DEPTH)
      assert.deepEqual(JSON.parse(JSON.stringify(kept)), chain(NORM_MAX_DEPTH), 'nothing was lost at the limit')
      assert.equal(s.clampedFields, 0)
      const cut = api.sanitizeValue(chain(NORM_MAX_DEPTH + 1), s)
      assert.equal(levels(cut), NORM_MAX_DEPTH)
      assert.equal(s.clampedFields, 1)
      assert.equal(levels(api.sanitizeValue(chain(NORM_MAX_DEPTH + 30), api.createStats())), NORM_MAX_DEPTH)
    })

    it(`depth: arrays nest like objects (${NORM_MAX_DEPTH} levels kept, one more dropped and counted once)`, () => {
      const chain = (n: number): unknown => (n <= 1 ? [1] : [chain(n - 1)])
      const s = api.createStats()
      assert.equal(levels(api.sanitizeValue(chain(NORM_MAX_DEPTH), s)), NORM_MAX_DEPTH)
      assert.equal(s.clampedFields, 0)
      assert.equal(levels(api.sanitizeValue(chain(NORM_MAX_DEPTH + 1), s)), NORM_MAX_DEPTH)
      assert.equal(s.clampedFields, 1)
    })

    it(`lines: a line of exactly ${'NORM_MAX_LINE_CHARS'} chars is parsed, one char more is malformed`, () => {
      const s = api.createStats()
      const line = (total: number) => '{"a":"' + 'x'.repeat(total - 8) + '"}'
      assert.equal(line(NORM_MAX_LINE_CHARS).length, NORM_MAX_LINE_CHARS)
      assert.equal(typeof api.parseJsonLine(line(NORM_MAX_LINE_CHARS), s)?.a, 'string')
      assert.equal(typeof api.parseJsonLine(line(NORM_MAX_LINE_CHARS - 1), s)?.a, 'string')
      assert.equal(s.malformed, 0)
      assert.equal(api.parseJsonLine(line(NORM_MAX_LINE_CHARS + 1), s), undefined)
      assert.equal(s.malformed, 1)
    })
  })

  describe(`${label}: counters are exact`, () => {
    it('a NaN, Infinity or non-JSON value costs exactly one clamped field', () => {
      for (const bad of [NaN, Infinity, -Infinity, () => 1, Symbol('s'), BigInt(1)]) {
        const s = api.createStats()
        const out = api.sanitizeValue({ a: bad, ok: 1 }, s) as Record<string, unknown>
        assert.deepEqual(out, { ok: 1 }, String(bad))
        assert.equal(s.clampedFields, 1, String(bad))
      }
      const s = api.createStats()
      assert.deepEqual(api.sanitizeValue({ list: [NaN, 1, null, Infinity] }, s), { list: [1] })
      assert.equal(s.clampedFields, 2, 'two dropped array items; the null is not a loss')
    })

    it('null and undefined values are silent', () => {
      const s = api.createStats()
      assert.deepEqual(api.sanitizeValue({ a: null, b: undefined, c: [null, undefined] }, s), { c: [] })
      assert.equal(s.clampedFields, 0)
    })

    it('a negative timestamp is dropped and counted once; a string timestamp is kept as bounded text', () => {
      const s = api.createStats()
      assert.deepEqual(api.sanitizeValue({ joinedAt: -1, startTime: 5, lastActivityTime: 0 }, s), { startTime: 5, lastActivityTime: 0 })
      assert.equal(s.clampedFields, 1)
      const s2 = api.createStats()
      const iso = '2025-01-02T03:04:05.000Z'
      for (const key of ['joinedAt', 'startTime', 'lastActivityTime', 'timestamp']) {
        assert.deepEqual(api.sanitizeValue({ [key]: iso }, s2), { [key]: iso }, key)
      }
      assert.equal(s2.clampedFields, 0)
      const long = api.sanitizeValue({ timestamp: 't'.repeat(NORM_ID_MAX + 1) }, s2) as { timestamp: string }
      assert.equal(long.timestamp.length, NORM_ID_MAX)
      assert.equal(s2.clampedFields, 1)
    })

    it('a message_sent event keeps its string timestamp through the normalizer', () => {
      const n = new api.SessionNormalizer()
      const [e] = n.process({ time: 1, type: 'message_sent', payload: { from: 'a', to: 'b', content: 'hi', timestamp: '2025-01-02T03:04:05.000Z' } })
      assert.equal(e.payload.timestamp, '2025-01-02T03:04:05.000Z')
      assert.deepEqual(n.stats, api.createStats())
    })

    it('every key of a free-text payload goes through the same bounds as its value', () => {
      const n = new api.SessionNormalizer()
      const hugeKey = 'h'.repeat(1_000_000)
      const [e] = n.process({ time: 1, type: 'message', payload: { agent: 'a', [hugeKey]: 'x', nested: { [hugeKey]: 'y' } } })
      assert.ok(!JSON.stringify(e).includes('hhhh'))
      assert.equal(n.stats.clampedFields, 2)
    })
  })

  describe(`${label}: SessionNormalizer state bounds`, () => {
    it(`remembers ${NORM_MAX_SEEN_KEYS} tool_use ids: the oldest is forgotten only when the ${NORM_MAX_SEEN_KEYS + 1}th arrives`, () => {
      const n = new api.SessionNormalizer('s')
      for (let i = 0; i < NORM_MAX_SEEN_KEYS; i++) n.process(toolStart('orchestrator', 't' + i))
      assert.equal(only(n.process(toolStart('orchestrator', 't0')), 'tool_call_start').length, 0, 'still remembered at the limit')
      assert.equal(n.stats.duplicateEvents, 1)
      assert.equal(only(n.process(toolStart('orchestrator', 't' + NORM_MAX_SEEN_KEYS)), 'tool_call_start').length, 1)
      assert.equal(only(n.process(toolStart('orchestrator', 't1')), 'tool_call_start').length, 0, 'the second oldest is still there')
      assert.equal(only(n.process(toolStart('orchestrator', 't0')), 'tool_call_start').length, 1, 'the oldest was forgotten')
      assert.equal(n.stats.duplicateEvents, 2)
    })

    it(`remembers ${NORM_MAX_DROPPED_NAMES} dropped names: the oldest is forgotten only when the ${NORM_MAX_DROPPED_NAMES + 1}th is dropped`, () => {
      const n = new api.SessionNormalizer('s', { nodeCap: 0 })
      for (let i = 0; i < NORM_MAX_DROPPED_NAMES; i++) n.process(spawn('d' + i))
      assert.equal(n.stats.droppedByCap, NORM_MAX_DROPPED_NAMES)
      assert.equal(only(n.process(toolStart('d0', 'x0')), 'tool_call_start').length, 0, 'still ignored at the limit')
      n.process(spawn('d' + NORM_MAX_DROPPED_NAMES))
      assert.equal(n.stats.droppedByCap, NORM_MAX_DROPPED_NAMES + 1)
      assert.equal(only(n.process(toolStart('d1', 'x1')), 'tool_call_start').length, 0, 'the second oldest is still ignored')
      assert.equal(only(n.process(toolStart('d0', 'x2')), 'tool_call_start').length, 1, 'the oldest was forgotten')
    })

    it('remembers at most knownCap valid parents (the orchestrator counts): the last one that fits is a parent, the next is not', () => {
      const n = new api.SessionNormalizer('s', { knownCap: 4 })
      for (const a of ['a1', 'a2', 'a3', 'a4', 'a5']) n.noteAgent(a)
      assert.equal(only(n.process(spawn('k3', 'a3')), 'agent_spawn')[0].payload.parent, 'a3')
      const orphan = only(n.process(spawn('k4', 'a4')), 'agent_spawn')[0]
      assert.equal(orphan.payload.orphan, true)
      assert.equal('parent' in orphan.payload, false)
    })

    it(`the default known-agent bound is ${NORM_MAX_KNOWN_AGENTS}`, () => {
      const n = new api.SessionNormalizer('s')
      for (let i = 0; i < NORM_MAX_KNOWN_AGENTS + 5; i++) n.noteAgent('a' + i)
      const last = 'a' + (NORM_MAX_KNOWN_AGENTS - 2) // the orchestrator is the first of the NORM_MAX_KNOWN_AGENTS
      assert.equal(only(n.process(spawn('x1', last)), 'agent_spawn')[0].payload.parent, last)
      assert.equal(only(n.process(spawn('x2', 'a' + (NORM_MAX_KNOWN_AGENTS - 1))), 'agent_spawn')[0].payload.orphan, true)
    })

    it('an agent that acts becomes a valid parent, whichever field names it (agent, name, child)', () => {
      const n = new api.SessionNormalizer('s')
      n.process({ time: 1, type: 'tool_call_start', payload: { agent: 'w-agent', tool: 'Read', toolUseId: 'q1' } })
      n.process({ time: 1, type: 'agent_idle', payload: { name: 'w-name' } })
      n.process({ time: 1, type: 'subagent_return', payload: { child: 'w-child', parent: 'orchestrator', toolUseId: 'q2' } })
      for (const w of ['w-agent', 'w-name', 'w-child']) {
        assert.equal(only(n.process(spawn('kid-of-' + w, w)), 'agent_spawn')[0].payload.parent, w, w)
      }
      // an agent that never acted is not
      assert.equal(only(n.process(spawn('kid', 'nobody')), 'agent_spawn')[0].payload.orphan, true)
    })

    it('tool_call_start/end and subagent_dispatch/return are all deduplicated by (type, toolUseId)', () => {
      const n = new api.SessionNormalizer('s')
      const make = (type: string): Ev => ({ time: 1, type, payload: { agent: 'orchestrator', parent: 'orchestrator', child: 'c', tool: 'Read', toolUseId: 'same' } })
      for (const type of ['tool_call_start', 'tool_call_end', 'subagent_dispatch', 'subagent_return']) {
        assert.equal(only(n.process(make(type)), type).length, 1, `${type} first`)
        assert.equal(only(n.process(make(type)), type).length, 0, `${type} repeated`)
      }
      assert.equal(n.stats.duplicateEvents, 4)
      // other types are never deduplicated
      const idle: Ev = { time: 1, type: 'agent_idle', payload: { name: 'orchestrator', toolUseId: 'same' } }
      assert.equal(only(n.process(idle), 'agent_idle').length, 1)
      assert.equal(only(n.process(idle), 'agent_idle').length, 1)
      // an event without a toolUseId is never a duplicate
      const bare: Ev = { time: 1, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read' } }
      assert.equal(only(n.process(bare), 'tool_call_start').length, 1)
      assert.equal(only(n.process(bare), 'tool_call_start').length, 1)
    })

    it('noteMalformed counts 1 by default or n, and a non-array batch is one malformed input', () => {
      const n = new api.SessionNormalizer('s')
      n.noteMalformed()
      assert.equal(n.stats.malformed, 1)
      n.noteMalformed(3)
      assert.equal(n.stats.malformed, 4)
      const out = n.processBatch({ not: 'an array' })
      assert.equal(n.stats.malformed, 5)
      assert.equal(only(out, 'normalization_stats').length, 1, 'the new total is reported')
      assert.equal(out.length, 1)
    })
  })

  describe(`${label}: shared counters (one counter object per session)`, () => {
    it('two normalizers of one session share their counters and publish the merged totals', () => {
      const counters = new api.SessionCounters()
      let now = 5000
      const a = new api.SessionNormalizer('s', { counters, now: () => now })
      const b = new api.SessionNormalizer('s', { counters, now: () => now })
      assert.equal(a.stats, b.stats)
      assert.equal(a.stats, counters.stats)
      const fromA = a.process({ type: 'unknown_a', payload: {} })
      assert.equal(only(fromA, 'normalization_stats')[0].payload.ignoredEvents, 1)
      b.noteMalformed(2)
      // the throttle is shared: B may not publish within the interval of A's publication
      assert.deepEqual(b.process({ time: 1, type: 'agent_idle', payload: { name: 'orchestrator' } }).filter(e => e.type === 'normalization_stats'), [])
      now += NORM_STATS_MIN_INTERVAL_MS
      const merged = b.flush()
      assert.deepEqual(merged?.payload, { ...api.createStats(), ignoredEvents: 1, malformed: 2 })
      assert.equal(a.flush(), null, 'already published by the other normalizer')
    })

    it('normalizers without shared counters stay independent', () => {
      const a = new api.SessionNormalizer('s')
      const b = new api.SessionNormalizer('s')
      a.noteMalformed()
      assert.equal(b.stats.malformed, 0)
    })

    it('the registry gives one counter object per session and forgets the least recently used past its bound', () => {
      const reg = new api.CountersRegistry(2)
      const a = reg.get('a')
      assert.equal(reg.get('a'), a)
      reg.get('b')
      reg.get('a') // touch: b is now the oldest
      reg.get('c')
      assert.equal(reg.has('a'), true)
      assert.equal(reg.has('b'), false)
      assert.equal(reg.has('c'), true)
      assert.equal(reg.size, 2)
      reg.delete('a')
      assert.equal(reg.has('a'), false)
      assert.equal(reg.size, 1)
    })

    it(`the default registry tracks ${NORM_MAX_TRACKED_SESSIONS} sessions`, () => {
      const reg = new api.CountersRegistry()
      for (let i = 0; i < NORM_MAX_TRACKED_SESSIONS; i++) reg.get('s' + i)
      assert.equal(reg.size, NORM_MAX_TRACKED_SESSIONS)
      assert.equal(reg.has('s0'), true)
      reg.get('s' + NORM_MAX_TRACKED_SESSIONS)
      assert.equal(reg.size, NORM_MAX_TRACKED_SESSIONS)
      assert.equal(reg.has('s0'), false)
      assert.equal(reg.has('s1'), true)
    })
  })

  describe(`${label}: trailing stats flush`, () => {
    it('a change held back by the throttle is published once the interval has passed, not before', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        const published: Ev[] = []
        const now = 1000
        const n = new api.SessionNormalizer('s', { now: () => now, onTrailing: e => published.push(e) })
        assert.equal(only(n.process({ type: 'unknown_a', payload: {} }), 'normalization_stats').length, 1)
        n.noteMalformed()
        n.noteMalformed() // coalesced into the same timer
        mock.timers.tick(NORM_STATS_MIN_INTERVAL_MS - 1)
        assert.equal(published.length, 0, 'not before the interval')
        mock.timers.tick(1)
        assert.equal(published.length, 1)
        assert.equal(published[0].payload.malformed, 2)
        assert.equal(published[0].sessionId, 's')
        mock.timers.tick(10 * NORM_STATS_MIN_INTERVAL_MS)
        assert.equal(published.length, 1, 'nothing changed since: nothing more to say')
      } finally { mock.timers.reset() }
    })

    it('with no change since the last publication no timer is armed', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        const published: Ev[] = []
        const n = new api.SessionNormalizer('s', { now: () => 1000, onTrailing: e => published.push(e) })
        n.process({ time: 1, type: 'agent_idle', payload: { name: 'orchestrator' } })
        mock.timers.tick(10 * NORM_STATS_MIN_INTERVAL_MS)
        assert.equal(published.length, 0)
      } finally { mock.timers.reset() }
    })

    it('a normalizer without onTrailing never arms a timer; its counters ride on the next event', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        const n = new api.SessionNormalizer('s', { now: () => 1000 })
        n.noteMalformed()
        mock.timers.tick(10 * NORM_STATS_MIN_INTERVAL_MS)
        assert.equal(n.flush()?.payload.malformed, 1, 'still unpublished')
      } finally { mock.timers.reset() }
    })

    it('dispose cancels the pending flush (and may be called twice)', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        const published: Ev[] = []
        const n = new api.SessionNormalizer('s', { now: () => 1000, onTrailing: e => published.push(e) })
        n.noteMalformed()
        n.dispose()
        n.dispose()
        mock.timers.tick(10 * NORM_STATS_MIN_INTERVAL_MS)
        assert.equal(published.length, 0)
      } finally { mock.timers.reset() }
    })
  })

  describe(`${label}: parsing, shapes and event envelope`, () => {
    it('boundedEntries only accepts plain objects', () => {
      for (const bad of [[1, 2], null, undefined, 'str', 5, true]) assert.equal(api.boundedEntries(bad, 10), undefined, String(bad))
      assert.deepEqual(api.boundedEntries({ a: 1 }, 10), [['a', 1]])
    })

    it('sanitizeValue keeps booleans as they are', () => {
      assert.deepEqual(api.sanitizeValue({ t: true, f: false }), { t: true, f: false })
    })

    it('parseJsonLine: blank lines are silent; non-strings, bad JSON and non-objects are each one malformed', () => {
      const s = api.createStats()
      assert.equal(api.parseJsonLine('', s), undefined)
      assert.equal(api.parseJsonLine('   \t ', s), undefined)
      assert.equal(s.malformed, 0)
      assert.equal(api.parseJsonLine(42, s), undefined)
      assert.equal(s.malformed, 1)
      assert.equal(api.parseJsonLine(undefined, s), undefined)
      assert.equal(s.malformed, 2)
      assert.equal(api.parseJsonLine('{', s), undefined)
      assert.equal(s.malformed, 3)
      for (const nonObject of ['[]', '[1]', '7', '"s"', 'null', 'true']) {
        const before: number = s.malformed
        assert.equal(api.parseJsonLine(nonObject, s), undefined, nonObject)
        assert.equal(s.malformed, before + 1, nonObject)
      }
      assert.deepEqual(api.parseJsonLine('  {"a":[1]}  ', s), { a: [1] })
    })

    it('the events of a node dropped by a cap are ignored and counted, one each', () => {
      const n = new api.SessionNormalizer('s', { nodeCap: 1 })
      n.process(spawn('kept'))
      n.process(spawn('lost'))
      assert.equal(n.stats.droppedByCap, 1)
      assert.equal(only(n.process(toolStart('lost', 'x1')), 'tool_call_start').length, 0)
      assert.equal(n.stats.ignoredEvents, 1)
      assert.equal(only(n.process(spawn('lost')), 'agent_spawn').length, 0, 'a second spawn of the dropped name too')
      assert.equal(n.stats.ignoredEvents, 2)
      assert.equal(n.stats.droppedByCap, 1)
      assert.equal(only(n.process(toolStart('kept', 'x2')), 'tool_call_start').length, 1)
    })

    it('a producer cannot forge the stats event: it is ignored and counted', () => {
      const n = new api.SessionNormalizer('s', { now: () => 1000 })
      const out = n.process({ time: 0, type: 'normalization_stats', payload: { ignoredEvents: 99 } })
      assert.equal(n.stats.ignoredEvents, 1)
      assert.deepEqual(only(out, 'normalization_stats').map(e => e.payload.ignoredEvents), [1], 'only the genuine one')
    })

    it('time: a missing time is 0 and free; NaN, Infinity or a string time is 0 and counted once; out of range is clamped and counted once', () => {
      const n = new api.SessionNormalizer('s')
      const time = (t: unknown) => n.process({ time: t, type: 'agent_idle', payload: { name: 'orchestrator' } }).find(e => e.type === 'agent_idle')!.time
      let c = n.stats.clampedFields
      assert.equal(time(undefined), 0)
      assert.equal(n.stats.clampedFields, c)
      for (const bad of [NaN, Infinity, '5']) { c = n.stats.clampedFields; assert.equal(time(bad), 0, String(bad)); assert.equal(n.stats.clampedFields, c + 1, String(bad)) }
      c = n.stats.clampedFields; assert.equal(time(-1), 0); assert.equal(n.stats.clampedFields, c + 1)
      c = n.stats.clampedFields; assert.equal(time(caps.NORM_EVENT_TIME_MAX_S), caps.NORM_EVENT_TIME_MAX_S); assert.equal(n.stats.clampedFields, c)
      c = n.stats.clampedFields; assert.equal(time(caps.NORM_EVENT_TIME_MAX_S + 1), caps.NORM_EVENT_TIME_MAX_S); assert.equal(n.stats.clampedFields, c + 1)
      c = n.stats.clampedFields; assert.equal(time(0), 0); assert.equal(n.stats.clampedFields, c)
    })

    it('the session id of an event is bounded like any identifier', () => {
      const n = new api.SessionNormalizer()
      const ev = (sessionId: unknown): Ev => ({ time: 1, type: 'agent_idle', sessionId, payload: { name: 'orchestrator' } } as Ev)
      const id = (e: Ev) => n.process(e).find(x => x.type === 'agent_idle')!.sessionId
      assert.equal(id(ev('abc')), 'abc')
      assert.equal(n.stats.clampedFields, 0)
      assert.equal(id(ev('a\u0000b')), 'ab')
      assert.equal(n.stats.clampedFields, 1)
      assert.equal(id(ev('s'.repeat(NORM_ID_MAX + 1)))?.length, NORM_ID_MAX)
      assert.equal(n.stats.clampedFields, 2)
      assert.equal('sessionId' in n.process(ev(5)).find(x => x.type === 'agent_idle')!, false)
      assert.equal('sessionId' in n.process(ev('')).find(x => x.type === 'agent_idle')!, false)
    })

    it('a published stats event is a snapshot: later counting does not alter it', () => {
      const n = new api.SessionNormalizer('s', { now: () => 1000 })
      const [published] = only(n.process({ type: 'unknown_a', payload: {} }), 'normalization_stats')
      n.noteMalformed(5)
      assert.deepEqual(published.payload, { ...api.createStats(), ignoredEvents: 1 })
    })
  })

  describe(`${label}: trailing flush details`, () => {
    it('an unparseable line arms the flush too (no event carries its count)', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        const published: Ev[] = []
        const n = new api.SessionNormalizer('s', { now: () => 1000, onTrailing: e => published.push(e) })
        assert.equal(n.parseLine('not json'), undefined)
        mock.timers.tick(NORM_STATS_MIN_INTERVAL_MS)
        assert.equal(published.length, 1)
        assert.equal(published[0].payload.malformed, 1)
        // a good line does not arm anything
        n.parseLine('{"a":1}')
        mock.timers.tick(NORM_STATS_MIN_INTERVAL_MS)
        assert.equal(published.length, 1)
      } finally { mock.timers.reset() }
    })

    it('after a flush fired, the next change arms a new one', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        const published: Ev[] = []
        const n = new api.SessionNormalizer('s', { now: () => 1000, onTrailing: e => published.push(e) })
        n.noteMalformed()
        mock.timers.tick(NORM_STATS_MIN_INTERVAL_MS)
        n.noteMalformed()
        mock.timers.tick(NORM_STATS_MIN_INTERVAL_MS)
        assert.deepEqual(published.map(e => e.payload.malformed), [1, 2])
      } finally { mock.timers.reset() }
    })

    it('one pending flush at a time: no timer is armed while one is pending, nor when nothing changed', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        const armed = mock.method(globalThis, 'setTimeout')
        const n = new api.SessionNormalizer('s', { now: () => 1000, onTrailing: () => {} })
        n.process({ time: 1, type: 'agent_idle', payload: { name: 'orchestrator' } })
        assert.equal(armed.mock.callCount(), 0, 'nothing changed: no timer')
        n.noteMalformed()
        n.noteMalformed()
        n.process({ type: 'unknown_a', payload: {} })
        assert.equal(armed.mock.callCount(), 1, 'one timer for any number of changes')
        armed.mock.restore()
      } finally { mock.timers.reset() }
    })

    it('dispose cancels the one pending flush even after several changes', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        const published: Ev[] = []
        const n = new api.SessionNormalizer('s', { now: () => 1000, onTrailing: e => published.push(e) })
        n.noteMalformed()
        n.noteMalformed()
        n.dispose()
        mock.timers.tick(10 * NORM_STATS_MIN_INTERVAL_MS)
        assert.equal(published.length, 0)
      } finally { mock.timers.reset() }
    })

    it('the throttle: held back strictly inside the interval, published exactly at it', () => {
      let now = 1000
      const n = new api.SessionNormalizer('s', { now: () => now })
      assert.equal(only(n.process({ type: 'unknown_a', payload: {} }), 'normalization_stats').length, 1)
      now = 1000 + NORM_STATS_MIN_INTERVAL_MS - 1
      assert.equal(only(n.process({ type: 'unknown_b', payload: {} }), 'normalization_stats').length, 0)
      now = 1000 + NORM_STATS_MIN_INTERVAL_MS
      const out = only(n.process({ type: 'unknown_c', payload: {} }), 'normalization_stats')
      assert.equal(out.length, 1)
      assert.equal(out[0].payload.ignoredEvents, 3)
    })
  })
}
