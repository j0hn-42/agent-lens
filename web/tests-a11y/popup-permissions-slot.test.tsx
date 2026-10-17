// #410: a tool / discovery popup opened by a click is placed under the permission cards, never over them.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { DetailPopup } from '@/components/agent-visualizer/shared-ui'
import { dockStore, permissionsBand, measureDockEnv } from '@/lib/panel-layout'

/** Floor of a popup's height (POPUP_MIN_H in panel-layout.ts, not exported). */
const POPUP_MIN_H = 160

afterEach(() => {
  act(() => dockStore.setEnv({ permissionsH: 0 }))
  cleanup()
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
  const cards = document.createElement('div')
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
