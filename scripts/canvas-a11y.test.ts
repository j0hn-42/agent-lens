import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  buildGraphLabel, buildA11yModel, updateToolHistory, updateCommHistory,
  describeTransition, pushAnnouncements, ANNOUNCE_BULK_THRESHOLD,
} from '../web/components/agent-visualizer/canvas/a11y-model'
import { keyToAction, stepFocus, buildNodeOrder, locateNode } from '../web/components/agent-visualizer/canvas/keyboard-nav'
import {
  hitRadiusWorld, pointInMinRect, findAgentAt, findToolCallAt, findDiscoveryAt, hitTestAt,
} from '../web/components/agent-visualizer/canvas/hit-detection'
import { lodForZoom, createFlashLimiter } from '../web/components/agent-visualizer/canvas/draw-options'
import { computeOverlayLayout, OVERLAY_METRICS } from '../web/components/agent-visualizer/canvas/overlay-layout'
import { bubbleAlpha } from '../web/components/agent-visualizer/canvas/bubble-utils'
import {
  isExpiryHeld, MIN_VISIBLE_OPACITY, BUBBLE_HOLD, BUBBLE_FADE_OUT, LOD, CAMERA, type ExpiryHold,
} from '../web/lib/canvas-constants'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  return {
    id: 'a1', name: 'main', state: 'idle', parentId: null, tokensUsed: 12_000, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 2, timeAlive: 5, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: true,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    ...over,
  }
}
function tool(over: Record<string, unknown> = {}): any {
  return { id: 't1', agentId: 'a1', toolName: 'Read', state: 'complete', args: 'file.ts', x: 100, y: 0, startTime: 0, opacity: 1, ...over }
}
const hold = (over: Partial<ExpiryHold> = {}): ExpiryHold => ({
  neverHide: false, paused: false, agentIds: new Set(), toolIds: new Set(), discoveryIds: new Set(), ...over,
})

// ─── #1 accessible model ────────────────────────────────────────────────────

test('buildGraphLabel summarises counts and states', () => {
  assert.equal(buildGraphLabel([]), 'Agent graph: no agents yet')
  assert.equal(
    buildGraphLabel([{ state: 'thinking' }, { state: 'tool_calling' }, { state: 'waiting_permission' }, { state: 'complete' }]),
    'Agent graph: 4 agents, 2 running, 1 waiting for permission',
  )
  assert.match(buildGraphLabel([{ state: 'error' }]), /^Agent graph: 1 agent, 0 running, 0 waiting for permission, 1 in error$/)
})

test('tool history keeps faded tools and evicts the oldest past the cap', () => {
  const history = new Map()
  updateToolHistory(history, new Map([['t1', tool()]]))
  // t1 faded from the canvas: the next snapshot no longer contains it
  updateToolHistory(history, new Map([['t2', tool({ id: 't2', toolName: 'Edit', state: 'error', errorMessage: 'boom' })]]))
  assert.deepEqual(Array.from(history.keys()), ['t1', 't2'])
  assert.equal(history.get('t2').error, 'boom')

  updateToolHistory(history, new Map([['t3', tool({ id: 't3' })], ['t4', tool({ id: 't4' })]]), 3)
  assert.deepEqual(Array.from(history.keys()), ['t2', 't3', 't4'])
})

test('buildA11yModel lists agent facts, relations, tools and live flag', () => {
  const agents = new Map<string, any>([
    ['a1', agent({ model: 'claude-sonnet-4-5' })],
    ['a2', agent({ id: 'a2', name: 'Explorer', parentId: 'a1', isMain: false, state: 'waiting_permission', runtime: 'codex' })],
  ])
  const toolCalls = new Map([['t1', tool({ agentId: 'a2' })]])
  const history = new Map()
  updateToolHistory(history, toolCalls)
  updateToolHistory(history, new Map()) // no-op
  history.set('gone', { id: 'gone', agentId: 'a2', name: 'Bash', args: 'ls', state: 'complete', error: '', result: '' })

  const model = buildA11yModel(agents, toolCalls, [], history)
  assert.equal(model.summary, 'Agent graph: 2 agents, 0 running, 1 waiting for permission')
  const [main, sub] = model.agents
  assert.equal(main.relation, 'main agent')
  assert.deepEqual(main.childNames, ['Explorer'])
  assert.equal(main.tokens, '12k / 200k tokens')
  assert.equal(sub.relation, 'child of main')
  assert.equal(sub.stateText, 'waiting for permission')
  assert.equal(sub.runtime, 'Codex')
  assert.deepEqual(sub.tools.map(t => [t.name, t.live]), [['Read', true], ['Bash', false]])
})

test('communication history records labelled dispatch/return particles once', () => {
  const agents = new Map<string, any>([['a1', agent()], ['a2', agent({ id: 'a2', name: 'Explorer', isMain: false })]])
  const edges: any[] = [{ id: 'e1', from: 'a1', to: 'a2', type: 'parent-child', opacity: 1 }]
  const particles: any[] = [
    { id: 'p1', edgeId: 'e1', progress: 0.5, type: 'dispatch', color: '#fff', size: 1, trailLength: 1, label: 'Find auth code' },
    { id: 'p2', edgeId: 'e1', progress: 0.5, type: 'message', color: '#fff', size: 1, trailLength: 1, label: 'ignored' },
  ]
  const history = new Map()
  updateCommHistory(history, particles, edges, agents)
  updateCommHistory(history, particles, edges, agents)
  assert.equal(history.size, 1)
  assert.equal(history.get('p1').text, 'main dispatched to Explorer: Find auth code')
})

test('transitions become short announcements, bulk updates collapse', () => {
  assert.equal(describeTransition({ kind: 'agent_spawn', id: 'a', name: 'X' }), 'Agent X started')
  assert.equal(describeTransition({ kind: 'agent_waiting_permission', id: 'a', name: 'X' }), 'Agent X is waiting for permission')
  assert.equal(describeTransition({ kind: 'agent_error', id: 'a', name: 'X' }), 'Agent X failed')
  assert.equal(describeTransition({ kind: 'agent_complete', id: 'a', name: 'X' }), 'Agent X completed')
  assert.equal(describeTransition({ kind: 'tool_error', id: 't', name: 'Bash' }), 'Tool Bash failed')
  assert.equal(describeTransition({ kind: 'tool_start', id: 't', name: 'Bash' }), null)

  const same: string[] = []
  assert.equal(pushAnnouncements(same, [{ kind: 'tool_start', id: 't', name: 'Bash' }]), same, 'unchanged array when nothing to announce')

  const many = Array.from({ length: ANNOUNCE_BULK_THRESHOLD + 1 }, (_, i) => ({ kind: 'agent_spawn' as const, id: `a${i}`, name: `n${i}` }))
  assert.deepEqual(pushAnnouncements([], many), [`${many.length} agent graph updates`])

  let log: string[] = []
  for (let i = 0; i < 5; i++) log = pushAnnouncements(log, [{ kind: 'agent_error', id: `a${i}`, name: `n${i}` }])
  assert.equal(log.length, 3)
  assert.equal(log[2], 'Agent n4 failed')
})

// ─── #2 keyboard ────────────────────────────────────────────────────────────

const key = (k: string, extra: Record<string, boolean> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra })

test('keyToAction implements the documented keyboard map', () => {
  assert.deepEqual(keyToAction(key('ArrowRight')), { kind: 'step', dir: 1 })
  assert.deepEqual(keyToAction(key('ArrowUp')), { kind: 'step', dir: -1 })
  assert.deepEqual(keyToAction(key('ArrowLeft', { shiftKey: true })), { kind: 'pan', dx: CAMERA.keyboardPanStep, dy: 0 })
  assert.deepEqual(keyToAction(key('ArrowDown', { shiftKey: true })), { kind: 'pan', dx: 0, dy: -CAMERA.keyboardPanStep })
  assert.deepEqual(keyToAction(key('Enter')), { kind: 'activate' })
  assert.deepEqual(keyToAction(key('0')), { kind: 'fit' })
  assert.equal((keyToAction(key('+')) as any).factor > 1, true)
  assert.equal((keyToAction(key('-')) as any).factor < 1, true)
  assert.deepEqual(keyToAction(key('ContextMenu')), { kind: 'contextmenu' })
  assert.deepEqual(keyToAction(key('F10', { shiftKey: true })), { kind: 'contextmenu' })
  assert.equal(keyToAction(key('F10')), null)
  assert.equal(keyToAction(key('Delete')), null, 'Delete does nothing')
  assert.equal(keyToAction(key('+', { ctrlKey: true })), null, 'browser zoom shortcuts are left alone')
})

test('node traversal covers agents, then tools, then discoveries, with wrap-around', () => {
  const agents = new Map<string, any>([['a1', agent()], ['a2', agent({ id: 'a2', opacity: 0 })], ['a3', agent({ id: 'a3' })]])
  const tools = new Map<string, any>([['t1', tool()]])
  const discoveries: any[] = [{ id: 'd1', agentId: 'a1', type: 'file', label: 'x', content: 'y', x: 5, y: 6, targetX: 5, targetY: 6, opacity: 1, timestamp: 0 }]
  const order = buildNodeOrder(agents, tools, discoveries)
  assert.deepEqual(order.map(n => `${n.type}:${n.id}`), ['agent:a1', 'agent:a3', 'tool:t1', 'discovery:d1'])
  assert.deepEqual(stepFocus(order, null, 1), order[0])
  assert.deepEqual(stepFocus(order, null, -1), order[3])
  assert.deepEqual(stepFocus(order, order[3], 1), order[0])
  assert.deepEqual(stepFocus(order, order[0], -1), order[3])
  assert.deepEqual(stepFocus(order, { type: 'agent', id: 'stale' }, 1), order[0])
  assert.equal(stepFocus([], null, 1), null)
  assert.deepEqual(locateNode({ type: 'discovery', id: 'd1' }, { agents, toolCalls: tools, discoveries }), { x: 5, y: 6 })
  assert.equal(locateNode({ type: 'tool', id: 'nope' }, { agents, toolCalls: tools, discoveries }), null)
})

// ─── #24 hit testing ────────────────────────────────────────────────────────

test('hit radius never drops below 12 screen pixels', () => {
  assert.equal(hitRadiusWorld(20, 1, 12), 20)
  assert.equal(hitRadiusWorld(20, 0.2, 12), 60) // 12px / 0.2
  assert.equal(hitRadiusWorld(20, 0, 12), 20)
})

test('pointInMinRect grows tiny rects to the minimum screen size', () => {
  // 10x10 world rect at zoom 0.2 is 2x2 px; must still be a 24px target (120 world units)
  assert.equal(pointInMinRect(50, 0, -5, -5, 10, 10, 0.2, 24), true)
  assert.equal(pointInMinRect(70, 0, -5, -5, 10, 10, 0.2, 24), false)
  assert.equal(pointInMinRect(8, 0, -5, -5, 10, 10, 1, 24), true)
})

test('findAgentAt uses screen-sized radius, skips faint agents and prefers the one drawn on top', () => {
  const agents = new Map<string, any>([
    ['bottom', agent({ id: 'bottom', x: 0, y: 0, isMain: false })],
    ['top', agent({ id: 'top', x: 10, y: 0, isMain: false })],
    ['ghost', agent({ id: 'ghost', x: 200, y: 0, isMain: false, opacity: MIN_VISIBLE_OPACITY / 2 })],
  ])
  assert.equal(findAgentAt(5, 0, agents), 'top', 'last drawn wins')
  assert.equal(findAgentAt(200, 0, agents), null, 'nearly invisible agents are not clickable')
  assert.equal(findAgentAt(-60, 0, agents, 1), null)
  assert.equal(findAgentAt(-55, 0, agents, 0.2), 'bottom', '12px screen radius at 0.2 zoom is 60 world units')
})

test('findToolCallAt and findDiscoveryAt ignore faint elements and use reverse order', () => {
  const tools = new Map<string, any>([
    ['t1', tool({ id: 't1', x: 0, y: 0 })],
    ['t2', tool({ id: 't2', x: 0, y: 0 })],
    ['t3', tool({ id: 't3', x: 500, y: 0, opacity: 0.01 })],
  ])
  assert.equal(findToolCallAt(0, 0, tools), 't2')
  assert.equal(findToolCallAt(500, 0, tools), null)
  const d = (id: string, opacity: number) => ({ id, agentId: 'a1', type: 'file', label: 'l', content: 'c', x: 0, y: 0, targetX: 0, targetY: 0, opacity, timestamp: 0 })
  assert.equal(findDiscoveryAt(0, 0, [d('d1', 1), d('d2', 1)] as any), 'd2')
  assert.equal(findDiscoveryAt(0, 0, [d('d3', 0.01)] as any), null)
})

test('hitTestAt prefers agent, then tool, then discovery', () => {
  const agents = new Map<string, any>([['a1', agent({ x: 0, y: 0 })]])
  const tools = new Map<string, any>([['t1', tool({ x: 100, y: 0 })]])
  assert.deepEqual(hitTestAt(0, 0, { agents, toolCalls: tools, discoveries: [] }, 0, 1), { type: 'agent', id: 'a1' })
  assert.deepEqual(hitTestAt(100, 0, { agents, toolCalls: tools, discoveries: [] }, 0, 1), { type: 'tool', id: 't1' })
  assert.equal(hitTestAt(900, 900, { agents, toolCalls: tools, discoveries: [] }, 0, 1), null)
})

test('level of detail hides text below the thresholds', () => {
  assert.deepEqual(lodForZoom(1), { labels: true, details: true })
  assert.deepEqual(lodForZoom(LOD.detailMinZoom - 0.01), { labels: true, details: false })
  assert.deepEqual(lodForZoom(LOD.labelMinZoom - 0.01), { labels: false, details: false })
})

test('overlay layout stacks percent, stats and cost without overlap', () => {
  const M = OVERLAY_METRICS
  for (const hasPercent of [false, true]) {
    const { statsTop, costTop } = computeOverlayLayout({ hasPercent, showStats: true, showCost: true })
    assert.ok(statsTop != null && costTop != null)
    const percentTop = hasPercent ? M.baseGap + M.percentH : M.baseGap
    // stats box spans [statsTop - statsH, statsTop] above the node; it must clear the percent label
    assert.ok(statsTop - M.statsH >= percentTop)
    // the cost pill (plus its mini bar below) must clear the stats box
    assert.ok(costTop - M.costPillH - M.costBarH >= statsTop)
  }
  assert.deepEqual(computeOverlayLayout({ hasPercent: false, showStats: false, showCost: false }), { statsTop: null, costTop: null })
})

// ─── #20 motion ─────────────────────────────────────────────────────────────

test('flash limiter allows at most 2 flashes per second', () => {
  const limiter = createFlashLimiter(2)
  assert.equal(limiter.allow(0), true)
  assert.equal(limiter.allow(100), true)
  assert.equal(limiter.allow(200), false)
  assert.equal(limiter.allow(999), false)
  assert.equal(limiter.allow(1000), true, 'window slides')
  assert.equal(limiter.allow(1050), false)
  assert.equal(limiter.allow(1100), true)
})

// ─── #25 expiry ─────────────────────────────────────────────────────────────

test('isExpiryHeld holds hovered ids, and everything while paused or never-hide', () => {
  assert.equal(isExpiryHeld('tool', 't1', hold()), false)
  assert.equal(isExpiryHeld('tool', 't1', hold({ toolIds: new Set(['t1']) })), true)
  assert.equal(isExpiryHeld('tool', 't2', hold({ toolIds: new Set(['t1']) })), false)
  assert.equal(isExpiryHeld('agent', 'a', hold({ agentIds: new Set(['a']) })), true)
  assert.equal(isExpiryHeld('discovery', 'd', hold({ discoveryIds: new Set(['d']) })), true)
  assert.equal(isExpiryHeld('discovery', 'x', hold({ paused: true })), true)
  assert.equal(isExpiryHeld('agent', 'x', hold({ neverHide: true })), true)
})

test('held bubbles stay visible past their normal lifetime', () => {
  const late = BUBBLE_HOLD + BUBBLE_FADE_OUT + 5
  assert.equal(bubbleAlpha(late, 1), 0)
  assert.ok(bubbleAlpha(late, 1, true) > 0.5)
  assert.ok(bubbleAlpha(0.1, 1, true) < bubbleAlpha(1, 1, true), 'fade-in is preserved')
})

// ─── announcement queue + event-time recorder ───────────────────────────────

import { createAnnouncementQueue, enqueueAnnouncements } from '../web/components/agent-visualizer/canvas/a11y-model'
import { createRecorder, recordFrame, resetRecorder } from '../web/components/agent-visualizer/canvas/a11y-recorder'

test('announcement queue keeps stable ids when the window slides', () => {
  let q = createAnnouncementQueue()
  const ids: number[][] = []
  for (let i = 0; i < 6; i++) {
    q = enqueueAnnouncements(q, [{ kind: 'agent_error', id: `a${i}`, name: `n${i}` }])
    ids.push(q.items.map(x => x.id))
  }
  assert.deepEqual(ids[2], [1, 2, 3])
  assert.deepEqual(ids[3], [2, 3, 4], 'older items keep their ids (React keys) when the window slides')
  assert.deepEqual(ids[5], [4, 5, 6])
  assert.equal(q.items[2].text, 'Agent n5 failed')
})

test('announcement queue dedupes within a batch and returns same queue when empty', () => {
  const q = createAnnouncementQueue()
  const same = enqueueAnnouncements(q, [{ kind: 'tool_start', id: 't', name: 'Bash' }])
  assert.equal(same, q)
  const dup = enqueueAnnouncements(q, [
    { kind: 'agent_error', id: 'a', name: 'X' }, { kind: 'agent_error', id: 'a', name: 'X' },
  ])
  assert.equal(dup.items.length, 1)
})

test('recorder captures dispatch particles that exist for a single frame and tool calls after they vanish', () => {
  const agents = new Map<string, any>([['a1', agent()], ['a2', agent({ id: 'a2', name: 'Explorer', isMain: false })]])
  const edges: any[] = [{ id: 'e1', from: 'a1', to: 'a2', type: 'parent-child', opacity: 1 }]
  const rec = createRecorder()
  const particle = { id: 'p1', edgeId: 'e1', progress: 0.1, type: 'dispatch', color: '#fff', size: 1, trailLength: 1, label: 'Find auth' }
  const tool: any = { id: 't1', agentId: 'a1', toolName: 'Read', args: 'a.ts', state: 'running' }
  const v0 = rec.version
  recordFrame(rec, { particles: [particle as any], edges, agents, toolCalls: new Map([['t1', tool]]) })
  assert.ok(rec.version > v0)
  const v1 = rec.version
  recordFrame(rec, { particles: [], edges, agents, toolCalls: new Map() })
  assert.equal(rec.version, v1, 'no change, no version bump')
  assert.equal(rec.comms.get('p1')?.text, 'main dispatched to Explorer: Find auth')
  assert.equal(rec.tools.get('t1')?.name, 'Read')
  resetRecorder(rec)
  assert.equal(rec.comms.size + rec.tools.size, 0)
})
