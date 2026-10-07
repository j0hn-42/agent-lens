import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentRowView, agentTreeSignature, focusKeyOf, restoreFocusByKey } from '../web/lib/row-sync'
import type { AgentNode, AgentLike } from '../web/lib/session-tree'

const base: AgentLike = { id: 'a:main', sessionId: 'a', parentKey: null, name: 'main', state: 'thinking', tokensUsed: 10, spawnTime: 1, lastEventAt: 1000 }
const node = (agent: AgentLike, children: AgentNode[] = []): AgentNode => ({ agent, children })

test('agentRowView: shows the tool while tool_calling, the state otherwise', () => {
  assert.equal(agentRowView({ ...base, state: 'tool_calling', currentTool: 'Read' }, 1500).detail, 'Read')
  assert.notEqual(agentRowView({ ...base, state: 'thinking', currentTool: 'Read' }, 1500).detail, 'Read')
})

test('agentRowView: a stale status is said as last known, never as current', () => {
  const view = agentRowView({ ...base, state: 'thinking' }, 1000 + 10 * 60_000)
  assert.equal(view.stale, true)
  assert.match(view.detail, /^last known state:/)
})

test('signature: unchanged content gives the same signature, even for a new object', () => {
  assert.equal(agentTreeSignature(node(base), 1500), agentTreeSignature(node({ ...base }), 1500))
})

test('signature: changes with any displayed field', () => {
  const ref = agentTreeSignature(node(base), 1500)
  for (const patch of [{ name: 'other' }, { state: 'idle' }, { tokensUsed: 11 }, { kind: 'subagent' as const }, { currentTool: 'x', state: 'tool_calling' }]) {
    assert.notEqual(agentTreeSignature(node({ ...base, ...patch }), 1500), ref, JSON.stringify(patch))
  }
})

test('signature: ignores fields that are not displayed (spawn time, last event while fresh)', () => {
  const ref = agentTreeSignature(node(base), 1500)
  assert.equal(agentTreeSignature(node({ ...base, spawnTime: 99, lastEventAt: 1400 }), 1500), ref)
})

test('signature: a stale transition changes it, a child change bubbles up to the parent', () => {
  assert.notEqual(agentTreeSignature(node(base), 1500), agentTreeSignature(node(base), 1000 + 10 * 60_000))
  const child = { ...base, id: 'a:sub', parentKey: 'a:main', name: 'sub' }
  const before = agentTreeSignature(node(base, [node(child)]), 1500)
  const after = agentTreeSignature(node(base, [node({ ...child, tokensUsed: 99 })]), 1500)
  assert.notEqual(before, after)
})

test('signature: separators prevent collisions between neighbouring fields', () => {
  const x = agentTreeSignature(node({ ...base, name: 'a|b', state: 'idle' }), 1500)
  const y = agentTreeSignature(node({ ...base, name: 'a', state: 'b|idle' }), 1500)
  assert.notEqual(x, y)
})

// ─── focus ──────────────────────────────────────────────────────────────────

type FakeEl = { dataset: Record<string, string | undefined>; focused?: boolean; focus: (o?: unknown) => void; closest: (s: string) => FakeEl | null }
const fakeEl = (key?: string): FakeEl => {
  const e: FakeEl = { dataset: key ? { rowKey: key } : {}, focus() { e.focused = true }, closest: () => (key ? e : null) }
  return e
}

test('focusKeyOf: reads the row key of the focused element, null for an unkeyed element or nothing', () => {
  assert.equal(focusKeyOf(fakeEl('s:1') as never), 's:1')
  assert.equal(focusKeyOf(fakeEl() as never), null)
  assert.equal(focusKeyOf(null), null)
})

test('restoreFocusByKey: refocuses the keyed row only when focus was lost to the body', () => {
  const body = {} as never
  const target = fakeEl('s:1')
  const container = { querySelector: () => target } as never
  assert.equal(restoreFocusByKey(container, 's:1', body, body), true)
  assert.equal(target.focused, true)
  const other = fakeEl('x')
  const t2 = fakeEl('s:1')
  assert.equal(restoreFocusByKey({ querySelector: () => t2 } as never, 's:1', other as never, body), false, 'never steals focus from another element')
  assert.equal(t2.focused, undefined)
  assert.equal(restoreFocusByKey({ querySelector: () => null } as never, 's:1', body, body), false, 'row gone')
  assert.equal(restoreFocusByKey(container, null, body, body), false)
})

test('restoreFocusByKey: a key with quotes cannot break out of the selector', () => {
  let seen = ''
  const container = { querySelector: (s: string) => { seen = s; return null } } as never
  restoreFocusByKey(container, 'a"]x', {} as never, {} as never)
  assert.ok(!seen.includes('a"]x'), seen)
})
