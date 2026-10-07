// Web-side input normalization (#51): the bridge mirror of extension/src/event-normalize.ts.
// Events arriving from the extension or a relay are untrusted: the UI must stay defensive even
// when the producer is not.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import * as web from '../web/lib/event-normalize'
import * as ext from '../extension/src/event-normalize'
import * as extConst from '../extension/src/constants'

const spawn = (name: string, parent?: string) => ({ time: 1, type: 'agent_spawn', payload: { name, ...(parent ? { parent } : {}), task: 't' } })

test('the web caps and the event type list are identical to the extension ones (no silent drift)', () => {
  const names = Object.keys(web).filter(k => k.startsWith('NORM_'))
  assert.ok(names.length >= 15, 'every cap is exported')
  for (const k of names) {
    assert.equal((web as Record<string, unknown>)[k], (extConst as Record<string, unknown>)[k], k)
  }
  assert.deepEqual([...web.AGENT_EVENT_TYPES], [...ext.AGENT_EVENT_TYPES])
  assert.deepEqual([...web.FORBIDDEN_KEYS], [...ext.FORBIDDEN_KEYS])
})

test('the web logic is a verbatim mirror of the extension logic (same code from AGENT_EVENT_TYPES to the end of the class)', () => {
  const body = (file: string) => {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8')
    const from = src.indexOf('/** Every event type')
    const to = src.indexOf('function stringOf')
    assert.ok(from > 0 && to > from, `${file}: markers found`)
    return src.slice(from, to).replace('readonly AgentEventType[]', 'readonly string[]')
  }
  assert.equal(body('../web/lib/event-normalize.ts'), body('../extension/src/event-normalize.ts'))
})

test('malformed corpus through the bridge normalizer: nothing throws, counters are exact', () => {
  const n = new web.SessionNormalizer('s1')
  const hostile = JSON.parse('{"time":-5,"type":"message","payload":{"__proto__":{"polluted":true},"constructor":{"x":1},"content":"a\\u0000b","n":1e999}}')
  const corpus: unknown[] = [
    null, undefined, 5, 'str', [], true,                     // 6 malformed
    { payload: {} }, { type: 12, payload: {} },               // 2 malformed
    { type: 'message' }, { type: 'message', payload: null },  // 2 malformed
    { type: 'message', payload: [1] },                        // 1 malformed
    { type: 'totally_new', payload: {} },                     // 1 ignored
    hostile,                                                  // clean, with clamps
  ]
  let out: ReturnType<typeof n.process> = []
  for (const raw of corpus) assert.doesNotThrow(() => { out = out.concat(n.process(raw)) })
  assert.equal(n.stats.malformed, 11)
  assert.equal(n.stats.ignoredEvents, 1)
  const msg = out.find(e => e.type === 'message')
  assert.ok(msg)
  assert.equal(msg.time, 0)
  assert.equal(msg.payload.content, 'ab')
  assert.deepEqual(Object.keys(msg.payload).sort(), ['content'])
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.ok(n.stats.clampedFields >= 4)
})

test('far-future and negative timestamps, huge strings and nested garbage are clamped', () => {
  const n = new web.SessionNormalizer()
  let deep: Record<string, unknown> = { v: 1 }
  for (let i = 0; i < 50; i++) deep = { d: deep }
  const [ev] = n.process({
    time: 9e18, type: 'team_info',
    payload: { teamName: 'T'.repeat(10_000), members: new Array(1000).fill({ name: 'm', joinedAt: 9e18 }), deep, other: { joinedAt: -1 } },
  })
  assert.equal(ev.time, web.NORM_EVENT_TIME_MAX_S)
  assert.equal((ev.payload.teamName as string).length, web.NORM_ID_MAX)
  const members = ev.payload.members as Array<{ joinedAt: number }>
  assert.equal(members.length, web.NORM_MAX_ARRAY)
  assert.equal(members[0].joinedAt, web.NORM_TS_MAX_MS)
  assert.equal('joinedAt' in (ev.payload.other as object), false, 'a negative timestamp is dropped, not shown as 1970')
  let depth = 0
  for (let d = ev.payload.deep as Record<string, unknown> | undefined; d; d = d.d as Record<string, unknown> | undefined) depth++
  assert.ok(depth <= web.NORM_MAX_DEPTH)
})

test('10k children of one agent: the cap holds and what was dropped is counted', () => {
  const n = new web.SessionNormalizer()
  let kept = 0
  for (let i = 0; i < 10_000; i++) kept += n.process(spawn('c' + i, 'orchestrator')).filter(e => e.type === 'agent_spawn').length
  assert.equal(kept, web.NORM_MAX_CHILDREN_PER_AGENT)
  assert.equal(n.stats.droppedByCap, 10_000 - web.NORM_MAX_CHILDREN_PER_AGENT)
})

test('a spawn with an unknown parent is a detached orphan, never re-parented', () => {
  const n = new web.SessionNormalizer()
  const [e] = n.process(spawn('lost', 'nobody'))
  assert.equal(e.payload.orphan, true)
  assert.equal('parent' in e.payload, false)
})

test('batches are capped and repeats of a tool call are dropped', () => {
  const n = new web.SessionNormalizer()
  const call = { time: 1, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read', toolUseId: 'x' } }
  const out = n.processBatch([call, call, ...Array.from({ length: web.NORM_MAX_EVENTS_PER_BATCH + 4 }, () => ({ time: 1, type: 'agent_idle', payload: { name: 'orchestrator' } }))])
  assert.equal(out.filter(e => e.type === 'tool_call_start').length, 1)
  assert.equal(n.stats.duplicateEvents, 1)
  assert.equal(n.stats.ignoredEvents, 6)
})

test('parseNormalizationStats never invents a number: bad counters read as 0', () => {
  assert.deepEqual(web.parseNormalizationStats(null), web.createStats())
  assert.deepEqual(web.parseNormalizationStats([1, 2]), web.createStats())
  const parsed = web.parseNormalizationStats({ ignoredEvents: 3.9, malformed: -2, droppedByCap: NaN, clampedFields: '7', duplicateEvents: Infinity, extra: 5 })
  assert.deepEqual(parsed, { ignoredEvents: 3, clampedFields: 0, droppedByCap: 0, malformed: 0, duplicateEvents: 0 })
  assert.equal(web.parseNormalizationStats({ ignoredEvents: 1e300 }).ignoredEvents, web.NORM_NUM_MAX)
})

test('banner rules: duplicates and clamping alone never claim the graph is truncated; dismissal is per total', () => {
  const s = web.createStats()
  assert.equal(web.shouldShowTruncationBanner(s, undefined), false)
  assert.equal(web.shouldShowTruncationBanner({ ...s, duplicateEvents: 50, clampedFields: 50 }, undefined), false)
  const cut = { ...s, ignoredEvents: 2, malformed: 1, droppedByCap: 4 }
  assert.deepEqual(web.truncationHeadline(cut), { events: 3, nodes: 4 })
  assert.equal(web.truncationTotal(cut), 7)
  assert.equal(web.shouldShowTruncationBanner(cut, undefined), true)
  assert.equal(web.shouldShowTruncationBanner(cut, 7), false, 'dismissed at this total')
  assert.equal(web.shouldShowTruncationBanner({ ...cut, droppedByCap: 5 }, 7), true, 'comes back when more is dropped')
})

// The same behaviour suite as the extension's, run against the web copy: a bug that only the mirror
// has cannot hide behind the source comparison above.
import { normalizeSuite, type NormalizeApi } from '../extension/test/helpers/normalize-suite'
normalizeSuite('web mirror', {
  ...(web as unknown as NormalizeApi),
  caps: Object.fromEntries(Object.entries(web).filter(([k]) => k.startsWith('NORM_'))) as Record<string, number>,
})
