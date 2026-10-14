// #410: the notice naming the open panels a one-at-a-time sheet hides.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import axe from 'axe-core'
import { HiddenPanelsNotice } from '@/components/agent-visualizer/hidden-panels-notice'
import { dockStore } from '@/lib/panel-layout'

const win = window as unknown as { innerWidth: number; innerHeight: number }

function setViewport(w: number, h: number) {
  win.innerWidth = w
  win.innerHeight = h
  act(() => dockStore.measure())
}

beforeEach(() => {
  document.documentElement.style.setProperty('--topbar-h', '68px')
  setViewport(1600, 900)
})
afterEach(() => {
  act(() => { for (const id of ['detail', 'system', 'link', 'files', 'conversation', 'timeline'] as const) dockStore.setOpen(id, false) })
  cleanup()
  document.body.replaceChildren()
  setViewport(1280, 800)
})

const region = (r: ReturnType<typeof render>) => r.getByRole('status')

test('the status region is always mounted and empty in dock mode', () => {
  const r = render(<HiddenPanelsNotice />)
  act(() => { dockStore.setOpen('files', true); dockStore.setOpen('timeline', true) })
  assert.equal(dockStore.getSnapshot().layout.mode, 'dock')
  assert.equal(region(r).textContent, '')
})

test('in sheet mode it names exactly the hidden panels, in opening order', () => {
  const r = render(<HiddenPanelsNotice />)
  setViewport(390, 844)
  act(() => { dockStore.setOpen('conversation', true); dockStore.setOpen('timeline', true); dockStore.setOpen('link', true) })
  assert.equal(region(r).textContent, '2 panels hidden: Conversation, Timeline. Close the panel shown to see Timeline.')
})

test('Context, which takes the Files slot, is named Context', () => {
  const r = render(<HiddenPanelsNotice contextOpen />)
  setViewport(390, 844)
  act(() => { dockStore.setOpen('files', true); dockStore.setOpen('timeline', true) })
  assert.equal(region(r).textContent, '1 panel hidden: Context. Close the panel shown to see it.')
})

test('the text is cleared again when the sheet shows the only open panel', () => {
  const r = render(<HiddenPanelsNotice />)
  setViewport(390, 844)
  act(() => { dockStore.setOpen('files', true); dockStore.setOpen('timeline', true) })
  assert.ok(region(r).textContent)
  act(() => dockStore.setOpen('timeline', false))
  assert.equal(region(r).textContent, '')
})

test('axe finds no violation, empty or filled', async () => {
  const r = render(<main><HiddenPanelsNotice /></main>)
  const opts = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } }
  assert.deepEqual((await axe.run(r.container, opts)).violations.map(v => v.id), [])
  setViewport(390, 844)
  act(() => { dockStore.setOpen('files', true); dockStore.setOpen('timeline', true) })
  assert.ok(region(r as unknown as ReturnType<typeof render>).textContent)
  assert.deepEqual((await axe.run(r.container, opts)).violations.map(v => v.id), [])
})
