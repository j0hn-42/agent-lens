// Automatic collapse of inactive sub-trees (#55): default state, indicators, reopening on new
// activity, manual choices and tree-style keyboard navigation. Pure model, synthetic data only.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  createCollapseMemory, evaluateCollapse, applyCollapse, toggleBranch, branchBadge, treeKeyAction,
  applyCollapseToContent, selectionOwners,
  type CollapseMemory,
} from '../web/components/agent-visualizer/canvas/branch-collapse'
import type { Agent, ToolCallNode, Discovery } from '../web/lib/agent-types'

const mk = (id: string, parentId: string | null, state: Agent['state'] = 'idle', archived = false) =>
  ({ id, parentId, state, archived }) as unknown as Agent

/** main -> a -> (a1, a2), main -> b -> b1 -> b11 */
function tree(states: Record<string, Agent['state']> = {}): Map<string, Agent> {
  const st = (id: string): Agent['state'] => states[id] ?? 'idle'
  return new Map(([
    ['main', null], ['a', 'main'], ['a1', 'a'], ['a2', 'a'], ['b', 'main'], ['b1', 'b'], ['b11', 'b1'],
  ] as const).map(([id, parent]) => [id, mk(id, parent, st(id))]))
}

function view(agents: Map<string, Agent>, memory: CollapseMemory, keep: string[] = []) {
  return evaluateCollapse(agents, memory, keep)
}

test('inactive branches are collapsed by default; the root and leaves are never branches', () => {
  const v = view(tree(), createCollapseMemory())
  assert.deepEqual([...v.branches.keys()].sort(), ['a', 'b', 'b1'])
  assert.equal(v.branches.get('a')!.collapsed, true)
  assert.deepEqual([...v.hidden].sort(), ['a1', 'a2', 'b1', 'b11'])
  assert.equal(v.branches.has('main'), false, 'the root is never collapsed')
})

const tool = (id: string, agentId: string) => ({ id, agentId }) as unknown as ToolCallNode
const disc = (id: string, agentId: string) => ({ id, agentId }) as unknown as Discovery

test('tool cards and discoveries of agents hidden by a collapsed branch are dropped', () => {
  const v = view(tree(), createCollapseMemory())
  const tools = new Map([['t1', tool('t1', 'a1')], ['t2', tool('t2', 'a')], ['t3', tool('t3', 'main')]])
  const out = applyCollapseToContent(tools, [disc('d1', 'a2'), disc('d2', 'main')], v)
  assert.deepEqual([...out.toolCalls.keys()], ['t2', 't3'])
  assert.deepEqual(out.discoveries.map(d => d.id), ['d2'])
})

test('applyCollapseToContent returns its inputs when nothing is hidden', () => {
  const v = view(tree({ a1: 'thinking', b11: 'thinking' }), createCollapseMemory())
  const tools = new Map([['t1', tool('t1', 'a1')]])
  const discs = [disc('d1', 'a1')]
  const out = applyCollapseToContent(tools, discs, v)
  assert.equal(out.toolCalls, tools)
  assert.equal(out.discoveries, discs)
})

test('a selected tool card or discovery keeps the branch of its owner open', () => {
  const tools = new Map([['t1', tool('t1', 'a1')]])
  const discs = [disc('d1', 'b11')]
  const owners = selectionOwners(null, 't1', 'd1', tools, discs)
  assert.deepEqual(owners, [null, 'a1', 'b11'])
  const v = view(tree(), createCollapseMemory(), owners.filter((x): x is string => !!x))
  assert.equal(v.hidden.has('a1'), false)
  assert.equal(v.hidden.has('b11'), false)
  assert.equal(applyCollapseToContent(tools, discs, v).toolCalls.has('t1'), true)
})

test('applyCollapse hides the descendants and keeps the collapsed node itself', () => {
  const agents = tree()
  const out = applyCollapse(agents, view(agents, createCollapseMemory()))
  assert.deepEqual([...out.keys()], ['main', 'a', 'b'])
})

test('applyCollapse returns the same map when nothing is hidden', () => {
  const agents = new Map([['x', mk('x', null)], ['y', mk('y', 'x', 'thinking')]])
  assert.equal(applyCollapse(agents, view(agents, createCollapseMemory())), agents)
})

test('a branch with an active descendant stays open, whatever its depth, and so do its ancestors', () => {
  const agents = tree({ b11: 'tool_calling' })
  const v = view(agents, createCollapseMemory())
  assert.equal(v.branches.get('b')!.collapsed, false)
  assert.equal(v.branches.get('b1')!.collapsed, false)
  assert.equal(v.branches.get('a')!.collapsed, true)
  assert.deepEqual([...v.hidden].sort(), ['a1', 'a2'])
})

test('a selected descendant keeps its ancestors open', () => {
  const v = view(tree(), createCollapseMemory(), ['a2'])
  assert.equal(v.branches.get('a')!.collapsed, false)
  assert.equal(v.branches.get('b')!.collapsed, true)
})

test('indicators: descendants count and active count of a collapsed branch', () => {
  const agents = tree()
  const v = view(agents, createCollapseMemory())
  assert.deepEqual(
    { d: v.branches.get('b')!.descendants, a: v.branches.get('b')!.active },
    { d: 2, a: 0 },
  )
  assert.deepEqual(branchBadge(v.branches.get('b')!), { kind: 'count', text: '+2', label: '2 hidden agents' })
  assert.deepEqual(branchBadge(v.branches.get('a')!), { kind: 'count', text: '+2', label: '2 hidden agents' })
  const oneChild = new Map([['m', mk('m', null)], ['p', mk('p', 'm')], ['c', mk('c', 'p')]])
  assert.deepEqual(branchBadge(view(oneChild, createCollapseMemory()).branches.get('p')!), { kind: 'count', text: '+1', label: '1 hidden agent' })
})

test('a manually closed branch with activity shows the green active count instead of +N', () => {
  const agents = tree({ a1: 'thinking', a2: 'thinking' })
  const memory = createCollapseMemory()
  let v = view(agents, memory)
  toggleBranch(memory, v, 'a') // open by activity -> user closes it
  v = view(agents, memory)
  assert.equal(v.branches.get('a')!.collapsed, true)
  assert.deepEqual(branchBadge(v.branches.get('a')!), { kind: 'active', text: '2', label: '2 active of 2 hidden agents' })
})

test('manual open is remembered, even when the branch goes quiet', () => {
  const memory = createCollapseMemory()
  let v = view(tree(), memory)
  toggleBranch(memory, v, 'a')
  v = view(tree(), memory)
  assert.equal(v.branches.get('a')!.collapsed, false)
  v = view(tree(), memory)
  assert.equal(v.branches.get('a')!.collapsed, false, 'still open on the next evaluation')
})

test('manual close is remembered while nothing new happens', () => {
  const agents = tree({ a1: 'thinking' })
  const memory = createCollapseMemory()
  let v = view(agents, memory)
  toggleBranch(memory, v, 'a')
  for (let i = 0; i < 3; i++) v = view(agents, memory)
  assert.equal(v.branches.get('a')!.collapsed, true, 'the same ongoing activity does not reopen it')
})

test('new activity reopens a manually closed branch once; closing it again sticks', () => {
  const memory = createCollapseMemory()
  let v = view(tree(), memory)
  toggleBranch(memory, v, 'a') // open
  toggleBranch(memory, view(tree(), memory), 'a') // close again (manual)
  assert.equal(view(tree(), memory).branches.get('a')!.collapsed, true)

  // a1 becomes active: reopened
  const busy = tree({ a1: 'tool_calling' })
  v = view(busy, memory)
  assert.equal(v.branches.get('a')!.collapsed, false)
  // the user closes it while the activity goes on: it stays closed
  toggleBranch(memory, v, 'a')
  assert.equal(view(busy, memory).branches.get('a')!.collapsed, true)
  // activity stops, then starts again: reopened a second time (it is new activity)
  view(tree(), memory)
  assert.equal(view(busy, memory).branches.get('a')!.collapsed, false)
})

test('manual choices of vanished agents are forgotten (bounded memory)', () => {
  const memory = createCollapseMemory()
  toggleBranch(memory, view(tree(), memory), 'a')
  assert.equal(memory.manual.size, 1)
  view(new Map([['main', mk('main', null)]]), memory)
  assert.equal(memory.manual.size, 0)
  assert.equal(memory.hadActivity.size, 0)
})

test('a cycle in parent links does not hang and hides nothing', () => {
  const agents = new Map([['x', mk('x', 'y')], ['y', mk('y', 'x')]])
  const v = view(agents, createCollapseMemory())
  assert.equal(v.hidden.size, 0)
})

test('a parent missing from the map makes its child a root', () => {
  const agents = new Map([['c', mk('c', 'gone')], ['g', mk('g', 'c')]])
  const v = view(agents, createCollapseMemory())
  assert.equal(v.branches.has('c'), false)
  assert.equal(v.hidden.size, 0)
})

test('keyboard, tree style: Right expands a collapsed branch, then enters its first child', () => {
  const agents = tree()
  const memory = createCollapseMemory()
  let v = view(agents, memory)
  assert.deepEqual(treeKeyAction('ArrowRight', 'a', agents, v), { kind: 'toggle', id: 'a' })
  toggleBranch(memory, v, 'a')
  v = view(agents, memory)
  assert.deepEqual(treeKeyAction('ArrowRight', 'a', agents, v), { kind: 'focus', id: 'a1' })
})

test('keyboard, tree style: Left collapses an expanded branch, then goes to the parent', () => {
  const agents = tree({ a1: 'thinking' })
  const v = view(agents, createCollapseMemory())
  assert.deepEqual(treeKeyAction('ArrowLeft', 'a', agents, v), { kind: 'toggle', id: 'a' })
  assert.deepEqual(treeKeyAction('ArrowLeft', 'a1', agents, v), { kind: 'focus', id: 'a' })
})

test('keyboard, tree style: leaf Right and root Left fall back to the default behaviour', () => {
  const agents = tree({ a1: 'thinking' })
  const v = view(agents, createCollapseMemory())
  assert.equal(treeKeyAction('ArrowRight', 'a1', agents, v), null)
  assert.equal(treeKeyAction('ArrowLeft', 'main', agents, v), null)
  assert.equal(treeKeyAction('ArrowDown', 'a', agents, v), null)
})

test('keyboard: Right on an expanded branch whose children are all hidden does nothing special', () => {
  const agents = tree({ b11: 'thinking' })
  const v = view(agents, createCollapseMemory())
  assert.deepEqual(treeKeyAction('ArrowRight', 'b', agents, v), { kind: 'focus', id: 'b1' })
})
