// #594: the "N names hidden" button reads the plan's count every 200 ms. A count that changes between two readings
// (camera moving, a fit from under 35 %, the safe area re-measured) must not make the button appear, go or change:
// no DOM change at all. A steady count shows after the stable delay, with the camera at rest.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import React, { useRef } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { CanvasControls } from '@/components/agent-visualizer/canvas-controls'
import { useHiddenNamesDisplay, HIDDEN_NAMES_POLL_MS } from '@/hooks/use-hidden-names-display'
import { DEFAULT_CALM_LAYERS } from '@/lib/motion-layers'

let countRef: { current: number } = { current: 0 }
let busy = false

function Probe() {
  const ref = useRef(0)
  countRef = ref
  const display = useHiddenNamesDisplay(ref, () => busy)
  return (
    <CanvasControls
      teams={[] as unknown as React.ComponentProps<typeof CanvasControls>['teams']}
      zoomBy={() => {}} doZoomToFit={() => {}} animationsPaused={false} pausedBySystem={false} locale="en"
      calmLayers={DEFAULT_CALM_LAYERS} onToggleCalmLayer={() => {}} neverHide={false} toolExpiryS={300}
      onToggleAnimationsPaused={() => {}} onToggleNeverHide={() => {}} onChangeToolExpiry={() => {}}
      hiddenNames={display} onShowAgentList={() => {}}
    />
  )
}

beforeEach(() => { busy = false; mock.timers.enable({ apis: ['setInterval', 'Date'] }) })
afterEach(() => { cleanup(); mock.timers.reset(); document.body.replaceChildren() })

const read = async (raw: number) => {
  countRef.current = raw
  await act(async () => { mock.timers.tick(HIDDEN_NAMES_POLL_MS); await Promise.resolve() })
}

test('a count alternating 0 / 1 between two readings changes nothing in the DOM', async () => {
  const view = render(<Probe />)
  const mutations: MutationRecord[] = []
  const observer = new MutationObserver(m => mutations.push(...m))
  observer.observe(view.container, { subtree: true, childList: true, characterData: true, attributes: true })
  for (let i = 0; i < 20; i++) await read(i % 2)
  observer.disconnect()
  assert.equal(view.container.querySelector('[data-hidden-names]'), null)
  assert.deepEqual(mutations.map(m => m.type), [])
})

test('shown, an alternating count keeps the button in place and shows no number', async () => {
  const view = render(<Probe />)
  for (let i = 0; i < 4; i++) await read(4)
  const b = view.getByRole('button', { name: '4 names hidden' })
  for (let i = 0; i < 10; i++) {
    await read(i % 2 ? 0 : 5)
    assert.ok(b.isConnected, `reading ${i}: the button stays`)
    assert.ok(!/\d/.test(b.textContent ?? ''), `reading ${i}: no number while unstable ("${b.textContent}")`)
  }
})

test('a steady count appears after the stable delay, not while the camera moves', async () => {
  const view = render(<Probe />)
  busy = true
  for (let i = 0; i < 6; i++) await read(3)
  assert.equal(view.container.querySelector('[data-hidden-names]'), null, 'camera moving: nothing appears')
  busy = false
  await read(3)
  assert.ok(view.getByRole('button', { name: '3 names hidden' }))
})
