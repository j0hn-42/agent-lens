// #369: the canvas notice shown when every agent is finished and hidden by 'Active only (10 min)' (formerly 'Hide inactive agents').
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'
import { HiddenFinishedNotice } from '@/components/agent-visualizer/hidden-finished-notice'

afterEach(() => { cleanup(); document.body.replaceChildren() })

function mount(count: number, onShow: () => void) {
  return render(
    <main id="target" tabIndex={-1}>
      <HiddenFinishedNotice count={count} onShow={onShow} focusTargetId="target" />
    </main>,
  )
}

test('the notice states the exact count and the button has a name that contains its visible text', () => {
  const r = mount(3, () => {})
  assert.ok(r.getByText('3 finished agents hidden'))
  const b = r.getByRole('button', { name: 'Show finished agents' })
  assert.ok((b.getAttribute('aria-label') ?? '').includes(b.textContent ?? ''), 'label in name (WCAG 2.5.3)')
  assert.ok(mount(1, () => {}).getByText('1 finished agent hidden'))
})

test('activating Show calls onShow and moves the focus to the stable target, not to <body>', () => {
  let shown = 0
  const r = mount(2, () => { shown++ })
  const b = r.getByRole('button', { name: 'Show finished agents' })
  b.focus()
  fireEvent.click(b)
  assert.equal(shown, 1)
  assert.equal(document.activeElement?.id, 'target')
})

test('axe finds no violation in the notice', async () => {
  const r = mount(2, () => {})
  const res = await axe.run(r.container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
  assert.deepEqual(res.violations.map(v => v.id), [])
})
