// #112: the canvas cost panel sits below the (wrapping) top bar. The totals of the top bar itself are no longer drawn
// (#523): see topbar-counts.test.tsx.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { costPanelTop, costHeaderWraps, fitHeaderTokens } from '@/components/agent-visualizer/canvas/draw-cost'
import { COST_PANEL } from '@/lib/canvas-constants'

test('cost panel top follows the published top bar height', () => {
  assert.equal(costPanelTop('96px'), 96)
  assert.equal(costPanelTop(' 120.5px '), 121)
})

test('cost panel top falls back to the default when the bar height is unknown or smaller', () => {
  assert.equal(costPanelTop(''), COST_PANEL.yStart)
  assert.equal(costPanelTop('abc'), COST_PANEL.yStart)
  assert.equal(costPanelTop('20px'), COST_PANEL.yStart)
})

test('cost panel header puts tokens on a second line when both do not fit side by side (#116)', () => {
  assert.equal(costHeaderWraps(60, 60), false)
  // « $0.069 estimated » + « 11k estimated tokens » dépassaient les 232 px du panneau
  assert.equal(costHeaderWraps(114, 126), true)
})

// #545 review: « ctx tokens » made the wrapped token line wider than the panel (« at least 5.3M estimated ctx tokens »
// is 34 characters, about 225 px at 11 px for a 212 px content width)
const fakeCtx = () => {
  const ctx = { font: '11px monospace', measureText: (s: string) => ({ width: s.length * parseFloat(ctx.font) * 0.602 }) }
  return ctx as unknown as CanvasRenderingContext2D
}

test('the token line of the cost panel header never leaves the panel, whatever its qualifiers', () => {
  const widest = [
    'at least 5.3M estimated ctx tokens',
    'at least 13M estimated ctx tokens',
    'at least 130M estimated ctx tokens',
    '11k ctx tokens',
  ]
  const inner = COST_PANEL.width - COST_PANEL.contentPadding * 2
  for (const text of widest) {
    const ctx = fakeCtx()
    const fit = fitHeaderTokens(ctx, text, inner)
    ctx.font = fit.font
    assert.ok(ctx.measureText(fit.text).width <= inner, `"${fit.text}" (${fit.font}) is ${ctx.measureText(fit.text).width} px for ${inner} px`)
    assert.equal(fit.text, text, 'the whole sentence is kept, a smaller font makes it fit')
    assert.ok(parseFloat(fit.font) >= 9, `${fit.font}: still readable`)
  }
})

test('a token line too long even at the smallest size is cut with an ellipsis, never drawn past the panel', () => {
  const inner = COST_PANEL.width - COST_PANEL.contentPadding * 2
  const ctx = fakeCtx()
  const fit = fitHeaderTokens(ctx, 'at least 1234567890123M estimated ctx tokens, and more words than a panel holds', inner)
  ctx.font = fit.font
  assert.ok(ctx.measureText(fit.text).width <= inner)
  assert.ok(fit.text.endsWith('…'))
})
