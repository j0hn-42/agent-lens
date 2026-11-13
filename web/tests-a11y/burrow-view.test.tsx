// Burrow view: the keyboard list of agents stays an overlay. With `sr-only focus-within:not-sr-only` the list
// became `position: static` on focus, a flex child beside the stage, and the scene shrank then jumped back.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'

import { BurrowAgentList } from '@/components/agent-visualizer/burrow-agent-list'
import type { BurrowRow } from '@/lib/burrow/burrow-sync'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const rows: BurrowRow[] = [
  { id: 's1:a', name: 'alpha', presence: 'in', room: 'lounge', state: 'idle', stale: false, parentId: null, depth: 0 },
  { id: 's1:b', name: 'beta', presence: 'in', room: 'lounge', state: 'idle', stale: false, parentId: null, depth: 0 },
]

function mount(onHover: (id: string | null) => void = () => {}) {
  return render(
    <BurrowAgentList
      label="Burrow agents"
      rows={rows}
      selectedAgentId={null}
      rowLabel={(r) => r.name}
      onAgentClick={() => {}}
      onAgentHover={onHover}
    />,
  )
}

test('the burrow agent list is named and its buttons are in the tab order', () => {
  mount()
  const list = screen.getByRole('list', { name: 'Burrow agents' })
  assert.notEqual(list.getAttribute('aria-hidden'), 'true')
  assert.equal(list.hasAttribute('inert'), false)
  assert.equal(list.classList.contains('hidden'), false)
  const buttons = screen.getAllByRole('button')
  assert.equal(buttons.length, 2)
  for (const b of buttons) {
    assert.ok(b.tabIndex >= 0, 'each agent button is reachable by Tab')
    b.focus()
    assert.equal(document.activeElement, b)
  }
})

test('focusing a list button keeps the list an absolute overlay: the scene size does not change', () => {
  const hovered: Array<string | null> = []
  mount((id) => hovered.push(id))
  const list = screen.getByRole('list', { name: 'Burrow agents' })
  const before = list.className
  const classes = before.split(/\s+/)
  assert.ok(classes.includes('absolute'), 'the list is positioned absolutely')
  for (const c of classes) {
    // any class that would put the list back in the flow when it takes focus
    assert.ok(!/(^|:)(not-sr-only|static|relative)$/.test(c), `no class turns the list static: ${c}`)
  }
  const button = screen.getByRole('button', { name: 'alpha' })
  fireEvent.focus(button)
  assert.equal(list.className, before, 'focus does not change the list classes')
  assert.deepEqual(hovered, ['s1:a'])
  fireEvent.blur(button)
  assert.equal(list.className, before)
  assert.deepEqual(hovered, ['s1:a', null])
})
