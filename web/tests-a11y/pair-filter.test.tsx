// Pair filter (issues #41, #32): removable chip, keyboard path, polite announcement and empty state, shared
// between the Conversation panel and the timeline.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { TimelinePanel } from '@/components/agent-visualizer/timeline-panel'
import { clearPair, getPair } from '@/lib/pair-filter-store'
import { ConversationHarness, createPanelRegistry } from './conversation-harness'
import type { Agent } from '@/lib/agent-types'
import type { ConversationMessage, AgentLink } from '@/hooks/simulation/types'

beforeEach(() => clearPair())
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  clearPair()
})

const agent = (id: string, name: string, isMain = false) =>
  ({ id, agentKey: id, sessionId: 's', localId: id, displayName: name, name, parentKey: null, state: 'idle', isMain } as unknown as Agent)

const agents = new Map<string, Agent>([
  ['o', agent('o', 'orchestrator', true)],
  ['u', agent('u', 'audit-ux')],
  ['e', agent('e', 'explore')],
])

const msg = (id: string, type: ConversationMessage['type'], timestamp: number, content: string, from?: string, to?: string): ConversationMessage =>
  ({ id, type, timestamp, content, from, to })

const conversations = new Map<string, ConversationMessage[]>([
  ['o', [msg('a1', 'assistant', 1, 'plan the work'), msg('d1', 'dispatch', 2, 'audit the ux please', 'o', 'u'), msg('d2', 'dispatch', 3, 'explore the repo', 'o', 'e')]],
  ['u', [msg('a2', 'assistant', 4, 'auditing'), msg('r1', 'return', 5, 'ux audit done', 'u', 'o')]],
  ['e', [msg('a3', 'assistant', 6, 'exploring')]],
])
const links = new Map<string, AgentLink>()

function feed(convs = conversations) {
  return render(
    <ConversationHarness registry={createPanelRegistry()} conversations={convs} agents={agents} links={links}
      onAgentClick={() => {}} selectedAgentId={null} />,
  )
}

function expand(r: ReturnType<typeof feed>) {
  fireEvent.click(r.getByRole('button', { name: /Open Conversation/ }))
}

test('selecting two agents shows a removable chip and filters to their exchanges', () => {
  const r = feed()
  expand(r)
  fireEvent.click(r.getByRole('button', { name: 'Filter pair' }))
  fireEvent.change(r.getByLabelText('First agent'), { target: { value: 'o' } })
  fireEvent.change(r.getByLabelText('Second agent'), { target: { value: 'u' } })

  const chip = r.getByRole('group', { name: 'Pair filter: orchestrator and audit-ux' })
  assert.ok(chip.textContent?.includes('orchestrator ↔ audit-ux'))
  assert.ok(r.queryByText('audit the ux please'))
  assert.ok(r.queryByText('ux audit done'))
  assert.equal(r.queryByText('explore the repo'), null)
  assert.equal(r.queryByText('plan the work'), null)

  const clear = r.getByRole('button', { name: 'Clear pair filter' })
  assert.equal(clear.tagName, 'BUTTON')
  fireEvent.click(clear)
  assert.equal(r.queryByRole('group', { name: /Pair filter/ }), null)
  assert.ok(r.queryByText('explore the repo'))
  assert.equal(getPair().a, '')
})

test('keyboard path: a communication row has a Filter pair button (no pointer, no Shift needed)', () => {
  const r = feed()
  expand(r)
  const btn = r.getAllByRole('button', { name: /^Filter pair orchestrator -> audit-ux/ })[0]
  btn.focus()
  fireEvent.click(btn)
  assert.deepEqual(getPair(), { a: 'o', b: 'u' })
  assert.ok(r.getByRole('group', { name: 'Pair filter: orchestrator and audit-ux' }))
})

test('Shift-click on a tab after clicking another tab filters on the pair', () => {
  const r = feed()
  expand(r)
  fireEvent.click(r.getByRole('tab', { name: /^orchestrator/ }))
  fireEvent.click(r.getByRole('tab', { name: /^audit-ux/ }), { shiftKey: true })
  assert.deepEqual(getPair(), { a: 'o', b: 'u' })
})

test('the change is announced politely and an empty pair shows its own empty text', () => {
  const r = feed()
  expand(r)
  fireEvent.click(r.getByRole('button', { name: 'Filter pair' }))
  fireEvent.change(r.getByLabelText('First agent'), { target: { value: 'u' } })
  fireEvent.change(r.getByLabelText('Second agent'), { target: { value: 'e' } })
  const live = r.container.querySelector('[role="status"][aria-live="polite"]')!
  assert.match(live.textContent ?? '', /No messages between audit-ux and explore/)
  assert.ok(r.getAllByText('No messages between audit-ux and explore').length >= 1)
})

test('the open panel lists only the exchanged messages (the former transcript view of the pair)', () => {
  const withPeer = new Map(conversations)
  withPeer.set('o', conversations.get('o')!.concat([msg('m1', 'message', 7, 'peer note', 'o', 'e')]))
  const r = feed(withPeer)
  expand(r)
  assert.ok(r.queryByText('plan the work'))
  fireEvent.click(r.getByRole('button', { name: 'Filter pair' }))
  fireEvent.change(r.getByLabelText('First agent'), { target: { value: 'o' } })
  fireEvent.change(r.getByLabelText('Second agent'), { target: { value: 'u' } })
  assert.ok(r.getByRole('group', { name: 'Pair filter: orchestrator and audit-ux' }))
  assert.equal(r.queryByText('plan the work'), null)
  assert.equal(r.queryByText('peer note'), null)
  assert.ok(r.queryByText('audit the ux please'))
  fireEvent.click(r.getByRole('button', { name: 'Clear pair filter' }))
  assert.ok(r.queryByText('plan the work'))
})

test('the timeline has no panel-level Escape handler and lists kind / from / to in the table', () => {
  const entries = new Map([
    ['o', { id: 'o', agentId: 'o', agentName: 'orchestrator', startTime: 0, blocks: [] }],
    ['u', { id: 'u', agentId: 'u', agentName: 'audit-ux', startTime: 1, blocks: [] }],
  ])
  const tlLinks = new Map<string, AgentLink>([
    ['l', { id: 'l', from: 'o', to: 'u', kind: 'spawn', sessionId: 's', dropped: 0, messages: [msg('d1', 'dispatch', 2, 'audit please', 'o', 'u')] } as unknown as AgentLink],
  ])
  let closed = 0
  const r = render(<TimelinePanel visible timelineEntries={entries as never} currentTime={10} onClose={() => { closed++ }} links={tlLinks} />)
  fireEvent.keyDown(r.getByRole('group', { name: 'Timeline scroll area' }), { key: 'Escape' })
  assert.equal(closed, 0)
  fireEvent.click(r.getByRole('button', { name: 'Table view' }))
  const table = r.getByRole('table', { name: /Messages between agents/ })
  const cells = Array.from(table.querySelectorAll('tbody tr')[0].children).map(c => c.textContent)
  assert.deepEqual(cells.slice(0, 4), ['0:02', 'Dispatch', 'orchestrator', 'audit-ux'])
})
