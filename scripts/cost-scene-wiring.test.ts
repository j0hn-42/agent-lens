// Real wiring of the cost figures on a collapsed scene (#106): halo, DOM mirror and Costs panel agree with the whole simulation.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { sceneAgents, costScope } from '../web/components/agent-visualizer/canvas/scene'
import { createCollapseMemory } from '../web/components/agent-visualizer/canvas/branch-collapse'
import { computeClusters } from '../web/components/agent-visualizer/canvas/cluster-model'
import { buildA11yModel } from '../web/components/agent-visualizer/canvas/a11y-model'
import { drawCostSummaryPanel } from '../web/components/agent-visualizer/canvas/draw-cost'
import { sessionUsage } from '../web/lib/attribution'
import { formatCostUsage } from '../web/lib/usage'

/* eslint-disable @typescript-eslint/no-explicit-any */
const mk = (id: string, parentId: string | null, tokensUsed: number): any => ({
  id, agentKey: id, sessionId: 's', localId: id, displayName: id, name: id, state: 'idle', parentId, parentKey: parentId,
  tokensUsed, tokenStatus: 'available', tokensMax: 200_000,
  contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  toolCalls: 0, timeAlive: 0, x: id.length * 10, y: 0, vx: 0, vy: 0, pinned: false, isMain: parentId === null,
  spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
})

// orchestrator -> A -> two children; idle sub-trees collapse automatically
const agents = new Map<string, any>([
  ['o', mk('o', null, 10_000)], ['a', mk('a', 'o', 20_000)], ['a1', mk('a1', 'a', 300_000)], ['a2', mk('a2', 'a', 400_000)],
])
const sim: any = { agents, toolCalls: new Map(), discoveries: [], unattributed: new Map() }
const none = { agentId: null, toolCallId: null, discoveryId: null }

function fakeCtx(texts: string[]): any {
  const canvas = { width: 1000, offsetWidth: 1000 }
  return new Proxy({ canvas }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6 })
      if (k === 'fillText') return (s: string) => { texts.push(s) }
      return () => {}
    },
    set() { return true },
  })
}

test('on a collapsed scene, halo cost, DOM mirror and Costs panel all equal the session total', () => {
  const scene = sceneAgents(sim.agents, false, [], none, null, createCollapseMemory(), sim)
  assert.ok(scene.agents.size < agents.size, 'the scene really hides agents')
  assert.equal(scene.agents.has('a1'), false)

  const total = sessionUsage(agents.values(), [])
  const expected = formatCostUsage(total.cost)
  const scope = costScope(sim)

  const clusters = computeClusters(scene.agents.values(), undefined, { costAgents: scope.agents.values(), minMembers: 1 })
  assert.equal(clusters[0].costText, expected, 'halo')

  const withoutScope = computeClusters(scene.agents.values(), undefined, { minMembers: 1 })
  assert.notEqual(withoutScope[0].costText, expected, 'the drawn agents alone would give another figure')

  const texts: string[] = []
  drawCostSummaryPanel(fakeCtx(texts), scope.agents, scope.toolCalls, scope.unattributed)
  assert.equal(texts[0], expected, 'Costs panel header')
})

test('the DOM mirror cluster text carries the whole-simulation cost', () => {
  const scene = sceneAgents(sim.agents, false, [], none, null, createCollapseMemory(), sim)
  const expected = formatCostUsage(sessionUsage(agents.values(), []).cost)
  const withScope = buildA11yModel(scene.agents, scene.toolCalls, scene.discoveries, new Map(), { costAgents: costScope(sim).agents.values() })
  const without = buildA11yModel(scene.agents, scene.toolCalls, scene.discoveries, new Map())
  const texts = (m: typeof withScope) => m.clusters.map(c => c.text).join('|')
  assert.ok(withScope.clusters.length > 0, 'expected a cluster')
  assert.ok(texts(withScope).includes(expected), texts(withScope))
  assert.ok(!texts(without).includes(expected))
})
