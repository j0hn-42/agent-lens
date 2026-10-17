// #410: a tool / discovery popup opened by a click is placed under the permission cards, never over them.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { DetailPopup } from '@/components/agent-visualizer/shared-ui'
import { dockStore, permissionsBand } from '@/lib/panel-layout'

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
