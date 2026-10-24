// #410: a tool / discovery popup opened by a click is placed under the permission cards, never over them.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { DetailPopup } from '@/components/agent-visualizer/shared-ui'
import { dockStore, permissionsBand, measureDockEnv, POPUP_MIN_H } from '@/lib/panel-layout'

/** Cards added to the body by a test, removed after it */
let cards: HTMLElement | null = null

afterEach(() => {
  act(() => dockStore.setEnv({ permissionsH: 0, permissionsHeadH: 0, permissionsX: undefined, permissionsW: undefined }))
  cleanup()
  cards?.remove()
  cards = null
  document.body.replaceChildren()
})

function popupTop(): number {
  const dlg = document.querySelector<HTMLElement>('[role="dialog"]')!
  return parseFloat(dlg.style.top)
}

test('the popup starts under the permission cards when they are drawn, and under the top bar otherwise', () => {
  act(() => dockStore.setEnv({ viewport: { w: 1280, h: 800 }, topbarH: 68, controlBarH: 56, permissionsH: 0 }))
  render(
    <DetailPopup position={{ x: 900, y: 0 }} width={320} estimatedHeight={200} onClose={() => {}} titleId="t">
      <h2 id="t">Tool</h2>
    </DetailPopup>,
  )
  assert.ok(popupTop() >= 68)
  assert.ok(popupTop() < 68 + permissionsBand(150), 'no cards: no slot kept')
  act(() => dockStore.setEnv({ permissionsH: 150 }))
  assert.ok(popupTop() >= 68 + permissionsBand(150), `popup at ${popupTop()} covers the cards`)
})

test('the measured cards give their horizontal extent, and a popup clear of them is not pushed down; one that overlaps keeps a floor', () => {
  cards = document.createElement('div')
  cards.setAttribute('data-permission-requests', '')
  cards.getBoundingClientRect = () => ({ left: 1140, top: 68, width: 448, height: 700, right: 1588, bottom: 768, x: 1140, y: 68, toJSON: () => ({}) })
  document.body.append(cards)
  const measured = measureDockEnv(document)
  assert.equal(measured.permissionsH, 700)
  assert.equal(measured.permissionsX, 1140)
  assert.equal(measured.permissionsW, 448)
  const env = { viewport: { w: 1600, h: 900 }, topbarH: 68, controlBarH: 56, permissionsH: 700, permissionsX: 1140, permissionsW: 448 }
  act(() => dockStore.setEnv(env))
  render(
    <DetailPopup position={{ x: 300, y: 0 }} width={320} estimatedHeight={200} onClose={() => {}} titleId="t">
      <h2 id="t">Tool</h2>
    </DetailPopup>,
  )
  assert.equal(popupTop(), 68, 'left of the cards: right under the top bar')
  act(() => dockStore.setEnv({ permissionsX: 100, permissionsW: 448 }))
  const dlg = document.querySelector<HTMLElement>('[role="dialog"]')!
  const card = dlg.firstElementChild as HTMLElement
  assert.ok(parseFloat(card.style.maxHeight) >= POPUP_MIN_H, `cards of 700 px leave ${card.style.maxHeight}`)
})

/** Cards as the panel draws them: a title, an intro and a request row with a button, at a given geometry. */
function drawCards(top: number, headH: number, height: number, left = 12, width = 616): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-permission-requests', '')
  const rect = (t: number, h: number) => () => ({ left, top: t, width, height: h, right: left + width, bottom: t + h, x: left, y: t, toJSON: () => ({}) })
  el.getBoundingClientRect = rect(top, height)
  const h2 = document.createElement('h2')
  h2.setAttribute('data-permission-head', '')
  h2.getBoundingClientRect = rect(top, 16)
  const intro = document.createElement('p')
  intro.setAttribute('data-permission-head', '')
  intro.getBoundingClientRect = rect(top + 16, headH - 16)
  const btn = document.createElement('button')
  btn.textContent = 'Approve'
  el.append(h2, intro, btn)
  document.body.append(el)
  cards = el
  return el
}

test('measureDockEnv reads the height of the cards title and intro (#536)', () => {
  drawCards(68, 62, 180)
  assert.equal(measureDockEnv(document).permissionsHeadH, 62)
})

test('focus entering a card under a popup that covers it closes the popup, so the button is not hidden (#536, WCAG 2.4.7)', () => {
  const el = drawCards(68, 62, 216)
  const btn = el.querySelector('button')!
  // 640x360, cards at their 60vh cap: the floor lets the popup cover the lower part of the cards
  act(() => dockStore.setEnv({ viewport: { w: 640, h: 360 }, topbarH: 68, controlBarH: 56, permissionsH: 216, permissionsHeadH: 62, permissionsX: 12, permissionsW: 616 }))
  let closed = 0
  // A real caller unmounts the popup on close
  function Host() {
    const [open, setOpen] = React.useState(true)
    return open ? (
      <DetailPopup position={{ x: 320, y: 0 }} width={320} estimatedHeight={300} onClose={() => { closed++; setOpen(false) }} titleId="t">
        <h2 id="t">Tool</h2>
      </DetailPopup>
    ) : null
  }
  render(<Host />)
  const dlg = document.querySelector<HTMLElement>('[role="dialog"]')!
  const top = parseFloat(dlg.style.top)
  assert.ok(top < 68 + 216, `precondition: the popup covers the cards (top ${top})`)
  act(() => btn.focus())
  assert.equal(closed, 1, 'the popup is closed when focus enters a covered card')
  // #536: the focused button is no longer covered and keeps the focus once the popup is unmounted
  assert.equal(document.querySelector('[role="dialog"]'), null, 'nothing is left over the card')
  assert.equal(document.activeElement, btn, 'the card button keeps the focus')
})

test('focus entering a card does not close a popup that leaves the cards free (#536)', () => {
  const el = drawCards(68, 62, 100)
  act(() => dockStore.setEnv({ viewport: { w: 1280, h: 800 }, topbarH: 68, controlBarH: 56, permissionsH: 100, permissionsHeadH: 62, permissionsX: 12, permissionsW: 616 }))
  let closed = 0
  render(
    <DetailPopup position={{ x: 900, y: 0 }} width={320} estimatedHeight={200} onClose={() => { closed++ }} titleId="t">
      <h2 id="t">Tool</h2>
    </DetailPopup>,
  )
  act(() => el.querySelector('button')!.focus())
  assert.equal(closed, 0)
})
