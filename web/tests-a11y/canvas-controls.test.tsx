// Canvas controls (bottom right): a Zoom block of three icon buttons and one "View" button that opens a
// small panel holding the comfort settings. Visible text and accessible names agree (WCAG 2.5.3).
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { CanvasControls, canvasControlsFit } from '@/components/agent-visualizer/canvas-controls'
import { DEFAULT_CALM_LAYERS } from '@/lib/motion-layers'
import { SHORTCUTS } from '@/lib/shortcuts'
import { CAMERA } from '@/lib/canvas-constants'

afterEach(() => { cleanup(); document.body.replaceChildren() })

function setup(over: Partial<React.ComponentProps<typeof CanvasControls>> = {}) {
  const calls: string[] = []
  const props: React.ComponentProps<typeof CanvasControls> = {
    teams: [] as unknown as React.ComponentProps<typeof CanvasControls>['teams'],
    zoomBy: f => calls.push(`zoom:${f}`),
    doZoomToFit: () => calls.push('fit'),
    animationsPaused: false,
    pausedBySystem: false,
    locale: 'en',
    calmLayers: DEFAULT_CALM_LAYERS,
    onToggleCalmLayer: l => calls.push(`calm:${l}`),
    neverHide: false,
    toolExpiryS: 300,
    onToggleAnimationsPaused: () => calls.push('freeze'),
    onToggleNeverHide: () => calls.push('pin'),
    onChangeToolExpiry: e => calls.push(`expiry:${e.target.value}`),
    ...over,
  }
  const view = render(<CanvasControls {...props} />)
  const viewButton = () => view.getByRole('button', { name: 'View' })
  return { view, calls, viewButton }
}

test('Zoom block: three buttons with SVG icons, the right names and tooltips with the existing shortcuts', () => {
  const { view, calls } = setup()
  const group = view.getByRole('group', { name: 'Zoom' })
  const expected: Array<[string, string]> = [['Zoom in', 'Zoom in (+)'], ['Zoom out', 'Zoom out (-)'], ['Fit to view', 'Fit to view (0)']]
  for (const [name, title] of expected) {
    const b = view.getByRole('button', { name })
    assert.ok(group.contains(b), `${name} is in the Zoom group`)
    assert.equal(b.getAttribute('title'), title)
    assert.ok(b.querySelector('svg[aria-hidden="true"]'), `${name} has an SVG icon`)
    assert.equal((b.textContent ?? '').trim(), '', `${name} has no visible text to disagree with its name`)
  }
  fireEvent.click(view.getByRole('button', { name: 'Zoom in' }))
  fireEvent.click(view.getByRole('button', { name: 'Zoom out' }))
  fireEvent.click(view.getByRole('button', { name: 'Fit to view' }))
  assert.deepEqual(calls, [`zoom:${CAMERA.keyboardZoomStep}`, `zoom:${1 / CAMERA.keyboardZoomStep}`, 'fit'])
})

test('the shortcuts quoted in the tooltips exist in the shortcut table (none invented)', () => {
  const handled = new Set(SHORTCUTS.flatMap(s => s.handles ?? []))
  for (const k of ['+', '-', '0']) assert.ok(handled.has(k), `${k} is a graph shortcut`)
})

test('the old labels are gone', () => {
  const { view } = setup()
  for (const n of ['Fit graph to view', 'Pause animations', 'Keep cards visible']) assert.ok(view.queryByRole('button', { name: n }) === null, n)
  assert.ok(view.queryByText(/Expire unanswered/) === null)
})

test('View is one button, closed by default, with the popup state exposed', () => {
  const { view, viewButton } = setup()
  const b = viewButton()
  assert.equal(b.getAttribute('aria-expanded'), 'false')
  assert.ok(b.getAttribute('aria-haspopup'), 'announces a popup')
  assert.equal((b.textContent ?? '').trim(), 'View', 'visible text equals the accessible name')
  assert.ok(view.queryByRole('button', { name: 'Freeze motion' }) === null, 'settings are not in the page while closed')
  assert.ok(view.queryByRole('combobox') === null)
})

test('opening View shows the three settings with names equal to their visible text', () => {
  const { view, viewButton } = setup()
  fireEvent.click(viewButton())
  assert.equal(viewButton().getAttribute('aria-expanded'), 'true')
  const panel = view.getByRole('dialog', { name: 'View settings' })
  assert.equal(viewButton().getAttribute('aria-controls'), panel.id)
  const freeze = view.getByRole('button', { name: 'Freeze motion' })
  const pin = view.getByRole('button', { name: 'Pin cards' })
  const select = view.getByRole('combobox', { name: /^Hide unanswered calls after/ })
  for (const el of [freeze, pin, select]) assert.ok(panel.contains(el))
  assert.match((freeze.textContent ?? '').trim(), /Freeze motion$/)
  assert.match((pin.textContent ?? '').trim(), /Pin cards$/)
  assert.ok(view.getByText('Hide unanswered calls after'))
  assert.ok(view.getByRole('group', { name: 'Calm by layer' }), 'the per-layer motion toggles are kept in the panel')
})

test('the settings keep their callbacks and aria-pressed', () => {
  const { view, calls, viewButton } = setup({ neverHide: true, animationsPaused: true })
  fireEvent.click(viewButton())
  const freeze = view.getByRole('button', { name: 'Freeze motion' })
  const pin = view.getByRole('button', { name: 'Pin cards' })
  assert.equal(freeze.getAttribute('aria-pressed'), 'true')
  assert.equal(pin.getAttribute('aria-pressed'), 'true')
  fireEvent.click(freeze)
  fireEvent.click(pin)
  const select = view.getByRole('combobox') as HTMLSelectElement
  assert.equal(select.value, '300')
  fireEvent.change(select, { target: { value: '60' } })
  assert.deepEqual(calls, ['freeze', 'pin', 'expiry:60'])
})

test('unpressed settings report aria-pressed=false', () => {
  const { view, viewButton } = setup()
  fireEvent.click(viewButton())
  assert.equal(view.getByRole('button', { name: 'Freeze motion' }).getAttribute('aria-pressed'), 'false')
  assert.equal(view.getByRole('button', { name: 'Pin cards' }).getAttribute('aria-pressed'), 'false')
})

test('when the system reduces motion, Freeze motion is pressed, locked and says why', () => {
  const { view, viewButton } = setup({ pausedBySystem: true })
  fireEvent.click(viewButton())
  const freeze = view.getByRole('button', { name: 'Freeze motion' }) as HTMLButtonElement
  assert.equal(freeze.getAttribute('aria-pressed'), 'true')
  assert.equal(freeze.disabled, true)
  assert.equal(freeze.getAttribute('title'), 'Animations are reduced by your system settings')
})

test('Escape closes the panel and gives the focus back to View', () => {
  const { view, viewButton } = setup()
  fireEvent.click(viewButton())
  const pin = view.getByRole('button', { name: 'Pin cards' })
  pin.focus()
  fireEvent.keyDown(pin, { key: 'Escape' })
  assert.ok(view.queryByRole('dialog') === null)
  assert.equal(viewButton().getAttribute('aria-expanded'), 'false')
  assert.ok(document.activeElement === viewButton(), 'focus is back on View')
})

test('a click outside closes the panel; a click inside does not', () => {
  const { view, viewButton } = setup()
  fireEvent.click(viewButton())
  fireEvent.mouseDown(view.getByRole('button', { name: 'Pin cards' }))
  assert.ok(view.queryByRole('dialog'), 'inside click keeps it open')
  fireEvent.mouseDown(document.body)
  assert.ok(view.queryByRole('dialog') === null)
})

test('View toggles: a second click closes the panel', () => {
  const { view, viewButton } = setup()
  fireEvent.click(viewButton())
  fireEvent.mouseDown(viewButton())
  fireEvent.click(viewButton())
  assert.ok(view.queryByRole('dialog') === null)
})

test('the panel follows View in the DOM so Tab goes into it; focus leaving the block closes it', () => {
  const { view, viewButton } = setup()
  fireEvent.click(viewButton())
  const panel = view.getByRole('dialog')
  assert.ok(viewButton().compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING, 'the panel comes after the button')
  const outside = document.createElement('button')
  document.body.appendChild(outside)
  const pin = view.getByRole('button', { name: 'Pin cards' })
  pin.focus()
  fireEvent.blur(pin, { relatedTarget: outside })
  assert.ok(view.queryByRole('dialog') === null)
})

test('in French the labels, names and tooltips come from the catalog', () => {
  const { view, viewButton: _v } = setup({ locale: 'fr' })
  assert.ok(view.getByRole('group', { name: 'Zoom' }))
  assert.equal(view.getByRole('button', { name: 'Zoom avant' }).getAttribute('title'), 'Zoom avant (+)')
  assert.equal(view.getByRole('button', { name: 'Zoom arrière' }).getAttribute('title'), 'Zoom arrière (-)')
  assert.equal(view.getByRole('button', { name: 'Tout afficher' }).getAttribute('title'), 'Tout afficher (0)')
  fireEvent.click(view.getByRole('button', { name: 'Affichage' }))
  assert.ok(view.getByRole('dialog', { name: 'Réglages d’affichage' }))
  assert.ok(view.getByRole('button', { name: 'Figer les animations' }))
  assert.ok(view.getByRole('button', { name: 'Garder les cartes affichées' }))
  assert.ok(view.getByRole('combobox', { name: /^Masquer les appels sans réponse après/ }))
  assert.equal(view.getByRole('button', { name: 'Affichage' }).closest('[lang]')?.getAttribute('lang'), 'fr')
})

// #515: the controls fold into the playback bar when the two bars leave less than their rows. Values measured in Chromium
// on develop @ 270534c (--topbar-h, height of the playback bar): at 320 x 256 the bars leave 18 px, at 256 x 320 38 px.
test('the controls fit between the bars at 320x568, 390x844 and 640x512, not at 320x256 nor 256x320 (#515)', () => {
  const fit = (w: number, h: number, topbarH: number, controlBarH: number) => canvasControlsFit({ viewport: { w, h }, topbarH, controlBarH })
  assert.equal(fit(320, 256, 132, 98), false)
  assert.equal(fit(256, 320, 176, 98), false)
  assert.equal(fit(320, 568, 132, 98), true)
  assert.equal(fit(390, 844, 126, 70), true)
  assert.equal(fit(640, 512, 76, 70), true)
  // One row of 28 px at 768 px and wider
  assert.equal(fit(1280, 190, 76, 70), false)
  assert.equal(fit(1280, 230, 76, 70), true)
})
