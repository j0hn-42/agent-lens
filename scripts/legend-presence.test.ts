import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { deriveLegendPresence, holdPresence, EMPTY_PRESENCE, LEGEND_HOLD_MS, type LegendPresenceInput } from '../web/lib/legend-presence'
import { LEGEND_ENTRY_IDS, type LegendEntryId } from '../web/lib/legend-entries'

const noBreakdown = { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 }
type A = LegendPresenceInput['agents'] extends Iterable<infer T> ? T : never
const agent = (over: Partial<A> & { id: string }): A => ({
  name: over.id, state: 'idle', isMain: false, contextBreakdown: noBreakdown, ...over,
}) as A

const empty: LegendPresenceInput = {
  agents: [], toolCallCount: 0, discoveryTypes: [], edges: [], particleTypes: [], links: [], bubbleCount: 0,
  fileConflictCount: 0, branches: [], teamCount: 0, sessionHaloCount: 0,
}
const derive = (over: Partial<LegendPresenceInput>) => deriveLegendPresence({ ...empty, ...over })
const has = (p: { entries: readonly LegendEntryId[] }, id: LegendEntryId) => p.entries.includes(id)

test('an empty scene proves no legend entry', () => {
  assert.deepEqual(derive({}).entries, [])
  assert.deepEqual(EMPTY_PRESENCE.entries, [])
})

test('a lone main agent proves the main shape, its state, its runtime and the orchestrator crown, and nothing else', () => {
  const p = derive({ agents: [agent({ id: 'k:main', isMain: true, state: 'thinking' })] })
  assert.deepEqual([...p.entries].sort(), ['orchestrator', 'rt-claude', 'shape-main', 'state-thinking'])
})

test('runtime defaults to Claude only when the agent does not say otherwise', () => {
  const p = derive({ agents: [agent({ id: 'k:a', isMain: true, runtime: 'codex' }), agent({ id: 'k:b', runtime: 'copilot' })] })
  assert.ok(has(p, 'rt-codex') && has(p, 'rt-copilot'))
  assert.ok(!has(p, 'rt-claude'), 'no Claude agent on screen')
})

test('a Pi agent proves the Pi entry, never the Claude one (#238)', () => {
  const p = derive({ agents: [agent({ id: 'k:p', isMain: true, runtime: 'pi' })] })
  assert.ok(has(p, 'rt-pi'))
  assert.ok(!has(p, 'rt-claude'))
})

test('a Gemini agent proves the Gemini entry, never the Claude one (#238)', () => {
  const p = derive({ agents: [agent({ id: 'k:g', isMain: true, runtime: 'gemini' })] })
  assert.ok(has(p, 'rt-gemini'))
  assert.ok(!has(p, 'rt-claude'))
})

test('every agent state maps to its own entry', () => {
  for (const state of ['idle', 'thinking', 'tool_calling', 'waiting_permission', 'error', 'paused', 'complete'] as const) {
    const p = derive({ agents: [agent({ id: 'k:a', state })] })
    assert.ok(has(p, `state-${state}` as LegendEntryId), state)
    assert.equal(p.entries.filter(e => e.startsWith('state-')).length, 1, `only ${state}`)
  }
})

test('shapes: sub-agent, complete outline and archived agent', () => {
  const p = derive({ agents: [agent({ id: 'k:s', state: 'complete', archived: true })] })
  assert.ok(has(p, 'shape-sub') && has(p, 'shape-complete') && has(p, 'team-archived'))
  assert.ok(!has(p, 'shape-main') && !has(p, 'orchestrator'))
})

test('teammates prove the team ring and their activity, a lead its orchestrator crown', () => {
  const p = derive({
    teamCount: 1,
    agents: [
      agent({ id: 'k:lead', isMain: true, kind: 'main' }),
      agent({ id: 'k:w', kind: 'teammate', activity: 'working' }),
      agent({ id: 'k:i', kind: 'teammate', activity: 'idle' }),
      agent({ id: 'k:d', kind: 'teammate', activity: 'done' }),
    ],
  })
  for (const id of ['team-ring', 'team-working', 'team-idle', 'team-done', 'team-halo', 'team-row', 'orchestrator'] as const) assert.ok(has(p, id), id)
})

test('a teammate with no activity falls back on its state, like the canvas', () => {
  const p = derive({ agents: [agent({ id: 'k:t', kind: 'teammate', state: 'complete' })] })
  assert.ok(has(p, 'team-done') && !has(p, 'team-working'))
})

test('without a team on screen there is no halo and no team row', () => {
  const p = derive({ teamCount: 0, agents: [agent({ id: 'k:a', isMain: true })] })
  assert.ok(!has(p, 'team-halo') && !has(p, 'team-row') && !has(p, 'team-ring'))
})

test('tool cards, discoveries by type', () => {
  assert.ok(!has(derive({}), 'shape-tool'))
  const p = derive({ toolCallCount: 2, discoveryTypes: ['file', 'code', 'file'] })
  assert.ok(has(p, 'shape-tool') && has(p, 'edge-tool') && has(p, 'shape-discovery') && has(p, 'disc-file') && has(p, 'disc-code'))
  assert.ok(!has(p, 'disc-pattern') && !has(p, 'disc-finding'))
  assert.ok(!has(derive({ discoveryTypes: ['unknown-type'] }), 'shape-discovery'), 'an unknown type proves nothing')
})

test('parent edges: verified and unverified are told apart', () => {
  assert.ok(has(derive({ edges: [{ type: 'parent-child', verified: true }] }), 'edge-parent'))
  const unverified = derive({ edges: [{ type: 'parent-child', verified: false }] })
  assert.ok(has(unverified, 'edge-unverified') && !has(unverified, 'edge-parent'))
  assert.ok(has(derive({ edges: [{ type: 'parent-child' }] }), 'edge-parent'), 'no flag: the canvas draws it solid')
  assert.ok(!has(derive({ edges: [{ type: 'tool', verified: undefined }] }), 'edge-parent'))
})

test('particles, file conflicts, folded branches and the session halo', () => {
  const p = derive({
    particleTypes: ['dispatch', 'return', 'tool_call'], fileConflictCount: 1, sessionHaloCount: 2,
    branches: [{ collapsed: true, active: 0, descendants: 3 }, { collapsed: true, active: 2, descendants: 4 }],
  })
  for (const id of ['particle-dispatch', 'particle-return', 'edge-file-conflict', 'edge-badge-hidden', 'edge-badge-active', 'session-halo'] as const) assert.ok(has(p, id), id)
  const open = derive({ branches: [{ collapsed: false, active: 1, descendants: 2 }] })
  assert.ok(!has(open, 'edge-badge-hidden') && !has(open, 'edge-badge-active'), 'an unfolded branch has no badge')
})

test('links: one entry per state, only for links that carry a message', () => {
  const p = derive({
    links: [{ state: 'in_flight', messageCount: 1 }, { state: 'recent', messageCount: 2 }, { state: 'error', messageCount: 1 }, { state: 'idle', messageCount: 5 }],
    bubbleCount: 1,
  })
  for (const id of ['link-flight', 'link-recent', 'link-error', 'link-quiet', 'link-bubble'] as const) assert.ok(has(p, id), id)
  assert.ok(!has(derive({ links: [{ state: 'idle', messageCount: 0 }] }), 'link-quiet'), 'a link without message is not a quiet link')
  assert.ok(!has(derive({ links: [{ state: 'recent', messageCount: 1 }] }), 'link-bubble'), 'no bubble without a bubble')
})

test('context segments appear only for a non-zero part of a visible agent', () => {
  const p = derive({ agents: [agent({ id: 'k:a', isMain: true, contextBreakdown: { ...noBreakdown, systemPrompt: 10, toolResults: 5 } })] })
  assert.ok(has(p, 'ctx-system') && has(p, 'ctx-tool-results'))
  assert.ok(!has(p, 'ctx-user') && !has(p, 'ctx-reasoning') && !has(p, 'ctx-subagent'))
})

test('the entries come in legend order, without duplicates, and are all known', () => {
  const p = derive({ toolCallCount: 1, agents: [agent({ id: 'k:a', isMain: true, state: 'error' }), agent({ id: 'k:b', isMain: true, state: 'error' })] })
  const order = p.entries.map(e => LEGEND_ENTRY_IDS.indexOf(e))
  assert.ok(order.every(i => i >= 0))
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  assert.equal(new Set(p.entries).size, p.entries.length)
})

test('agentFor names the first agent that shows an entry, with its label', () => {
  const p = derive({ agents: [agent({ id: 'k:a', name: 'alpha', state: 'idle' }), agent({ id: 'k:b', name: 'beta', state: 'error' }), agent({ id: 'k:c', name: 'gamma', state: 'error' })] })
  assert.equal(p.agentFor['state-error'], 'k:b')
  assert.equal(p.labels['k:b'], 'beta')
  assert.equal(p.agentFor['shape-tool'], undefined)
  assert.equal(p.labels['k:c'], undefined, 'labels only for agents that serve as an example')
})

test('holdPresence keeps a row for the hold time after its symbol left, never longer', () => {
  const t0 = 1_000_000
  let seen = holdPresence(new Map(), ['shape-main', 'link-flight'], t0, LEGEND_HOLD_MS)
  assert.deepEqual(seen.shown, ['shape-main', 'link-flight'])
  seen = holdPresence(seen.lastSeen, ['shape-main'], t0 + LEGEND_HOLD_MS - 1, LEGEND_HOLD_MS)
  assert.ok(seen.shown.includes('link-flight'), 'still held')
  seen = holdPresence(seen.lastSeen, ['shape-main'], t0 + LEGEND_HOLD_MS + 1, LEGEND_HOLD_MS)
  assert.ok(!seen.shown.includes('link-flight'), 'dropped after the hold')
  assert.ok(!seen.lastSeen.has('link-flight'), 'forgotten, so the map stays bounded')
})

test('holdPresence keeps the legend order, does not mutate its input and refreshes an entry seen again', () => {
  const prev = new Map<LegendEntryId, number>([['link-flight', 5], ['shape-main', 5]])
  const next = holdPresence(prev, ['shape-main'], 8, 10)
  assert.equal(prev.get('shape-main'), 5)
  assert.equal(next.lastSeen.get('shape-main'), 8)
  assert.deepEqual(next.shown, ['shape-main', 'link-flight'])
})
