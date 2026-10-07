// Keyboard activation of the buttons laid over the edge bubbles (issue #41), and their mirror in the DOM list.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createElement } from 'react'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { attachBubbleLayer, syncBubbleButtons, bubbleButtonCount, MIN_BUBBLE_TARGET_PX } from '@/components/agent-visualizer/canvas/edge-bubble-dom'
import { GraphA11yList } from '@/components/agent-visualizer/graph-a11y-list'

function layer() {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}
const spec = (key: string, over: Record<string, unknown> = {}) => ({
  key, linkId: 'L1', messageId: key, label: `label ${key}`, x: 10, y: 20, w: 100, h: 40, collapsed: false, ...over,
})

test('bubbles are real buttons with an accessible name, at least 24x24, reused between frames', () => {
  const root = layer()
  syncBubbleButtons(root, [spec('a'), spec('b', { w: 10, h: 10, collapsed: true })])
  const buttons = Array.from(root.querySelectorAll('button'))
  assert.equal(buttons.length, 2)
  assert.ok(buttons.every(b => b.type === 'button' && (b.getAttribute('aria-label') ?? '').startsWith('label ')))
  assert.ok(Number.parseInt(buttons[1].style.width, 10) >= MIN_BUBBLE_TARGET_PX)
  assert.ok(Number.parseInt(buttons[1].style.height, 10) >= MIN_BUBBLE_TARGET_PX)
  syncBubbleButtons(root, [spec('a', { x: 50 })])
  assert.equal(root.querySelectorAll('button').length, 1)
  assert.equal(root.querySelector('button'), buttons[0])
  assert.equal(bubbleButtonCount(root), 1)
  root.remove()
})

test('click opens the link panel; focus and hover hold the bubble; a focused bubble keeps its button', () => {
  const root = layer()
  const opened: string[] = []
  const holds: string[][] = []
  attachBubbleLayer(root, { onOpen: id => opened.push(id), onHoldChange: ids => holds.push([...ids]) })
  syncBubbleButtons(root, [spec('a', { linkId: 'L7' })])
  const b = root.querySelector('button') as HTMLButtonElement
  b.focus()
  assert.equal(document.activeElement, b)
  assert.deepEqual(holds[holds.length - 1], ['a'], 'a focused bubble is held')
  // A native <button> turns Enter / Space into this click
  fireEvent.click(b)
  assert.deepEqual(opened, ['L7'])
  fireEvent.pointerOver(b)
  b.blur()
  assert.deepEqual(holds[holds.length - 1], ['a'], 'still hovered')
  fireEvent.pointerOut(b)
  assert.deepEqual(holds[holds.length - 1], [])
  b.focus()
  syncBubbleButtons(root, [])
  assert.equal(root.querySelectorAll('button').length, 1, 'focus is not lost mid-frame')
  b.blur()
  syncBubbleButtons(root, [])
  assert.equal(root.querySelectorAll('button').length, 0)
  root.remove()
})

test('the DOM list mirrors each link message as a button that opens the link panel', () => {
  const opened: string[] = []
  const model: any = {
    summary: '', agents: [], clusters: [], teams: [], discoveries: [],
    links: [{ id: 'L1', text: 'lead to child link' }],
  }
  const { getByRole } = render(createElement(GraphA11yList, {
    model, communications: [], announcements: [], focusedNode: null,
    onAgentClick: () => {}, onFocusNode: () => {}, onLinkClick: (id: string) => opened.push(id),
    linkMessages: [{ id: 'L1|m1', linkId: 'L1', text: 'lead to child, dispatch: Find the auth code' }],
  } as any))
  const b = getByRole('button', { name: 'lead to child, dispatch: Find the auth code' })
  fireEvent.click(b)
  assert.deepEqual(opened, ['L1'])
  cleanup()
})
