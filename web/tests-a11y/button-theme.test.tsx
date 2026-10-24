// #508: the shared Button reads COLORS when it renders, never at module load. After a theme switch, a motion toggle
// (control), a permission button (decision), a tour button and the helper buttonStyle take the new theme's colours.
import { test, afterEach, before } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'

import { vscodeBridge } from '@/lib/vscode-bridge'
import { setLocaleChoice } from '@/lib/locale'
import { COLORS, refreshColors } from '@/lib/colors'
import { applyThemeToDocument } from '@/lib/theme-dom'
import { DEFAULT_THEME } from '@/lib/theme-tokens'
import { paletteFor } from '@/lib/theme-palette'
import { DEFAULT_CALM_LAYERS } from '@/lib/motion-layers'
import { GUIDED_STEPS } from '@/lib/guided-steps'
import { Button, buttonStyle } from '@/components/ui/button'
import { MotionLayerControls } from '@/components/agent-visualizer/motion-layer-controls'
import { GuidedTourCard } from '@/components/agent-visualizer/guided-tour-card'
import { PermissionRequests } from '@/components/agent-visualizer/permission-requests'

const noop = () => {}
const OTHER = 'contrast' as const

before(() => { setLocaleChoice('en') })
afterEach(() => { cleanup(); document.body.replaceChildren(); applyThemeToDocument(DEFAULT_THEME); refreshColors(DEFAULT_THEME) })

function switchTheme() {
  assert.notEqual(paletteFor(OTHER).panelBg, paletteFor(DEFAULT_THEME).panelBg, 'the test needs a theme with another panelBg')
  applyThemeToDocument(OTHER)
  refreshColors(OTHER)
}

/** The colour as the DOM serialises it in a style attribute */
function css(c: string): string {
  const el = document.createElement('div')
  el.style.color = c
  return el.style.color
}

test('motion toggles take the colours of the current theme', () => {
  switchTheme()
  const view = render(<MotionLayerControls locale="en" calm={DEFAULT_CALM_LAYERS} lock={null} onToggle={noop} />)
  const style = view.container.querySelector('button')!.getAttribute('style')!
  assert.ok(style.includes(css(COLORS.panelBg)), 'background is the theme panelBg')
  assert.ok(style.includes(css(COLORS.controlBorder)), 'border is the theme controlBorder')
  assert.ok(style.includes(css(COLORS.textPrimary)), 'text is the theme textPrimary')
})

test('tour buttons and buttonStyle() take the colours of the current theme', () => {
  switchTheme()
  const view = render(<GuidedTourCard steps={GUIDED_STEPS} index={1} onNext={noop} onPrev={noop} onGoTo={noop} onExit={noop} />)
  assert.ok(view.container.querySelector('button')!.getAttribute('style')!.includes(css(COLORS.panelBg)))
  assert.equal(buttonStyle('control')!.background, COLORS.panelBg)
  assert.notEqual(buttonStyle('control'), buttonStyle('control'), 'a fresh object each call')
  const bare = render(<Button variant="control">x</Button>)
  assert.ok(bare.container.querySelector('button')!.getAttribute('style')!.includes(css(COLORS.controlBorder)))
})

test('permission buttons take the colours of the current theme', async () => {
  vscodeBridge!.configureWebviewApi(noop)
  switchTheme()
  const NONCE = '0123456789abcdef0123456789abcdef'
  const view = render(<PermissionRequests sessionLabel={() => 'fix login'} />)
  await act(() => { vscodeBridge!.dispatch({ type: 'permission-request', request: {
    sessionId: 'sess-1', toolUseId: 'toolu_01', nonce: NONCE, toolName: 'Bash', inputPreview: '{"command":"npm test"}',
    inputTruncated: false, inputSha256: 'a'.repeat(64), requestedAt: 0, expiresAt: Date.now() + 600_000,
  } }) })
  const style = view.getByRole('button', { name: /^Approve/ }).getAttribute('style')!
  assert.ok(style.includes(css(COLORS.textPrimary)), 'text colour follows the theme')
  assert.ok(style.includes(css(COLORS.controlBorder)), 'border follows the theme')
})
