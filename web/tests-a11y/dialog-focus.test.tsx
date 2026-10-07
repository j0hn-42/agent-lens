// Behavioural regression test for the single focus owner between AgentDetailCard and
// SlidingPanel (issue #9): both mounted in the same commit, in either sibling order.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { AgentDetailCard } from '@/components/agent-visualizer/agent-detail-card'
import { SlidingPanel } from '@/components/agent-visualizer/shared-ui'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const agent = {
  id: 'a', name: 'Agent', state: 'idle' as const, tokensUsed: 1, tokensMax: 10, toolCalls: 0, timeAlive: 1,
}

const frames = () => act(async () => { await new Promise(r => setTimeout(r, 80)) })

function Harness({ cardFirst, card, panel, onClose }: { cardFirst: boolean; card: boolean; panel: boolean; onClose: () => void }) {
  const cardEl = card ? <AgentDetailCard agent={agent} onClose={onClose} /> : null
  const panelEl = (
    <SlidingPanel visible={panel} position={{ top: 0, right: 0 }} zIndex={1}>
      <button type="button" data-panel-close>Close panel</button>
    </SlidingPanel>
  )
  return <>{cardFirst ? cardEl : panelEl}{cardFirst ? panelEl : cardEl}</>
}

for (const cardFirst of [true, false]) {
  test(`card and panel opened in the same commit (${cardFirst ? 'card' : 'panel'} first): card keeps focus`, async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const view = render(<Harness cardFirst={cardFirst} card={false} panel={false} onClose={() => {}} />)
    view.rerender(<Harness cardFirst={cardFirst} card panel onClose={() => {}} />)
    await frames()
    const dialog = view.getByRole('dialog')
    assert.equal(document.activeElement, dialog)
  })
}

test('Escape on the card closes it and restores the trigger', async () => {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  let open = true
  const onClose = () => { open = false }
  const view = render(<Harness cardFirst card panel={false} onClose={onClose} />)
  fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' })
  assert.equal(open, false)
  view.rerender(<Harness cardFirst card={false} panel={false} onClose={onClose} />)
  assert.equal(document.activeElement, trigger)
})

test('card closing because focus moved elsewhere does not pull focus back', async () => {
  const prev = document.createElement('button')
  const other = document.createElement('button')
  document.body.append(prev, other)
  prev.focus()
  const view = render(<Harness cardFirst card panel={false} onClose={() => {}} />)
  other.focus()
  view.rerender(<Harness cardFirst card={false} panel={false} onClose={() => {}} />)
  assert.equal(document.activeElement, other)
})

test('standalone panel focuses Close then restores the trigger on close', async () => {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  const view = render(<Harness cardFirst={false} card={false} panel={false} onClose={() => {}} />)
  view.rerender(<Harness cardFirst={false} card={false} panel onClose={() => {}} />)
  await frames()
  assert.equal((document.activeElement as HTMLElement).textContent, 'Close panel')
  view.rerender(<Harness cardFirst={false} card={false} panel={false} onClose={() => {}} />)
  assert.equal(document.activeElement, trigger)
})
