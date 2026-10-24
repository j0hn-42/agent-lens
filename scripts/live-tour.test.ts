import './all-locales' // #662: the tables are loaded on demand, every one is loaded before the tests
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildLiveTourSteps, LIVE_ENTRY_TEXT } from '../web/lib/live-tour'
import { deriveLegendPresence, type LegendPresence } from '../web/lib/legend-presence'
import { LEGEND_ENTRIES, LEGEND_ENTRY_IDS, type LegendEntryId } from '../web/lib/legend-entries'

const presence = (entries: LegendEntryId[], agentFor: LegendPresence['agentFor'] = {}, labels: LegendPresence['labels'] = {}): LegendPresence => ({ entries, agentFor, labels })
const sectionOf = (id: LegendEntryId) => Object.entries(LEGEND_ENTRIES).find(([, ids]) => (ids as readonly string[]).includes(id))![0]

test('every legend entry has a sentence, and no sentence is empty', () => {
  for (const id of LEGEND_ENTRY_IDS) assert.ok(LIVE_ENTRY_TEXT[id]?.trim(), `text for ${id}`)
})

test('nothing on screen gives no step (never a generic tour of absent things)', () => {
  assert.deepEqual(buildLiveTourSteps(presence([])), [])
})

test('a step only covers entries that are on screen, and every present entry is explained exactly once', () => {
  const p = presence(['shape-main', 'rt-codex', 'state-error', 'link-recent'], { 'shape-main': 'k:m', 'state-error': 'k:m' }, { 'k:m': 'lead' })
  const steps = buildLiveTourSteps(p)
  for (const s of steps) {
    assert.ok(s.covers.length > 0, s.id)
    for (const c of s.covers) assert.ok(p.entries.includes(c), `${s.id} covers absent ${c}`)
  }
  assert.deepEqual(steps.flatMap(s => s.covers).sort(), [...p.entries].sort())
})

test('a realistic scene is explained in full, from its own derived presence', () => {
  const zero = { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 }
  const p = deriveLegendPresence({
    agents: [
      { id: 'k:a', name: 'a', state: 'thinking', isMain: true, contextBreakdown: { ...zero, systemPrompt: 1, userMessages: 1 } },
      { id: 'k:b', name: 'b', state: 'error', isMain: false, contextBreakdown: zero },
    ],
    toolCallCount: 1, discoveryTypes: ['file'], edges: [{ type: 'parent-child', verified: true }], particleTypes: [],
    links: [{ state: 'recent', messageCount: 2 }], bubbleCount: 1, fileConflictCount: 1, branches: [], teamCount: 0, sessionHaloCount: 0,
  })
  assert.deepEqual(buildLiveTourSteps(p).flatMap(s => s.covers).sort(), [...p.entries].sort())
})

test('the text of a step says nothing about an entry that is not on screen', () => {
  const text = buildLiveTourSteps(presence(['shape-main'])).map(s => `${s.title} ${s.body}`).join(' ')
  assert.ok(!/sub-agent|teammate|codex|conflict|discover|message/i.test(text), text)
})

test('an agent step targets the real agent that shows the entry and names it', () => {
  const steps = buildLiveTourSteps(presence(['state-error'], { 'state-error': 'sess:tests' }, { 'sess:tests': 'run the tests' }))
  const step = steps.find(s => s.covers.includes('state-error'))!
  assert.deepEqual(step.target, { kind: 'agent-key', key: 'sess:tests' })
  assert.match(step.body, /run the tests/)
  assert.ok(!step.opensLegend, 'the ring is on the canvas, the legend stays as it is')
})

test('an entry without an agent targets its legend section and opens the legend', () => {
  const step = buildLiveTourSteps(presence(['link-flight'])).find(s => s.covers.includes('link-flight'))!
  assert.deepEqual(step.target, { kind: 'dom', id: 'legend-links' })
  assert.equal(step.opensLegend, true)
})

test('a DOM target is always the legend section of the entries the step covers', () => {
  for (const id of LEGEND_ENTRY_IDS) {
    if (id === 'team-row') continue
    const step = buildLiveTourSteps(presence([id])).find(s => s.covers.includes(id))
    assert.ok(step, `${id} is explained`)
    if (step!.target.kind === 'dom') assert.equal(step!.target.id, `legend-${sectionOf(id)}`, id)
  }
})

test('step ids are unique and stable, titles and bodies are never empty', () => {
  const all = presence([...LEGEND_ENTRY_IDS])
  const a = buildLiveTourSteps(all)
  assert.deepEqual(a.map(s => s.id), buildLiveTourSteps(all).map(s => s.id))
  assert.equal(new Set(a.map(s => s.id)).size, a.length)
  for (const s of a) assert.ok(s.title.trim() && s.body.trim(), s.id)
})

test('an untrusted agent label is cut and cleaned before it enters a sentence', () => {
  const long = 'x'.repeat(200) + '\u0007\n'
  const body = buildLiveTourSteps(presence(['state-error'], { 'state-error': 'k' }, { k: long })).find(s => s.covers.includes('state-error'))!.body
  assert.ok(body.length < 400)
  assert.ok(!/[\u0000-\u001f]/.test(body))
})

test('a tour of a live session has no scenario time: it never seeks nor pauses the scene', () => {
  for (const s of buildLiveTourSteps(presence([...LEGEND_ENTRY_IDS]))) assert.ok(!('time' in s), `${s.id} has no scenario time`)
})

test('with every entry on screen, each one is explained exactly once', () => {
  const covered = buildLiveTourSteps(presence([...LEGEND_ENTRY_IDS])).flatMap(s => s.covers)
  assert.deepEqual([...covered].sort(), [...LEGEND_ENTRY_IDS].sort())
})
