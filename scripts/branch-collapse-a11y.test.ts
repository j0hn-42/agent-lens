// DOM mirror of collapsed branches (#55): the badge text and the toggle state are not canvas-only.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildA11yModel } from '../web/components/agent-visualizer/canvas/a11y-model'
import { createCollapseMemory, evaluateCollapse, applyCollapse } from '../web/components/agent-visualizer/canvas/branch-collapse'

/* eslint-disable @typescript-eslint/no-explicit-any */
const mk = (id: string, parentId: string | null, state = 'idle'): any => ({
  id, agentKey: id, sessionId: 's', localId: id, displayName: id, name: id, state, parentId, parentKey: parentId,
  tokensUsed: 0, tokensMax: 200_000,
  contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: parentId === null,
  spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
})

test('a collapsed branch announces its hidden agents; an expanded one says it can be collapsed', () => {
  const all = new Map<string, any>([['main', mk('main', null)], ['a', mk('a', 'main')], ['a1', mk('a1', 'a')], ['b', mk('b', 'main')], ['b1', mk('b1', 'b', 'thinking')]])
  const collapse = evaluateCollapse(all, createCollapseMemory())
  const model = buildA11yModel(applyCollapse(all, collapse), new Map(), [], new Map(), { collapse })
  const byId = new Map(model.agents.map(a => [a.id, a]))
  assert.deepEqual(byId.get('a')!.branch, { collapsed: true, pinned: false, text: 'Collapsed branch, 1 hidden agent' })
  assert.deepEqual(byId.get('b')!.branch, { collapsed: false, pinned: false, text: 'Expanded branch, 1 sub-agent' })
  assert.equal(byId.get('main')!.branch, undefined, 'a root has no collapsible branch')
  assert.equal(byId.has('a1'), false, 'hidden agents are not listed')
})

test('a collapsed branch with active descendants says how many are active', () => {
  const all = new Map<string, any>([['main', mk('main', null)], ['a', mk('a', 'main')], ['a1', mk('a1', 'a', 'thinking')], ['a2', mk('a2', 'a')]])
  const memory = createCollapseMemory()
  let collapse = evaluateCollapse(all, memory)
  memory.manual.set('a', 'closed')
  collapse = evaluateCollapse(all, memory)
  const model = buildA11yModel(applyCollapse(all, collapse), new Map(), [], new Map(), { collapse })
  assert.equal(model.agents.find(a => a.id === 'a')!.branch!.text, 'Collapsed branch, 1 active of 2 hidden agents')
})
