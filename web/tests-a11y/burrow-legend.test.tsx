// Burrow view: the legend toggle opens a panel of the rooms and their tools (read from the model), closes with Escape.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'

import { BurrowLegend } from '@/components/agent-visualizer/burrow-legend'
import { BURROW_ROOM_TOOLS } from '@/lib/burrow/burrow-model'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

test('the legend is closed at first and its button says so', () => {
  render(<BurrowLegend />)
  const btn = screen.getByRole('button')
  assert.equal(btn.getAttribute('aria-expanded'), 'false')
  assert.equal(screen.queryByRole('group'), null)
})

test('the legend opens, lists the tools of the model for each room, and closes with its button', () => {
  render(<BurrowLegend />)
  const btn = screen.getByRole('button')
  fireEvent.click(btn)
  assert.equal(btn.getAttribute('aria-expanded'), 'true')
  const panel = screen.getByRole('group')
  for (const tools of Object.values(BURROW_ROOM_TOOLS)) {
    assert.ok(panel.textContent?.includes(tools.join(', ')), tools.join(', '))
  }
  fireEvent.click(btn)
  assert.equal(screen.queryByRole('group'), null)
})

test('Escape on the button closes the legend and leaves the focus there', () => {
  render(<BurrowLegend />)
  const btn = screen.getByRole('button')
  fireEvent.click(btn)
  btn.focus()
  fireEvent.keyDown(btn, { key: 'Escape' })
  assert.equal(screen.queryByRole('group'), null)
  assert.equal(btn.getAttribute('aria-expanded'), 'false')
  assert.equal(document.activeElement, btn)
})

test('Escape inside the panel closes the legend and gives the focus back to the button', () => {
  render(<BurrowLegend />)
  const btn = screen.getByRole('button')
  fireEvent.click(btn)
  const panel = screen.getByRole('group')
  panel.tabIndex = -1
  panel.focus()
  fireEvent.keyDown(panel, { key: 'Escape' })
  assert.equal(screen.queryByRole('group'), null)
  assert.equal(document.activeElement, btn)
})

test('Escape from elsewhere on the page leaves the legend, the focus and the global Escape alone', () => {
  render(<><input aria-label="elsewhere" /><BurrowLegend /></>)
  const btn = screen.getByRole('button')
  fireEvent.click(btn)
  const field = screen.getByLabelText('elsewhere')
  field.focus()
  let reachedWindow = false
  const onWindow = () => { reachedWindow = true }
  window.addEventListener('keydown', onWindow)
  try {
    fireEvent.keyDown(field, { key: 'Escape' })
  } finally {
    window.removeEventListener('keydown', onWindow)
  }
  assert.ok(reachedWindow, 'the window-level Escape still sees the key')
  assert.equal(document.activeElement, field)
  assert.notEqual(screen.queryByRole('group'), null, 'the legend stays open')
})
