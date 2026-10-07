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
/** What a browser does for a key on a focused <button>: Enter clicks on keydown, Space on keyup, unless prevented. */
function pressKey(b: HTMLElement, key: 'Enter' | ' '): { prevented: boolean; clicked: boolean } {
  let clicked = false
  const onClick = () => { clicked = true }
  b.addEventListener('click', onClick)
  const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  b.dispatchEvent(down)
  const up = new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true })
  b.dispatchEvent(up)
  if (!down.defaultPrevented && !up.defaultPrevented) b.click()
  b.removeEventListener('click', onClick)
  return { prevented: down.defaultPrevented || up.defaultPrevented, clicked }
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
  // Enter / Space: a native <button> turns them into a click, provided nobody cancels the key event
  assert.deepEqual(pressKey(b, 'Enter'), { prevented: false, clicked: true })
  assert.deepEqual(opened, ['L7'])
  assert.deepEqual(pressKey(b, ' '), { prevented: false, clicked: true })
  assert.deepEqual(opened, ['L7', 'L7'])
  fireEvent.click(b)
  assert.deepEqual(opened, ['L7', 'L7', 'L7'])
  opened.length = 0
  fireEvent.pointerOver(b)
  b.blur()
  assert.deepEqual(holds[holds.length - 1], ['a'], 'still hovered')
  fireEvent.pointerOut(b)
  assert.deepEqual(holds[holds.length - 1], [])
  b.focus()
  syncBubbleButtons(root, [])
  assert.equal(root.querySelectorAll('button').length, 1, 'focus is not lost mid-frame')
  assert.equal(document.activeElement, b)
  assert.notEqual(b.style.visibility, 'hidden', 'visibility:hidden would blur the focused button')
  assert.notEqual(b.style.display, 'none')
  assert.equal(b.style.opacity, '0')
  assert.equal(b.style.pointerEvents, 'none')
  syncBubbleButtons(root, [spec('a', { linkId: 'L7' })])
  assert.equal(b.style.opacity, '')
  assert.equal(b.style.pointerEvents, 'auto')
  syncBubbleButtons(root, [])
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

test('a hovered button that is removed clears the hold (no pointerout is sent for a removed element)', () => {
  const root = layer()
  const holds: Array<{ ids: string[]; keys: string[] }> = []
  attachBubbleLayer(root, { onOpen: () => {}, onHoldChange: (ids, keys) => holds.push({ ids: [...ids], keys: [...keys] }) })
  syncBubbleButtons(root, [spec('a', { linkId: 'L1' })])
  const b = root.querySelector('button') as HTMLButtonElement
  fireEvent.pointerOver(b)
  assert.deepEqual(holds[holds.length - 1], { ids: ['a'], keys: ['a'] })
  syncBubbleButtons(root, [])
  assert.equal(root.querySelectorAll('button').length, 0)
  assert.deepEqual(holds[holds.length - 1], { ids: [], keys: [] }, 'stale hover id cleared on removal')
  root.remove()
})

test('wheel over a bubble is forwarded to the canvas (zoom keeps working)', () => {
  const root = layer()
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  const wheels: Array<{ dy: number; ctrl: boolean }> = []
  canvas.addEventListener('wheel', e => wheels.push({ dy: (e as WheelEvent).deltaY, ctrl: (e as WheelEvent).ctrlKey }))
  attachBubbleLayer(root, { onOpen: () => {}, forwardTarget: () => canvas })
  syncBubbleButtons(root, [spec('a')])
  const b = root.querySelector('button') as HTMLButtonElement
  const ev = new window.WheelEvent('wheel', { deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true })
  b.dispatchEvent(ev)
  assert.deepEqual(wheels, [{ dy: 120, ctrl: true }])
  assert.equal(ev.defaultPrevented, true, 'the page does not scroll or browser-zoom')
  // Without a target the event is left alone
  const other = layer()
  attachBubbleLayer(other, { onOpen: () => {} })
  syncBubbleButtons(other, [spec('z')])
  const ev2 = new window.WheelEvent('wheel', { deltaY: 5, bubbles: true, cancelable: true })
  other.querySelector('button')!.dispatchEvent(ev2)
  assert.equal(ev2.defaultPrevented, false)
  root.remove(); other.remove(); canvas.remove()
})

test('a drag that starts on a bubble pans the canvas; a short press stays a click', () => {
  const root = layer()
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  const seen: string[] = []
  for (const t of ['pointerdown', 'pointermove', 'pointerup']) canvas.addEventListener(t, e => seen.push(`${t}@${(e as MouseEvent).clientX},${(e as MouseEvent).clientY}`))
  const opened: string[] = []
  attachBubbleLayer(root, { onOpen: id => opened.push(id), forwardTarget: () => canvas })
  syncBubbleButtons(root, [spec('a', { linkId: 'L9' })])
  const b = root.querySelector('button') as HTMLButtonElement
  const ptr = (type: string, x: number, y: number) =>
    b.dispatchEvent(new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }))
  // Short press: no forwarding, the click opens the link
  ptr('pointerdown', 10, 10); ptr('pointermove', 12, 11); ptr('pointerup', 12, 11)
  fireEvent.click(b)
  assert.deepEqual(seen, [])
  assert.deepEqual(opened, ['L9'])
  // Drag: the press is replayed at its origin, then follows the pointer; the trailing click is swallowed
  ptr('pointerdown', 10, 10); ptr('pointermove', 40, 30); ptr('pointermove', 60, 30); ptr('pointerup', 60, 30)
  assert.deepEqual(seen, ['pointerdown@10,10', 'pointermove@40,30', 'pointermove@60,30', 'pointerup@60,30'])
  fireEvent.click(b)
  assert.deepEqual(opened, ['L9'], 'a pan does not open the link')
  root.remove(); canvas.remove()
})
