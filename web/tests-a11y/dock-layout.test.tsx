// Dock layout wiring (issue #32): the real panels read their rectangle from the shared layout, expose
// data-canvas-inset, and the right dock is resizable by keyboard and pointer (role="separator").
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { AgentDetailCard } from '@/components/agent-visualizer/agent-detail-card'
import { FileAttentionPanel } from '@/components/agent-visualizer/file-attention-panel'
import { TimelinePanel } from '@/components/agent-visualizer/timeline-panel'
import { LinkPanel } from '@/components/agent-visualizer/link-panel'
import { ToolDetailPopup } from '@/components/agent-visualizer/tool-detail-popup'
import { DockResizer } from '@/components/agent-visualizer/shared-ui'
import { dockStore, intersects, type Rect } from '@/lib/panel-layout'
import type { Agent } from '@/lib/agent-types'
import type { AgentLink } from '@/hooks/simulation/types'

const win = window as unknown as { innerWidth: number; innerHeight: number }

function setViewport(w: number, h: number) {
  win.innerWidth = w
  win.innerHeight = h
  act(() => dockStore.measure())
}

beforeEach(() => {
  document.documentElement.style.setProperty('--topbar-h', '68px')
  setViewport(1600, 900)
  dockStore.setRightWidth(380)
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  setViewport(1280, 800)
})

/** A panel owned by another module, with the rectangle its own CSS gives it (jsdom has no layout). */
function addForeignPanel(attrs: Record<string, string>, rect: Rect) {
  const el = document.createElement('div')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  el.getBoundingClientRect = () => ({ left: rect.x, top: rect.y, width: rect.w, height: rect.h, right: rect.x + rect.w, bottom: rect.y + rect.h, x: rect.x, y: rect.y, toJSON() { return this } }) as DOMRect
  document.body.appendChild(el)
  act(() => dockStore.measure())
  return el
}

const agent = {
  id: 'a', name: 'orchestrator', state: 'thinking' as const, model: 'claude-opus-4', tokensUsed: 1000, tokensMax: 200000,
  toolCalls: 3, timeAlive: 12,
}

test('the agent card sits in the left dock, under the expanded feed (it used to start at y=100 inside it)', () => {
  const feed: Rect = { x: 12, y: 76, w: 320, h: 420 }
  addForeignPanel({ role: 'region', 'aria-label': 'Messages' }, feed)
  const { getByRole } = render(<AgentDetailCard agent={agent} onClose={() => {}} />)
  const dialog = getByRole('dialog')
  assert.equal(dialog.getAttribute('data-canvas-inset'), 'left')
  assert.equal(dialog.getAttribute('data-dock-panel'), 'detail')
  const top = parseFloat(dialog.style.top)
  const left = parseFloat(dialog.style.left)
  const w = parseFloat(dialog.style.width)
  assert.ok(!intersects({ x: left, y: top, w, h: 200 }, feed), `card (${left},${top}) must not overlap the feed`)
  assert.ok(top >= 68, 'never under the top bar')
})

test('files panel: right dock rect, data-canvas-inset=right, resizer follows the shared width', () => {
  const { getByRole, container } = render(
    <FileAttentionPanel visible fileAttention={new Map()} onClose={() => {}} />,
  )
  const root = container.querySelector<HTMLElement>('[data-dock-panel="files"]')!
  assert.equal(root.getAttribute('data-canvas-inset'), 'right')
  assert.equal(root.style.width, '380px')
  assert.equal(parseFloat(root.style.left), 1600 - 12 - 380)
  const sep = getByRole('separator', { name: 'Resize files panel' })
  assert.equal(sep.getAttribute('aria-orientation'), 'vertical')
  assert.equal(sep.getAttribute('aria-valuenow'), '380')
  assert.equal(sep.getAttribute('aria-valuemin'), '280')
  assert.equal(sep.getAttribute('aria-valuemax'), '720')
  assert.equal(sep.getAttribute('tabindex'), '0')
  fireEvent.keyDown(sep, { key: 'ArrowLeft' })
  assert.equal(sep.getAttribute('aria-valuenow'), '396')
  assert.equal(root.style.width, '396px')
  fireEvent.keyDown(sep, { key: 'ArrowLeft', shiftKey: true })
  assert.equal(root.style.width, '460px')
  fireEvent.keyDown(sep, { key: 'ArrowRight', shiftKey: true })
  fireEvent.keyDown(sep, { key: 'ArrowRight' })
  assert.equal(root.style.width, '380px')
  fireEvent.keyDown(sep, { key: 'Home' })
  assert.equal(root.style.width, '280px')
  fireEvent.keyDown(sep, { key: 'End' })
  assert.equal(root.style.width, '720px')
})

test('DockResizer calls onWidthChange with clamped widths for keys and pointer drags', () => {
  const widths: number[] = []
  const { getByRole } = render(
    <div style={{ position: 'relative' }}><DockResizer width={400} onWidthChange={w => widths.push(w)} label="Resize conversation" /></div>,
  )
  const sep = getByRole('separator', { name: 'Resize conversation' })
  fireEvent.keyDown(sep, { key: 'ArrowLeft' })
  fireEvent.keyDown(sep, { key: 'ArrowRight', shiftKey: true })
  fireEvent.keyDown(sep, { key: 'Tab' })
  assert.deepEqual(widths, [416, 336])
  widths.length = 0
  fireEvent.pointerDown(sep, { button: 0, clientX: 1000, pointerId: 1 })
  fireEvent.pointerMove(sep, { clientX: 900, pointerId: 1 })
  fireEvent.pointerMove(sep, { clientX: 5000, pointerId: 1 })
  fireEvent.pointerMove(sep, { clientX: -5000, pointerId: 1 })
  fireEvent.pointerUp(sep, { pointerId: 1 })
  fireEvent.pointerMove(sep, { clientX: 100, pointerId: 1 })
  assert.deepEqual(widths, [500, 280, 720], 'drag left widens, widths are clamped, nothing after pointerup')
})

test('the resizer is not rendered on narrow viewports (sheets)', () => {
  setViewport(600, 800)
  const { queryByRole } = render(<DockResizer width={380} onWidthChange={() => {}} />)
  assert.equal(queryByRole('separator'), null)
})

test('the timeline docks at the bottom, narrowed beside the chat, and exposes the bottom inset only while open', () => {
  setViewport(1024, 640)
  const chat: Rect = { x: 1024 - 12 - 300, y: 640 - 64 - 360, w: 300, h: 360 }
  addForeignPanel({ 'data-companion-panel': '' }, chat)
  const { container, rerender } = render(<TimelinePanel visible timelineEntries={new Map()} currentTime={0} onClose={() => {}} />)
  const root = container.querySelector<HTMLElement>('[data-dock-panel="timeline"]')!
  assert.equal(root.getAttribute('data-canvas-inset'), 'bottom')
  const x = parseFloat(root.style.left)
  const w = parseFloat(root.style.width)
  assert.ok(x + w <= chat.x - 8 + 0.5, `timeline right edge ${x + w} stays left of the chat (${chat.x})`)
  assert.ok(w >= 280)
  rerender(<TimelinePanel visible={false} timelineEntries={new Map()} currentTime={0} onClose={() => {}} />)
  assert.equal(container.querySelector('[data-canvas-inset]'), null, 'a closed timeline reserves nothing')
})

test('below 900px only the newest panel is shown, full width, with a visible Close button; older ones are hidden', () => {
  setViewport(390, 844)
  const view = render(
    <>
      <AgentDetailCard agent={agent} onClose={() => {}} />
      <FileAttentionPanel visible fileAttention={new Map()} onClose={() => {}} />
    </>,
  )
  const card = view.getByRole('dialog', { hidden: true })
  const files = view.container.querySelector<HTMLElement>('[data-dock-panel="files"]')!
  assert.equal(card.style.display, 'none', 'the older panel is hidden')
  assert.equal(files.style.width, `${390 - 16}px`)
  assert.equal(files.style.left, '8px')
  assert.notEqual(files.getAttribute('data-canvas-inset'), 'right')
  const close = view.getAllByRole('button', { name: 'Close' })
  assert.ok(close.length >= 1)
})

test('the link panel stacks above Files in the right dock without overlapping it', () => {
  const link = { id: 'l', source: 'a', target: 'b', messages: [] } as unknown as AgentLink
  const agents = new Map<string, Agent>()
  const view = render(
    <>
      <LinkPanel link={link} agents={agents} onClose={() => {}} />
      <FileAttentionPanel visible fileAttention={new Map()} onClose={() => {}} />
    </>,
  )
  const linkEl = view.container.querySelector<HTMLElement>('[data-dock-panel="link"]')!
  const filesEl = view.container.querySelector<HTMLElement>('[data-dock-panel="files"]')!
  const linkTop = parseFloat(linkEl.style.top)
  const filesTop = parseFloat(filesEl.style.top)
  assert.equal(linkEl.getAttribute('data-canvas-inset'), 'right')
  assert.ok(linkTop >= 68)
  assert.ok(filesTop >= linkTop + 300, `files top ${filesTop} is below the link panel (top ${linkTop} + height)`)
  assert.equal(parseFloat(linkEl.style.left), parseFloat(filesEl.style.left))
})

test('popups are clamped between the top bar and the control bar', () => {
  setViewport(1024, 640)
  const tool = { id: 't', toolName: 'Read', state: 'complete' as const, args: 'a' }
  const { getByRole } = render(<ToolDetailPopup tool={tool} position={{ x: 2000, y: 2000 }} onClose={() => {}} />)
  const d = getByRole('dialog')
  const left = parseFloat(d.style.left)
  const top = parseFloat(d.style.top)
  const width = parseFloat(d.style.width)
  assert.ok(left + width <= 1024 - 8)
  assert.ok(top >= 68)
  assert.ok(top <= 640 - 16 - 56 - 8)
})
