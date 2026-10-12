// Context window gauge (#364): the inspector names the gauge "Context window" (the Context panel is something else)
// and says "assumed" next to a window that is a fallback, never a bare "/ 200k" that reads as a fact.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, within } from '@testing-library/react'

import { AgentDetailCard } from '@/components/agent-visualizer/agent-detail-card'
import { createFreshnessClock } from '@/hooks/use-freshness-clock'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const NOW = 1_700_000_000_000
const clock = createFreshnessClock({ now: () => NOW, isHidden: () => true })
const base = {
  id: 's1:main', name: 'Main', state: 'thinking' as const, tokensUsed: 190_000, tokenStatus: 'available' as const,
  tokensMax: 200_000, toolCalls: 0, timeAlive: 1, lastEventAt: NOW, freshnessSource: 'live' as const,
}
const noop = () => {}

test('the gauge is labelled "Context window" and shows a known window as is', () => {
  const v = render(<AgentDetailCard agent={{ ...base, tokensMaxAssumed: false }} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  const d = within(v.getByRole('dialog'))
  assert.ok(d.getByText('Context window'))
  assert.equal(d.getByTestId('inspector-context').textContent, '190k / 200k (95%)')
})

test('an assumed window says so next to the number and the percentage', () => {
  const v = render(<AgentDetailCard agent={{ ...base, tokensMaxAssumed: true }} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.getByTestId('inspector-context').textContent, '190k / 200k assumed (95% of an assumed window)')
})
