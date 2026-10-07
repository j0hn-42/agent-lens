// Tool detail popup (#49, #50): every outcome has its own wording, an unobserved end carries a
// caveat, and a missing / estimated token figure is never shown as an exact number.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { ToolDetailPopup } from '@/components/agent-visualizer/tool-detail-popup'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const base = { id: 't1', toolName: 'Bash', args: 'sleep 99' }
const show = (tool: Partial<React.ComponentProps<typeof ToolDetailPopup>['tool']>) =>
  render(<ToolDetailPopup tool={{ ...base, state: 'complete', ...tool }} position={{ x: 10, y: 10 }} onClose={() => {}} />)

test('each lifecycle state shows its own label', () => {
  const labels: Array<[React.ComponentProps<typeof ToolDetailPopup>['tool']['state'], string]> = [
    ['running', 'Running'], ['complete', 'Completed'], ['error', 'Failed'], ['cancelled', 'Cancelled'], ['expired', 'Expired'],
  ]
  for (const [state, label] of labels) {
    const { getByRole, unmount } = show({ state })
    assert.match(getByRole('dialog').textContent ?? '', new RegExp(label))
    unmount()
  }
})

test('an expired call says its end was not observed and shows no invented result', () => {
  const { getByRole, queryByRole } = show({ state: 'expired', endObserved: false })
  assert.match(getByRole('note').textContent ?? '', /fin non observée/)
  assert.equal(queryByRole('region', { name: 'Tool result' }), null)
})

test('a result reported without an observed end carries the caveat', () => {
  const { getByRole } = show({ state: 'complete', endObserved: false, result: 'maybe done' })
  assert.match(getByRole('note').textContent ?? '', /fin non observée/)
  assert.match(getByRole('region', { name: 'Tool result' }).textContent ?? '', /unconfirmed/)
})

test('an observed completion has no caveat', () => {
  const { queryByRole } = show({ state: 'complete', endObserved: true, result: 'ok' })
  assert.equal(queryByRole('note'), null)
})

test('tokens: absent is "non renseigné", never 0; an estimate is badged; an exact 0 stays 0', () => {
  const absent = show({ tokenCost: null })
  assert.match(absent.getByRole('dialog').textContent ?? '', /tokens non renseigné/)
  assert.doesNotMatch(absent.getByRole('dialog').textContent ?? '', /\b0 tokens/)
  absent.unmount()
  const estimated = show({ tokenCost: 120, tokenSource: 'estimated' })
  assert.match(estimated.getByRole('dialog').textContent ?? '', /120 tokens estimé/)
  estimated.unmount()
  const exact = show({ tokenCost: 0, tokenSource: 'reported' })
  assert.match(exact.getByRole('dialog').textContent ?? '', /0 tokens(?! estimé)/)
})
