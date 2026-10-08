// Rendering-side contract of unverified parent -> child edges (#54): classification, wording, DOM mirror.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildA11yModel } from '../web/components/agent-visualizer/canvas/a11y-model'
import { isUnverifiedEdge, unverifiedReasonText } from '../web/components/agent-visualizer/canvas/edge-style'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 'a1'
  return {
    id, agentKey: id, sessionId: 's', localId: id, displayName: 'main', name: 'main', state: 'idle',
    parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: true,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], ...over,
  }
}

test('only an explicitly verified parent-child edge counts as a fact; tool edges are not concerned', () => {
  assert.equal(isUnverifiedEdge({ type: 'parent-child', verified: true }), false)
  assert.equal(isUnverifiedEdge({ type: 'parent-child', verified: false }), true)
  assert.equal(isUnverifiedEdge({ type: 'parent-child' }), true, 'no verdict is not a proof')
  assert.equal(isUnverifiedEdge({ type: 'tool' }), false)
})

test('every reason has a readable text, unknown reasons have none', () => {
  for (const r of ['no-tool-use-id', 'parent-fallback', 'no-call', 'parent-mismatch', 'child-mismatch', 'return-mismatch', 'dispatch-mismatch']) {
    assert.ok(unverifiedReasonText(r).length > 0, r)
  }
  assert.equal(unverifiedReasonText('whatever'), '')
  assert.equal(unverifiedReasonText(undefined), '')
})

test('the DOM mirror says when a parent link is unverified instead of presenting it as fact', () => {
  const agents = new Map<string, any>([
    ['a1', agent({})],
    ['a2', agent({ id: 'a2', name: 'Explorer', parentId: 'a1', isMain: false })],
    ['a3', agent({ id: 'a3', name: 'Reviewer', parentId: 'a1', isMain: false })],
  ])
  const edges: any[] = [
    { id: 'e2', from: 'a1', to: 'a2', type: 'parent-child', opacity: 1, verified: false, unverifiedReason: 'no-call' },
    { id: 'e3', from: 'a1', to: 'a3', type: 'parent-child', opacity: 1, verified: true },
  ]
  const model = buildA11yModel(agents, new Map(), [], new Map(), { edges })
  assert.equal(model.agents[1].relation, 'child of main (unverified link: no earlier call by the parent with this id)')
  assert.equal(model.agents[2].relation, 'child of main')
})
