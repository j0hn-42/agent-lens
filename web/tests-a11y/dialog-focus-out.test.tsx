// #380 (WCAG 3.2.2 / 2.4.3): moving the focus out of the tool popup or the inspector card is not a request to
// close it. They stay open; Escape, the Close button and a click outside still close them.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { AgentDetailCard } from '@/components/agent-visualizer/agent-detail-card'
import { DetailPopup } from '@/components/agent-visualizer/shared-ui'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const agent = {
  id: 'a', name: 'Agent', state: 'idle' as const, tokensUsed: 1, tokensMax: 10, toolCalls: 0, timeAlive: 1,
}

test('the inspector card stays open when the focus moves to another control', () => {
  const other = document.createElement('button')
  document.body.appendChild(other)
  let closed = 0
  render(<AgentDetailCard agent={agent} onClose={() => { closed++ }} />)
  other.focus()
  assert.equal(closed, 0)
})

test('the tool popup stays open when the focus moves to another control, and Escape still closes it', () => {
  const other = document.createElement('button')
  document.body.appendChild(other)
  let closed = 0
  const view = render(
    <DetailPopup position={{ x: 10, y: 10 }} width={300} estimatedHeight={200} onClose={() => { closed++ }} titleId="t">
      <h2 id="t">Tool</h2>
    </DetailPopup>,
  )
  other.focus()
  assert.equal(closed, 0)
  fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' })
  assert.equal(closed, 1)
})
