// Tool cards and discoveries never float without their agent (#378): neither drawn nor framed by "Fit to view".
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { sceneAgents } from '../web/components/agent-visualizer/canvas/scene'
import { createCollapseMemory } from '../web/components/agent-visualizer/canvas/branch-collapse'
import { computeFitBounds } from '../web/components/agent-visualizer/canvas/camera-fit'

/* eslint-disable @typescript-eslint/no-explicit-any */
const mk = (id: string, parentId: string | null, over: Record<string, unknown> = {}): any => ({
  id, agentKey: id, sessionId: 's', localId: id, displayName: id, name: id, state: 'idle', parentId, parentKey: parentId,
  tokensUsed: 0, tokenStatus: 'available', tokensMax: 200_000,
  contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: parentId === null,
  spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], ...over,
})
const tool = (id: string, agentId: string, x: number): any => ({ id, agentId, x, y: 0, opacity: 1, state: 'complete', toolName: 'Grep', args: '' })
const none = { agentId: null, toolCallId: null, discoveryId: null }

test('hide inactive: the tool cards and discoveries of a hidden agent are not in the drawn scene (#378)', () => {
  const agents = new Map<string, any>([
    ['o', mk('o', null, { state: 'thinking' })],
    ['done', mk('done', 'o', { state: 'complete', completedAt: 0, x: 900 })],
  ])
  const sim = {
    toolCalls: new Map<string, any>([['t-o', tool('t-o', 'o', 100)], ['t-done', tool('t-done', 'done', 1200)]]),
    discoveries: [{ id: 'd-done', agentId: 'done', x: 1300, y: 0, opacity: 1 } as any],
  }
  const scene = sceneAgents(agents, true, [], none, null, createCollapseMemory(), sim)
  assert.equal(scene.agents.has('done'), false, 'precondition: the finished agent is hidden')
  assert.equal(scene.toolCalls.has('t-done'), false, 'its tool card is not drawn')
  assert.equal(scene.toolCalls.has('t-o'), true)
  assert.equal(scene.discoveries.some(d => d.id === 'd-done'), false)
})

test('hide inactive: a selected card keeps its agent drawn, so the selection never vanishes (#378)', () => {
  const agents = new Map<string, any>([
    ['o', mk('o', null, { state: 'thinking' })],
    ['done', mk('done', 'o', { state: 'complete', completedAt: 0, x: 900 })],
  ])
  const sim = { toolCalls: new Map<string, any>([['t-done', tool('t-done', 'done', 1200)]]), discoveries: [] }
  const scene = sceneAgents(agents, true, [], { agentId: null, toolCallId: 't-done', discoveryId: null }, null, createCollapseMemory(), sim)
  assert.equal(scene.toolCalls.has('t-done'), true)
  assert.equal(scene.agents.has('done'), true)
})

test('computeFitBounds: a tool card whose agent is not drawn does not stretch the fit (#378)', () => {
  const a = mk('a', null)
  const base = computeFitBounds({ agents: [a], simTime: 0 })
  const orphan = computeFitBounds({ agents: [a], simTime: 0, toolCalls: [tool('t', 'gone', 5000)] })
  assert.equal(orphan.maxX, base.maxX)
  const fadedOwner = computeFitBounds({ agents: [a, mk('b', 'a', { opacity: 0 })], simTime: 0, toolCalls: [tool('t', 'b', 5000)] })
  assert.equal(fadedOwner.maxX, base.maxX)
  const own = computeFitBounds({ agents: [a], simTime: 0, toolCalls: [tool('t', 'a', 700)] })
  assert.ok(own.maxX > 700, 'the cards of a drawn agent are still framed')
})
