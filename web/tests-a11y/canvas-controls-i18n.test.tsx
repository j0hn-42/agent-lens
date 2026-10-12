// #247: the canvas controls (zoom group, View button and its panel) come from the catalog.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { CanvasControls } from '@/components/agent-visualizer/canvas-controls'
import { TOOL_EXPIRY_CHOICES_S } from '@/lib/canvas-constants'
import { DEFAULT_CALM_LAYERS } from '@/lib/motion-layers'
import { MESSAGES, translate, type Locale } from '@/lib/messages'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const noop = () => {}
function controls(locale: Locale, over: Partial<React.ComponentProps<typeof CanvasControls>> = {}) {
  return (
    <CanvasControls
      teams={[]} zoomBy={noop} doZoomToFit={noop} animationsPaused={false} pausedBySystem={false}
      locale={locale} calmLayers={DEFAULT_CALM_LAYERS} onToggleCalmLayer={noop}
      neverHide={false} toolExpiryS={120} onToggleAnimationsPaused={noop} onToggleNeverHide={noop} onChangeToolExpiry={noop}
      {...over}
    />
  )
}

for (const locale of ['fr', 'en'] as const) {
  test(`every control is named from the catalog in ${locale}`, () => {
    const m = MESSAGES[locale]
    const view = render(controls(locale))
    assert.ok(view.getByRole('group', { name: m['controls.zoomGroup'] }))
    for (const name of [m['controls.zoomIn'], m['controls.zoomOut'], m['controls.fit']]) {
      assert.ok(view.getByRole('button', { name }), name)
    }
    assert.equal(view.getByRole('button', { name: m['controls.fit'] }).getAttribute('title'), `${m['controls.fit']} (0)`)
    fireEvent.click(view.getByRole('button', { name: m['controls.view'] }))
    assert.ok(view.getByRole('dialog', { name: m['controls.viewSettings'] }))
    assert.equal(view.getByRole('button', { name: m['controls.pause'] }).getAttribute('aria-pressed'), 'false')
    assert.equal(view.getByRole('button', { name: m['controls.keepCards'] }).getAttribute('aria-pressed'), 'false')
    const select = view.getByRole('combobox', { name: m['controls.expireAfter'] }) as HTMLSelectElement
    assert.equal(select.value, '120')
    assert.deepEqual(
      Array.from(select.options).map(o => o.textContent),
      TOOL_EXPIRY_CHOICES_S.map(n => (n >= 60 ? translate(locale, 'controls.minutes', { n: n / 60 }) : translate(locale, 'controls.seconds', { n }))),
    )
    assert.ok(view.getByRole('group', { name: m['motion.group'] }))
  })
}

test('the lock reason on Freeze motion follows the locale', () => {
  const view = render(controls('fr', { pausedBySystem: true }))
  fireEvent.click(view.getByRole('button', { name: MESSAGES.fr['controls.view'] }))
  const pause = view.getByRole('button', { name: MESSAGES.fr['controls.pause'] }) as HTMLButtonElement
  assert.equal(pause.disabled, true)
  assert.equal(pause.getAttribute('title'), MESSAGES.fr['motion.lockedBySystem'])
})

test('the controls block declares its language', () => {
  const view = render(controls('fr'))
  assert.equal(view.getByRole('button', { name: MESSAGES.fr['controls.view'] }).closest('[lang]')?.getAttribute('lang'), 'fr')
})
