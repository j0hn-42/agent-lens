// Feed fixes (issues #12, #41): tab border console error, arrow keys vs pair filter, collapsed pill role cue,
// outside-click behaviour, top-bar-aware position, picker options and the shared live region.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { MessageFeedPanel } from '@/components/agent-visualizer/message-feed-panel'
import { PairFilterChip } from '@/components/agent-visualizer/pair-filter-chip'
import { TimelinePanel } from '@/components/agent-visualizer/timeline-panel'
import { PanelRegistryContext, createPanelRegistry } from '@/hooks/use-panel-registry'
import { clearPair, getPair, setPair } from '@/lib/pair-filter-store'
import { FEED_TOP, pickerAgentIds } from '@/lib/feed-utils'
import type { Agent, TeamSummary } from '@/lib/agent-types'
import type { ConversationMessage, AgentLink } from '@/hooks/simulation/types'

beforeEach(() => clearPair())
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  clearPair()
})

const agent = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, agentKey: id, sessionId: 's', localId: id, displayName: name, name, parentKey: null, state: 'idle', isMain: false, ...extra } as unknown as Agent)

const agents = new Map<string, Agent>([
  ['o', agent('o', 'orchestrator', { isMain: true })],
  ['u', agent('u', 'audit-ux', { teamName: 'alpha', teamColor: '#ff8800' })],
  ['e', agent('e', 'explore', { state: 'complete' })],
])
const teams = new Map<string, TeamSummary>()

const msg = (id: string, type: ConversationMessage['type'], timestamp: number, content: string, from?: string, to?: string): ConversationMessage =>
  ({ id, type, timestamp, content, from, to })

const conversations = new Map<string, ConversationMessage[]>([
  ['o', [msg('a1', 'assistant', 1, 'plan the work'), msg('d1', 'dispatch', 2, 'audit the ux please', 'o', 'u')]],
  ['u', [msg('a2', 'assistant', 4, 'auditing'), msg('r1', 'return', 5, 'ux audit done', 'u', 'o')]],
  ['e', [msg('a3', 'assistant', 6, 'exploring')]],
])
const links = new Map<string, AgentLink>()

function feed() {
  const registry = createPanelRegistry()
  const utils = render(
    <PanelRegistryContext.Provider value={registry.register}>
      <MessageFeedPanel conversations={conversations} agents={agents} links={links} teams={teams}
        onAgentClick={() => {}} selectedAgentId={null} />
    </PanelRegistryContext.Provider>,
  )
  return { ...utils, registry }
}
const expand = (r: ReturnType<typeof feed>) =>
  fireEvent.click(r.getByRole('button', { name: /Expand messages/ }))

function captureConsoleErrors(fn: () => void): string[] {
  const errors: string[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')) }
  try { fn() } finally { console.error = orig }
  return errors
}

test('D5: changing tabs with accent and done tabs logs no conflicting style property error', () => {
  const r = feed()
  expand(r)
  const errors = captureConsoleErrors(() => {
    fireEvent.click(r.getAllByRole('tab')[1])
    fireEvent.keyDown(r.getByRole('tablist'), { key: 'ArrowRight' })
    fireEvent.keyDown(r.getByRole('tablist'), { key: 'ArrowRight' })
    fireEvent.keyDown(r.getByRole('tablist'), { key: 'ArrowLeft' })
  })
  assert.deepEqual(errors.filter(e => /conflicting property|Updating a style property/.test(e)), [])
  // the accent underline and the dashed done style survive
  const ux = r.getByRole('tab', { name: /^audit-ux/ })
  assert.equal(ux.style.borderBottomWidth, '2px')
  assert.equal(ux.style.borderBottomColor, 'rgb(255, 136, 0)')
  const done = r.getByRole('tab', { name: /^explore/ })
  assert.equal(done.style.borderTopStyle, 'dashed')
})

test('D6: arrow-key tab navigation clears the pair filter so tab and list agree', () => {
  const r = feed()
  expand(r)
  act(() => setPair('o', 'u'))
  assert.ok(r.queryByText('audit the ux please'))
  assert.equal(r.queryByText('exploring'), null)
  fireEvent.keyDown(r.getByRole('tablist'), { key: 'ArrowRight' })
  assert.equal(getPair().a, '')
  assert.equal(r.queryByRole('group', { name: /Pair filter/ }), null)
  // the highlighted tab and the list agree: the list is the one of the selected tab, not the pair
  const selected = r.getAllByRole('tab').filter(t => t.getAttribute('aria-selected') === 'true')
  assert.equal(selected.length, 1)
  const owner = selected[0].textContent ?? ''
  const label = r.container.querySelector('[role="log"]')!.getAttribute('aria-label') ?? ''
  assert.equal(owner, 'orchestrator')
  assert.equal(label, 'Messages from orchestrator')
  assert.ok(r.queryByText('plan the work') !== null, 'the selected tab list is shown')
  assert.ok(r.queryByText('auditing') === null, 'other agents are not listed')
})

test('D6: selecting an agent elsewhere (canvas) clears the pair so the highlighted tab and the list agree', () => {
  const registry = createPanelRegistry()
  const tree = (sel: string | null) => (
    <PanelRegistryContext.Provider value={registry.register}>
      <MessageFeedPanel conversations={conversations} agents={agents} links={links} teams={teams}
        onAgentClick={() => {}} selectedAgentId={sel} />
    </PanelRegistryContext.Provider>
  )
  const r = render(tree(null))
  fireEvent.click(r.getByRole('button', { name: /Expand messages/ }))
  act(() => setPair('o', 'e'))
  assert.ok(r.queryByText('explore the repo') || r.queryByRole('group', { name: /Pair filter/ }))
  r.rerender(tree('u'))
  assert.equal(getPair().a, '')
  const selected = r.getAllByRole('tab').filter(t => t.getAttribute('aria-selected') === 'true')
  assert.equal(selected.length, 1)
  assert.ok((selected[0].textContent ?? '').startsWith('audit-ux'))
  assert.equal(r.getByRole('log', { name: /^Messages from / }).getAttribute('aria-label'), 'Messages from audit-ux')
})

test('D6: when the active tab disappears the pair is cleared and the feed falls back to All', () => {
  const registry = createPanelRegistry()
  const tree = (convs: Map<string, ConversationMessage[]>) => (
    <PanelRegistryContext.Provider value={registry.register}>
      <MessageFeedPanel conversations={convs} agents={agents} links={links} teams={teams}
        onAgentClick={() => {}} selectedAgentId={null} />
    </PanelRegistryContext.Provider>
  )
  const r = render(tree(conversations))
  fireEvent.click(r.getByRole('button', { name: /Expand messages/ }))
  fireEvent.click(r.getAllByRole('tab').find(t => (t.textContent ?? '').startsWith('explore'))!)
  assert.equal(r.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')!.textContent?.startsWith('explore'), true)
  act(() => setPair('o', 'u'))
  assert.equal(getPair().a, 'o')
  // 'explore' no longer has any message while other agents still do: its tab vanishes
  const without = new Map(conversations)
  without.delete('e')
  r.rerender(tree(without))
  assert.equal(getPair().a, '', 'the pair is cleared with the vanished tab')
  const selected = r.getAllByRole('tab').filter(t => t.getAttribute('aria-selected') === 'true')
  assert.equal(selected.length, 1)
  assert.equal((selected[0].textContent ?? '').startsWith('All'), true, 'the feed fell back to the All tab')
})

test('a pair set before its messages load announces the real count once they arrive', () => {
  const nameOf = (k: string) => k
  act(() => setPair('o', 'u'))
  const r = render(<PairFilterChip pair={getPair()} nameOf={nameOf} count={0} onClear={() => {}} />)
  assert.match(r.container.querySelector('[role="status"]')!.textContent ?? '', /No messages between o and u/)
  r.rerender(<PairFilterChip pair={getPair()} nameOf={nameOf} count={4} onClear={() => {}} />)
  assert.match(r.container.querySelector('[role="status"]')!.textContent ?? '', /Showing 4 messages between o and u/)
})

test('D7: the collapsed pill shows the role of the last message as visible text', () => {
  const r = feed()
  const pill = r.getByRole('button', { name: /Expand messages/ })
  const visible = Array.from(pill.querySelectorAll('span')).filter(s => s.getAttribute('aria-hidden') !== 'true')
  assert.ok(visible.some(s => (s.textContent ?? '').trim() === 'CLAUDE'), `no visible role label in: ${pill.textContent}`)
})

test('D9: a mousedown outside does not collapse the feed; Escape does and returns focus to the pill', async () => {
  const outside = document.createElement('button')
  document.body.appendChild(outside)
  const r = feed()
  expand(r)
  await new Promise(res => setTimeout(res, 120))
  fireEvent.mouseDown(outside)
  fireEvent.mouseDown(document.body)
  assert.ok(r.getByRole('region', { name: 'Messages' }))
  act(() => { assert.equal(r.registry.escape(), true) })
  assert.equal(r.queryByRole('region', { name: 'Messages' }), null)
  assert.equal(document.activeElement, r.getByRole('button', { name: /Expand messages/ }))
})

test('D4: the pill and the expanded panel are positioned below the top bar variable', () => {
  assert.match(FEED_TOP, /var\(--topbar-h,\s*48px\)/)
  const r = feed()
  const pillWrap = r.getByRole('button', { name: /Expand messages/ }).parentElement!
  assert.equal(pillWrap.style.top, FEED_TOP)
  expand(r)
  assert.equal(r.getByRole('region', { name: 'Messages' }).style.top, FEED_TOP)
})

test('pair picker lists the chosen agents even without messages', () => {
  assert.deepEqual(pickerAgentIds(['a', 'b'], { a: 'z', b: 'a' }), ['a', 'b', 'z'])
  assert.deepEqual(pickerAgentIds(['a'], { a: '', b: '' }), ['a'])
  const r = feed()
  expand(r)
  act(() => setPair('o', 'ghost'))
  fireEvent.click(r.getByRole('button', { name: 'Filter pair' }))
  const second = r.getByLabelText('Second agent') as HTMLSelectElement
  assert.equal(second.value, 'ghost')
})

test('the Filter pair toggle has aria-expanded and no redundant aria-pressed', () => {
  const r = feed()
  expand(r)
  const t = r.getByRole('button', { name: 'Filter pair' })
  assert.equal(t.getAttribute('aria-pressed'), null)
  assert.equal(t.getAttribute('aria-expanded'), 'false')
  fireEvent.click(t)
  assert.equal(t.getAttribute('aria-expanded'), 'true')
})

test('live region: one shared region, announced once, not re-announced when the count changes', async () => {
  const nameOf = (k: string) => k
  const both = (count: number) => (
    <>
      <PairFilterChip pair={getPair()} nameOf={nameOf} count={count} onClear={() => {}} />
      <PairFilterChip pair={getPair()} nameOf={nameOf} count={count} onClear={() => {}} />
    </>
  )
  const r = render(both(1))
  assert.equal(r.container.querySelectorAll('[role="status"]').length, 1)
  act(() => setPair('o', 'u'))
  r.rerender(both(1))
  const region = r.container.querySelector('[role="status"]')!
  const first = region.textContent
  assert.match(first ?? '', /Showing 1 message between o and u/)
  let mutations = 0
  const mo = new MutationObserver(m => { mutations += m.length })
  mo.observe(region, { childList: true, characterData: true, subtree: true })
  r.rerender(both(2))
  r.rerender(both(3))
  await new Promise(res => setTimeout(res, 10))
  mo.disconnect()
  assert.equal(mutations, 0)
  assert.equal(region.textContent, first)
  // a real change of the pair is announced
  act(() => setPair('o', 'e'))
  r.rerender(both(3))
  assert.match(r.container.querySelector('[role="status"]')!.textContent ?? '', /between o and e/)
  act(() => clearPair())
  r.rerender(both(3))
  assert.equal(r.container.querySelector('[role="status"]')!.textContent, 'Pair filter cleared')
})

test('chip clear control is a native, Tab-reachable button that no key handler blocks (Enter / Space activate it natively)', () => {
  const r = feed()
  expand(r)
  act(() => setPair('o', 'u'))
  const clear = r.getByRole('button', { name: 'Clear pair filter' })
  // Native <button type=button>: the browser turns Enter (keydown) and Space (keyup) into a click on it.
  // jsdom does not synthesise that click and @testing-library/user-event is not installed, so what can be
  // guarded here is (1) the element kind, (2) Tab reachability, (3) that nothing cancels the key events.
  assert.equal(clear.tagName, 'BUTTON')
  assert.equal(clear.getAttribute('type'), 'button')
  assert.equal((clear as HTMLButtonElement).disabled, false)
  assert.ok(clear.tabIndex >= 0, `tabIndex ${clear.tabIndex} takes it out of the Tab order`)
  const tabOrder = Array.from(r.container.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]'))
    .filter(el => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled)
  assert.ok(tabOrder.includes(clear), 'the clear button is not in the Tab order')
  assert.ok(!tabOrder.some(el => el.tabIndex > 0), 'positive tabindex would reorder Tab')
  clear.focus()
  assert.equal(document.activeElement, clear)
  // fireEvent returns false when a handler called preventDefault, which would stop the native activation
  assert.equal(fireEvent.keyDown(clear, { key: 'Enter' }), true, 'Enter keydown was cancelled')
  assert.equal(fireEvent.keyDown(clear, { key: ' ' }), true, 'Space keydown was cancelled')
  assert.equal(fireEvent.keyUp(clear, { key: ' ' }), true, 'Space keyup was cancelled')
  assert.equal(getPair().a, 'o', 'a stray key handler cleared the pair on its own')
  // the click a real browser dispatches for those keys clears the pair
  fireEvent.click(clear)
  assert.equal(getPair().a, '')
})

test('the timeline chip clears the shared pair without closing the timeline', () => {
  const entries = new Map([
    ['o', { id: 'o', agentId: 'o', agentName: 'orchestrator', startTime: 0, blocks: [] }],
    ['u', { id: 'u', agentId: 'u', agentName: 'audit-ux', startTime: 1, blocks: [] }],
  ])
  const tlLinks = new Map<string, AgentLink>([
    ['l', { id: 'l', from: 'o', to: 'u', kind: 'spawn', sessionId: 's', dropped: 0, messages: [msg('d1', 'dispatch', 2, 'audit please', 'o', 'u')] } as unknown as AgentLink],
  ])
  let closed = 0
  act(() => setPair('o', 'u'))
  const r = render(<TimelinePanel visible timelineEntries={entries as never} currentTime={10} onClose={() => { closed++ }} links={tlLinks} />)
  assert.ok(r.getByRole('group', { name: 'Pair filter: orchestrator and audit-ux' }))
  fireEvent.keyDown(r.getByRole('group', { name: 'Timeline scroll area' }), { key: 'Escape' })
  assert.equal(closed, 0)
  fireEvent.click(r.getByRole('button', { name: 'Clear pair filter' }))
  assert.equal(getPair().a, '')
  assert.equal(r.queryByRole('group', { name: /Pair filter/ }), null)
  assert.equal(closed, 0)
})
