// #247: per-layer motion controls. Named toggle buttons, French first, keyboard operable.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { MotionLayerControls } from '@/components/agent-visualizer/motion-layer-controls'
import { DEFAULT_CALM_LAYERS, MOTION_LAYERS, toggleCalmLayer } from '@/lib/motion-layers'
import { MESSAGES } from '@/lib/messages'

afterEach(() => { cleanup(); document.body.replaceChildren() })

test('one toggle per layer, named from the catalog in the chosen locale, in a labelled group', () => {
  const view = render(<MotionLayerControls locale="fr" calm={DEFAULT_CALM_LAYERS} lock={null} onToggle={() => {}} />)
  const group = view.getByRole('group', { name: MESSAGES.fr['motion.group'] })
  assert.equal(group.getAttribute('lang'), 'fr')
  for (const l of MOTION_LAYERS) {
    const b = view.getByRole('button', { name: MESSAGES.fr[`motion.layer.${l}`] })
    assert.equal(b.getAttribute('aria-pressed'), 'false')
    assert.equal(b.getAttribute('type'), 'button')
  }
})

test('pressing a toggle reports its layer; the pressed state follows the calm layers', () => {
  const seen: string[] = []
  const calm = toggleCalmLayer(DEFAULT_CALM_LAYERS, 'agents')
  const view = render(<MotionLayerControls locale="en" calm={calm} lock={null} onToggle={l => seen.push(l)} />)
  const agents = view.getByRole('button', { name: MESSAGES.en['motion.layer.agents'] })
  assert.equal(agents.getAttribute('aria-pressed'), 'true')
  fireEvent.click(agents)
  assert.deepEqual(seen, ['agents'])
})

test('when the system reduces motion every toggle is pressed, locked, and says why', () => {
  const view = render(<MotionLayerControls locale="en" calm={DEFAULT_CALM_LAYERS} lock="system" onToggle={() => {}} />)
  for (const l of MOTION_LAYERS) {
    const b = view.getByRole('button', { name: MESSAGES.en[`motion.layer.${l}`] }) as HTMLButtonElement
    assert.equal(b.getAttribute('aria-pressed'), 'true')
    assert.equal(b.disabled, true)
    assert.equal(b.getAttribute('title'), MESSAGES.en['motion.lockedBySystem'])
  }
})

test('the lock reason names the button by its current label, in both locales', () => {
  for (const l of ['fr', 'en'] as const) {
    assert.match(MESSAGES[l]['motion.lockedByPause'], /Freeze motion/)
    assert.doesNotMatch(MESSAGES[l]['motion.lockedByPause'], /Pause animations/)
  }
})

test('when Freeze motion is on every toggle is pressed and locked, with its own reason', () => {
  const view = render(<MotionLayerControls locale="fr" calm={DEFAULT_CALM_LAYERS} lock="pause" onToggle={() => {}} />)
  for (const l of MOTION_LAYERS) {
    const b = view.getByRole('button', { name: MESSAGES.fr[`motion.layer.${l}`] }) as HTMLButtonElement
    assert.equal(b.getAttribute('aria-pressed'), 'true')
    assert.equal(b.disabled, true)
    assert.equal(b.getAttribute('title'), MESSAGES.fr['motion.lockedByPause'])
  }
})
