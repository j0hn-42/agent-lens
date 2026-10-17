// #112: the canvas cost panel sits below the (wrapping) top bar. The totals of the top bar itself are no longer drawn
// (#523): see topbar-counts.test.tsx.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { costPanelTop, costHeaderWraps } from '@/components/agent-visualizer/canvas/draw-cost'
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
