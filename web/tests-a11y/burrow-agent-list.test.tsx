// Burrow agent list: one Tab stop (roving tabindex), arrow keys move the focus, Enter selects, sessions are grouped.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { BurrowAgentList } from '@/components/agent-visualizer/burrow-agent-list'
import type { BurrowRow } from '@/lib/burrow/burrow-sync'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const row = (id: string, name: string, sessionId?: string): BurrowRow =>
  ({ id, name, presence: 'in', room: 'lounge', state: 'idle', stale: false, parentId: null, depth: 0, sessionId: sessionId ?? 's1' })

function setup(rows: BurrowRow[], onClick: (id: string) => void = () => {}) {
  return render(
    <BurrowAgentList label="Burrow agents" rows={rows} selectedAgentId={null} rowLabel={(r) => r.name}
      groupLabel={(s) => `Session ${s}`} onAgentClick={onClick} onAgentHover={() => {}} />,
  )
}

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-burrow-agent-list] button'))

test('the list is a single Tab stop: one button is tabbable, the others have tabindex -1', () => {
  setup([row('a', 'alpha'), row('b', 'beta'), row('c', 'gamma')])
  assert.deepEqual(buttons().map((b) => b.tabIndex), [0, -1, -1])
})

test('ArrowDown, ArrowUp, Home and End move the focus between rows and the tab stop follows', () => {
  setup([row('a', 'alpha'), row('b', 'beta'), row('c', 'gamma')])
  buttons()[0].focus()
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  assert.equal(document.activeElement?.textContent, 'beta')
  assert.deepEqual(buttons().map((b) => b.tabIndex), [-1, 0, -1])
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  assert.equal(document.activeElement?.textContent, 'gamma')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  assert.equal(document.activeElement?.textContent, 'gamma', 'no wrap past the last row')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
  assert.equal(document.activeElement?.textContent, 'beta')
  fireEvent.keyDown(document.activeElement!, { key: 'Home' })
  assert.equal(document.activeElement?.textContent, 'alpha')
})

test('Enter on the focused row selects it (a button: Enter and Space fire its click)', () => {
  const picked: string[] = []
  setup([row('a', 'alpha'), row('b', 'beta')], (id) => picked.push(id))
  buttons()[0].focus()
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  fireEvent.click(document.activeElement!)
  assert.deepEqual(picked, ['b'])
})

test('a long name is truncated on screen, the title carries it in full', () => {
  const long = 'x'.repeat(120)
  setup([row('a', long)])
  const b = buttons()[0]
  assert.equal(b.title, long)
  assert.ok(b.className.includes('truncate'))
})

test('rows of several sessions are grouped under a session heading; one session has none', () => {
  setup([row('a', 'alpha', 's1'), row('b', 'beta', 's1'), row('c', 'gamma', 's2')])
  const heads = Array.from(document.querySelectorAll('[data-burrow-session]')).map((h) => h.textContent)
  assert.deepEqual(heads, ['Session s1', 'Session s2'])
  assert.equal(buttons().length, 3)
  cleanup()
  setup([row('a', 'alpha', 's1'), row('b', 'beta', 's1')])
  assert.equal(document.querySelectorAll('[data-burrow-session]').length, 0)
})

function listOf(rows: BurrowRow[]) {
  return (
    <BurrowAgentList label="Burrow agents" rows={rows} selectedAgentId={null} rowLabel={(r) => r.name}
      groupLabel={(s) => `Session ${s}`} onAgentClick={() => {}} onAgentHover={() => {}} />
  )
}

test('one session is one flat list: no nested list, no wrapper item', () => {
  setup([row('a', 'alpha'), row('b', 'beta')])
  assert.equal(document.querySelectorAll('[data-burrow-agent-list] ul').length, 0)
  const items = Array.from(document.querySelector('[data-burrow-agent-list]')!.children)
  assert.deepEqual(items.map((li) => li.textContent), ['alpha', 'beta'])
})

test('several sessions: each group is a labelled list in an item that keeps its listitem role', () => {
  setup([row('a', 'alpha', 's1'), row('c', 'gamma', 's2')])
  const inner = Array.from(document.querySelectorAll('[data-burrow-agent-list] ul'))
  assert.deepEqual(inner.map((u) => u.getAttribute('aria-label')), ['Session s1', 'Session s2'])
  for (const u of inner) assert.ok(!u.parentElement!.className.includes('contents'))
})

test('the focused row keeps the focus when an agent of a second session appears, and when it leaves again', () => {
  const { rerender } = render(listOf([row('a', 'alpha', 's1'), row('b', 'beta', 's1')]))
  buttons()[1].focus()
  rerender(listOf([row('a', 'alpha', 's1'), row('b', 'beta', 's1'), row('c', 'gamma', 's2')]))
  assert.equal(document.activeElement?.textContent, 'beta')
  rerender(listOf([row('a', 'alpha', 's1'), row('b', 'beta', 's1')]))
  assert.equal(document.activeElement?.textContent, 'beta')
})

/** jsdom keeps the focus on a node moved in the document; a browser drops it to <body>, as this does */
function withBrowserMoves(run: () => void): void {
  const proto = Node.prototype as unknown as Record<'insertBefore' | 'appendChild', (...args: Node[]) => Node>
  const saved = { insertBefore: proto.insertBefore, appendChild: proto.appendChild }
  const dropFocus = (node: Node) => {
    const active = document.activeElement
    if (node.isConnected && active instanceof HTMLElement && node.contains(active)) active.blur()
  }
  proto.insertBefore = function (this: Node, node: Node, ...rest: Node[]) { dropFocus(node); return saved.insertBefore.call(this, node, ...rest) }
  proto.appendChild = function (this: Node, node: Node) { dropFocus(node); return saved.appendChild.call(this, node) }
  try { run() } finally { Object.assign(proto, saved) }
}

// React DOM gives the focus back to a node it moved during a commit (restoreSelection), so the attention-first order
// does not throw the keyboard out of the list; this pins that behaviour
test('the focused row keeps the focus when the rows are reordered (an agent asks for a permission)', () => {
  const { rerender } = render(listOf([row('a', 'alpha'), row('b', 'beta'), row('c', 'gamma')]))
  buttons()[0].focus()
  withBrowserMoves(() => rerender(listOf([row('c', 'gamma'), row('a', 'alpha'), row('b', 'beta')])))
  assert.equal(document.activeElement?.textContent, 'alpha')
})

test('a reorder does not take the focus when no row had it', () => {
  const outside = document.createElement('button')
  document.body.append(outside)
  const { rerender } = render(listOf([row('a', 'alpha'), row('b', 'beta')]))
  outside.focus()
  rerender(listOf([row('b', 'beta'), row('a', 'alpha')]))
  assert.equal(document.activeElement, outside)
})

// A row of an agent running a tool has a secondary action: Shift+Enter opens that tool call, as a click on its bubble
test('Shift+Enter on a row that carries a running tool call opens it, and is the only key that does', () => {
  const opened: string[] = []
  const picked: string[] = []
  const rows: BurrowRow[] = [{ ...row('a', 'alpha'), state: 'tool_calling', tool: 'Grep', toolCallId: 'tc1' }, row('b', 'beta')]
  render(
    <BurrowAgentList label="Burrow agents" rows={rows} selectedAgentId={null} rowLabel={(r) => r.name}
      groupLabel={(s) => `Session ${s}`} onAgentClick={(id) => picked.push(id)} onAgentHover={() => {}}
      onToolCallClick={(id) => opened.push(id)} toolCallKeyHint="Shift+Enter opens its tool call" />,
  )
  const [a, b] = buttons()
  assert.equal(a.getAttribute('aria-keyshortcuts'), 'Shift+Enter')
  assert.equal(b.getAttribute('aria-keyshortcuts'), null)
  assert.match(a.getAttribute('aria-description') ?? '', /Shift\+Enter opens its tool call/)
  fireEvent.keyDown(a, { key: 'Enter' })
  assert.deepEqual(opened, [], 'plain Enter is the ordinary click')
  assert.equal(fireEvent.keyDown(a, { key: 'Enter', shiftKey: true }), false, 'the key is handled')
  assert.deepEqual(opened, ['tc1'])
  fireEvent.keyDown(b, { key: 'Enter', shiftKey: true })
  assert.deepEqual(opened, ['tc1'], 'a row without a running call does nothing')
  assert.deepEqual(picked, [])
})

test('the rows draw their focus ring inside: the list scrolls (overflow clips both axes), an outer ring would be cut', () => {
  for (const panel of [false, true]) {
    const view = render(
      <BurrowAgentList label="Burrow agents" rows={[row('a', 'alpha'), row('b', 'beta')]} selectedAgentId={null} rowLabel={(r) => r.name}
        groupLabel={(s) => `Session ${s}`} onAgentClick={() => {}} onAgentHover={() => {}} panel={panel} />,
    )
    for (const b of buttons()) {
      for (const cls of FOCUS_RING_INSET.split(/\s+/).filter(Boolean)) assert.ok(b.classList.contains(cls), `${cls} (panel: ${panel})`)
      assert.equal(b.classList.contains('focus-visible:outline-offset-2'), false)
    }
    view.unmount()
  }
})
