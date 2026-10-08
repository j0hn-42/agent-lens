// Badge of a collapsed branch (#55): one geometry shared by the drawing and the hit test.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createCollapseMemory, evaluateCollapse, badgeRect, applyCollapse } from '../web/components/agent-visualizer/canvas/branch-collapse'
import { findBranchBadgeAt, hitTestAt } from '../web/components/agent-visualizer/canvas/hit-detection'
import type { Agent } from '../web/lib/agent-types'

/* eslint-disable @typescript-eslint/no-explicit-any */
const mk = (id: string, parentId: string | null, x: number, y: number): Agent =>
  ({ id, parentId, state: 'idle', archived: false, x, y, opacity: 1, scale: 1, isMain: parentId === null, kind: undefined }) as any

function scene() {
  const agents = new Map<string, Agent>([
    ['main', mk('main', null, 0, 0)], ['a', mk('a', 'main', 300, 0)], ['a1', mk('a1', 'a', 500, 0)],
  ])
  const view = evaluateCollapse(agents, createCollapseMemory())
  return { agents: applyCollapse(agents, view), view }
}

test('the badge sits on the collapsed node and has a positive size', () => {
  const { agents } = scene()
  const r = badgeRect(agents.get('a')!, '+1')
  assert.ok(r.w > 0 && r.h > 0)
  assert.ok(r.x > 300 - 100 && r.x < 300 + 100 && r.y > -100 && r.y < 100)
})

test('a click on the badge hits the branch, a click on the node still hits the agent', () => {
  const { agents, view } = scene()
  const r = badgeRect(agents.get('a')!, '+1')
  const onBadge = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  assert.equal(findBranchBadgeAt(onBadge.x, onBadge.y, agents, view, 1), 'a')
  assert.deepEqual(hitTestAt(onBadge.x, onBadge.y, { agents, toolCalls: new Map(), discoveries: [], collapse: view }, 0, 1), { type: 'branch', id: 'a' })
  assert.deepEqual(hitTestAt(300, 0, { agents, toolCalls: new Map(), discoveries: [], collapse: view }, 0, 1), { type: 'agent', id: 'a' })
})

test('only collapsed branches have a badge', () => {
  const agents = new Map<string, Agent>([
    ['main', mk('main', null, 0, 0)], ['a', mk('a', 'main', 300, 0)], ['a1', { ...mk('a1', 'a', 500, 0), state: 'thinking' } as Agent],
  ])
  const view = evaluateCollapse(agents, createCollapseMemory())
  const r = badgeRect(agents.get('a')!, '+1')
  assert.equal(findBranchBadgeAt(r.x + r.w / 2, r.y + r.h / 2, agents, view, 1), null)
})

test('the hit area never shrinks below the minimum target size when zoomed out', () => {
  const { agents, view } = scene()
  const r = badgeRect(agents.get('a')!, '+1')
  const scale = 0.2
  assert.equal(findBranchBadgeAt(r.x + r.w + 20, r.y + r.h / 2, agents, view, scale), 'a')
  assert.equal(findBranchBadgeAt(r.x + r.w + 20, r.y + r.h / 2, agents, view, 1), null)
})
