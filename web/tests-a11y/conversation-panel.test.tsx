// The unified Conversation panel (issue #32): pill and open panel, agent preset, one truncation rule,
// search, tool calls, jump-to-bottom, role labels per runtime, focus return and the Escape registration.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { clearPair } from '@/lib/pair-filter-store'
import { COLLAPSED_TEXT_MAX } from '@/lib/feed-utils'
import type { Agent } from '@/lib/agent-types'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { ConversationHarness, createPanelRegistry } from './conversation-harness'

beforeEach(() => clearPair())
afterEach(() => { cleanup(); document.body.replaceChildren(); clearPair() })

const agent = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, agentKey: id, sessionId: 's', localId: id, displayName: name, name, parentKey: null, state: 'idle', isMain: false, ...extra } as unknown as Agent)

const agents = new Map<string, Agent>([
  ['o', agent('o', 'orchestrator', { isMain: true })],
  ['u', agent('u', 'audit-ux', { state: 'thinking' })],
  ['x', agent('x', 'coder', { runtime: 'codex' })],
])

const msg = (id: string, type: ConversationMessage['type'], timestamp: number, content: string, extra: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ id, type, timestamp, content, ...extra })

const LONG = 'abcdefghij'.repeat(30) // 300 chars
const base = new Map<string, ConversationMessage[]>([
  ['o', [msg('a1', 'assistant', 1, 'plan the work'), msg('t1', 'tool_call', 2, 'Read(file.ts)', { toolName: 'Read' })]],
  ['u', [msg('a2', 'assistant', 4, 'auditing'), msg('d1', 'dispatch', 5, LONG, { from: 'o', to: 'u' })]],
  ['x', [msg('a3', 'assistant', 6, 'coding'), msg('t2', 'tool_result', 7, '< ' + LONG, { toolName: 'Bash' })]],
])

function panel(props: Partial<React.ComponentProps<typeof ConversationHarness>> = {}) {
  const registry = createPanelRegistry()
  const calls = { opened: 0, closed: 0, clicked: [] as (string | null)[] }
  const tree = (extra: Partial<React.ComponentProps<typeof ConversationHarness>> = {}) => (
    <ConversationHarness
      registry={registry} conversations={base} agents={agents} selectedAgentId={null}
      onAgentClick={id => { calls.clicked.push(id) }} onOpened={() => { calls.opened++ }} onClosed={() => { calls.closed++ }}
      {...props} {...extra}
    />
  )
  const r = render(tree())
  return { ...r, registry, calls, retree: (extra: Partial<React.ComponentProps<typeof ConversationHarness>>) => r.rerender(tree(extra)) }
}

const selectedTab = (r: ReturnType<typeof panel>) =>
  r.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')!

test('closed: a pill with the latest message and its role as visible text; clicking it opens the panel', () => {
  const r = panel()
  assert.equal(r.queryByRole('region', { name: 'Conversation' }), null)
  const pill = r.getByRole('button', { name: 'Open Conversation. Latest codex message from coder: coding' })
  // the role is also visible text, named after the runtime of the agent
  assert.ok(Array.from(pill.querySelectorAll('span')).some(s => s.getAttribute('aria-hidden') !== 'true' && s.textContent === 'CODEX'))
  assert.equal(pill.getAttribute('aria-expanded'), 'false')
  fireEvent.click(pill)
  assert.equal(r.calls.opened, 1)
  assert.ok(r.getByRole('region', { name: 'Conversation' }))
  assert.equal(r.queryByRole('button', { name: /^Open Conversation/ }), null, 'the pill is replaced by the panel')
})

test('without any message there is no pill, but an opened panel shows the one empty state', () => {
  const r = panel({ conversations: new Map(), initialOpen: false })
  assert.equal(r.queryByRole('button', { name: /^Open Conversation/ }), null)
  cleanup()
  const open = panel({ conversations: new Map(), initialOpen: true })
  assert.ok(open.getByText('No messages yet'))
})

test('agent preset: a selected agent opens its tab, the header names it, and the list is its own', () => {
  const r = panel({ initialOpen: true, selectedAgentId: 'u' })
  assert.ok((selectedTab(r).textContent ?? '').startsWith('audit-ux'))
  assert.equal(r.getByRole('log').getAttribute('aria-label'), 'Messages from audit-ux')
  assert.ok(r.queryByText('auditing'))
  assert.equal(r.queryByText('plan the work'), null)
  const heading = r.getByRole('heading', { name: 'Conversation' })
  assert.ok(heading.parentElement!.textContent!.includes('audit-ux'), 'the header shows the preset agent')
  // changing the selection moves the preset; clearing it goes back to All
  r.retree({ selectedAgentId: 'o' })
  assert.ok((selectedTab(r).textContent ?? '').startsWith('orchestrator'))
  r.retree({ selectedAgentId: null })
  assert.ok((selectedTab(r).textContent ?? '').startsWith('All'))
  assert.equal(r.getByRole('log').getAttribute('aria-label'), 'Messages from all agents')
})

test('clicking a message row selects its agent through onAgentClick', () => {
  const r = panel({ initialOpen: true })
  fireEvent.click(r.getByText('coding'))
  assert.deepEqual(r.calls.clicked, ['x'])
})

test('one truncation rule: every row collapses at 120 characters with "Show all", and shows the full text on demand', () => {
  const r = panel({ initialOpen: true })
  const hidden = LONG.length - COLLAPSED_TEXT_MAX
  const showAll = r.getAllByRole('button', { name: `Show all (+${hidden} chars)` })
  // the dispatch row (comm), and the tool result row: both use the same limit
  assert.equal(showAll.length, 2)
  const log = r.getByRole('log')
  assert.ok(!(log.textContent ?? '').includes(LONG), 'the full text is not shown while collapsed')
  assert.ok((log.textContent ?? '').includes(LONG.slice(0, COLLAPSED_TEXT_MAX) + '…'))
  assert.ok(!(log.textContent ?? '').includes(LONG.slice(0, COLLAPSED_TEXT_MAX + 1)))
  fireEvent.click(showAll[0])
  assert.ok((log.textContent ?? '').includes(LONG), 'Show all reveals the full text')
  assert.ok(r.getByRole('button', { name: 'Show less' }))
  // text at the limit is never truncated
  cleanup()
  const exact = panel({ initialOpen: true, conversations: new Map([['o', [msg('e1', 'assistant', 1, 'y'.repeat(COLLAPSED_TEXT_MAX))]]]) })
  assert.equal(exact.queryByRole('button', { name: /^Show all/ }), null)
})

test('the role label comes from the message agent runtime (no session-wide CODEX label)', () => {
  const r = panel({ initialOpen: true })
  const log = r.getByRole('log')
  // orchestrator is a Claude agent, coder runs Codex: both labels live side by side
  assert.ok(Array.from(log.querySelectorAll('span')).some(s => s.textContent === 'CLAUDE'))
  assert.ok(Array.from(log.querySelectorAll('span')).some(s => s.textContent === 'CODEX'))
})

test('Tool calls toggle lists or hides tool activity (it follows the transcript and the per-agent chat)', () => {
  const r = panel({ initialOpen: true })
  const toggle = r.getByRole('button', { name: 'Tool calls' })
  assert.equal(toggle.getAttribute('aria-pressed'), 'true')
  assert.ok(r.queryByText('Read'), 'the tool call is listed')
  fireEvent.click(toggle)
  assert.equal(toggle.getAttribute('aria-pressed'), 'false')
  assert.equal(r.queryByText('Read'), null)
  assert.ok(r.queryByText('plan the work'), 'text messages stay')
})

test('search: labelled input, filters by text and tool name, highlights, own empty state, Escape closes it without closing the panel', () => {
  const r = panel({ initialOpen: true })
  const toggle = r.getByRole('button', { name: 'Search messages' })
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  fireEvent.click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  const input = r.getByRole('searchbox', { name: 'Search messages' })
  assert.equal(document.activeElement, input)
  fireEvent.change(input, { target: { value: 'plan' } })
  assert.ok(r.container.querySelector('mark')?.textContent === 'plan')
  assert.equal(r.queryByText('auditing'), null)
  assert.ok(r.getByRole('heading', { name: 'Conversation' }).parentElement!.textContent!.includes('1/'))
  fireEvent.change(input, { target: { value: 'Read' } })
  assert.ok(r.container.querySelector('mark')?.textContent === 'Read', 'tool names are searched')
  fireEvent.change(input, { target: { value: 'zzzz' } })
  assert.ok(r.getByText('No matching messages'))
  fireEvent.keyDown(input, { key: 'Escape' })
  assert.equal(r.queryByRole('searchbox'), null)
  assert.equal(document.activeElement, toggle)
  assert.ok(r.getByRole('region', { name: 'Conversation' }), 'Escape in the search field only closes the search')
  assert.ok(r.queryByText('plan the work'), 'closing the search clears the filter')
})

test('tabs: tablist semantics, roving tabindex, arrow keys, full-name titles', () => {
  const r = panel({ initialOpen: true })
  const list = r.getByRole('tablist', { name: 'Filter messages by agent' })
  const tabs = r.getAllByRole('tab')
  assert.deepEqual(tabs.map(t => t.getAttribute('aria-selected')), ['true', 'false', 'false', 'false'])
  assert.deepEqual(tabs.map(t => t.tabIndex), [0, -1, -1, -1])
  fireEvent.keyDown(list, { key: 'End' })
  assert.equal(selectedTab(r), r.getAllByRole('tab')[3])
  assert.equal(document.activeElement, r.getAllByRole('tab')[3])
  fireEvent.keyDown(list, { key: 'ArrowRight' })
  assert.equal(selectedTab(r), r.getAllByRole('tab')[0], 'wraps around')
  assert.equal(r.getAllByRole('tab')[1].getAttribute('title'), 'orchestrator')
  assert.equal(r.getByRole('tabpanel').getAttribute('aria-labelledby'), r.getAllByRole('tab')[0].id)
})

test('the list is a log with a position in set on every item', () => {
  const r = panel({ initialOpen: true, conversations: new Map([['o', [msg('a1', 'assistant', 1, 'one'), msg('a2', 'assistant', 2, 'two'), msg('a3', 'assistant', 3, 'three')]]]) })
  const log = r.getByRole('log')
  assert.equal(log.getAttribute('aria-live'), 'off')
  const items = r.getAllByRole('listitem')
  assert.deepEqual(items.map(i => i.getAttribute('aria-posinset')), ['1', '2', '3'])
  assert.ok(items.every(i => i.getAttribute('aria-setsize') === '3'))
  assert.equal(log.querySelectorAll('time').length, 3)
})

test('a dropped-messages marker and the session chip appear when relevant', () => {
  const sessionAgents = new Map(agents)
  sessionAgents.set('u', agent('u', 'audit-ux', { sessionId: 's2', sessionLabel: 'other session' }))
  const r = panel({ initialOpen: true, agents: sessionAgents, droppedMessages: new Map([['o', 4]]) })
  assert.ok(r.getByText(/4 older messages dropped/))
  assert.ok(r.getAllByTitle('Session other session').length >= 1, 'a session chip shows when several sessions are present')
})

test('Escape registration: the registry closes the open panel and then falls through', () => {
  const r = panel({ initialOpen: true })
  assert.deepEqual(r.registry.ids(), ['conversation'])
  act(() => { assert.equal(r.registry.escape(), true) })
  assert.equal(r.calls.closed, 1)
  assert.equal(r.queryByRole('region', { name: 'Conversation' }), null)
  act(() => { assert.equal(r.registry.escape(), false) })
  assert.equal(r.calls.closed, 1)
})

test('closing with the close button returns focus to the pill', () => {
  const r = panel()
  fireEvent.click(r.getByRole('button', { name: /^Open Conversation/ }))
  fireEvent.click(r.getByRole('button', { name: 'Close' }))
  assert.equal(r.calls.closed, 1)
  assert.equal(document.activeElement, r.getByRole('button', { name: /^Open Conversation/ }))
})

test('focus that is already elsewhere when the panel closes is not stolen', () => {
  const elsewhere = document.createElement('button')
  document.body.appendChild(elsewhere)
  const r = panel({ initialOpen: true })
  elsewhere.focus()
  act(() => { r.registry.escape() })
  assert.equal(document.activeElement, elsewhere)
})

test('a new message while scrolled up shows a "new messages" jump button that is a native button', () => {
  const many = new Map<string, ConversationMessage[]>([['o', Array.from({ length: 5 }, (_, i) => msg(`m${i}`, 'assistant', i + 1, `message ${i}`))]])
  const r = panel({ initialOpen: true, conversations: many })
  const log = r.getByRole('log')
  // jsdom has no layout: fake a scrolled-up container, then scroll
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(log, 'clientHeight', { configurable: true, value: 100 })
  log.scrollTop = 0
  fireEvent.scroll(log)
  const jump = r.getByRole('button', { name: /Jump to latest|new message/ })
  assert.equal(jump.tagName, 'BUTTON')
  assert.equal(jump.getAttribute('aria-controls'), log.id)
  const more = new Map(many)
  more.set('o', [...many.get('o')!, msg('m9', 'assistant', 9, 'late')])
  r.retree({ conversations: more })
  assert.ok(r.getByRole('button', { name: '1 new message' }))
  assert.equal(r.container.querySelector('[role="status"]:not([aria-live])')?.textContent, '1 new message')
  fireEvent.click(r.getByRole('button', { name: '1 new message' }))
  assert.equal(r.queryByRole('button', { name: /new message/ }), null)
})
