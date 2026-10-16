// #410: the notice naming the open panels a one-at-a-time sheet hides.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import axe from 'axe-core'
import { HiddenPanelsNotice, UnderTopbarStack } from '@/components/agent-visualizer/hidden-panels-notice'
import { dockStore, TOPBAR_STACK_TOP, TOPBAR_STACK_GAP, BANNER_MIN_TOP } from '@/lib/panel-layout'

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

// #453: the notice and the truncation banner share one column under the top bar, so the banner can never cover the notice
test('the stack puts the banner right under the notice, in that order, and keeps its own slot when no notice is drawn', () => {
  const r = render(<UnderTopbarStack banner={<div data-truncation-banner="">banner</div>} />)
  const stack = r.container.querySelector<HTMLElement>('[data-topbar-stack]')!
  assert.ok(stack, 'one container')
  assert.equal(stack.style.top, `${68 + TOPBAR_STACK_TOP}px`)
  const slot = () => stack.querySelector<HTMLElement>('[data-truncation-banner]')!.closest<HTMLElement>('[data-banner-slot]')!
  assert.equal(slot().style.marginTop, `${BANNER_MIN_TOP - TOPBAR_STACK_TOP}px`, 'no notice: the banner keeps the slot under the loading indicator')
  setViewport(390, 844)
  act(() => { dockStore.setOpen('files', true); dockStore.setOpen('timeline', true) })
  const notice = stack.querySelector('[data-hidden-panels-notice]')!
  assert.ok(notice, 'the notice is in the same container')
  assert.ok(notice.compareDocumentPosition(slot()) & Node.DOCUMENT_POSITION_FOLLOWING, 'the banner comes after the notice')
  assert.equal(slot().style.marginTop, `${TOPBAR_STACK_GAP}px`, 'right under the notice')
  assert.notEqual(getComputedStyle(notice).position, 'absolute', 'the notice is in the flow of the column, not placed over it')
})

test('the stack without a banner is only the notice region', () => {
  const r = render(<UnderTopbarStack />)
  assert.equal(r.container.querySelector('[data-truncation-banner]'), null)
  assert.equal(r.getByRole('status').textContent, '')
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
