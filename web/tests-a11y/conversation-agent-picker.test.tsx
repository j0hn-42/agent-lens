// Agent picker of the Conversation panel (owner's request, option B): from AGENT_PICKER_MIN agents with messages one button
// "Agent: All (n)" replaces the row of tabs. It opens a searchable list (combobox + listbox) grouped by team / workflow,
// session and finished state, with the unread agents said in words. Below the threshold the tabs stay and wrap.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import axe from 'axe-core'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { clearPair, getPair } from '@/lib/pair-filter-store'
import { setLocaleChoice } from '@/lib/locale'
import type { Agent } from '@/lib/agent-types'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { ConversationHarness, createPanelRegistry } from './conversation-harness'

const scrolled: Element[] = []
const proto = HTMLElement.prototype as unknown as { scrollIntoView?: (this: Element) => void }
const originalScroll = proto.scrollIntoView
beforeEach(() => { clearPair(); setLocaleChoice('en'); scrolled.length = 0; proto.scrollIntoView = function (this: Element) { scrolled.push(this) } })
afterEach(() => { cleanup(); document.body.replaceChildren(); clearPair(); setLocaleChoice('en'); proto.scrollIntoView = originalScroll })

const agent = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, agentKey: id, sessionId: 's', localId: id, displayName: name, name, parentKey: null, state: 'idle', isMain: false, ...extra } as unknown as Agent)

const ACTIVE = ['b1', 'b2', 'b3', 'b4']
const DONE = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']
const agents = new Map<string, Agent>([
  ['o', agent('o', 'orchestrator', { isMain: true })],
  ...ACTIVE.map((id, i): [string, Agent] => [id, agent(id, `builder-0${i + 1}`, { teamName: 'mega', teamKind: 'workflow', kind: 'teammate', state: i === 1 ? 'thinking' : 'idle' })]),
  ...DONE.map((id, i): [string, Agent] => [id, agent(id, `done-0${i + 1}`, { teamName: 'mega', teamKind: 'workflow', kind: 'teammate', activity: 'done' })]),
])
const TOTAL = agents.size // 12 agents with messages

const msg = (id: string, type: ConversationMessage['type'], timestamp: number, content: string, extra: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ id, type, timestamp, content, ...extra })
const base = new Map<string, ConversationMessage[]>(
  [...agents.keys()].map((id, i): [string, ConversationMessage[]] => [id, [msg(`${id}-1`, 'assistant', i + 1, `report of ${id}`)]]),
)

function panel(props: Partial<React.ComponentProps<typeof ConversationHarness>> = {}) {
  const registry = createPanelRegistry()
  const tree = (extra: Partial<React.ComponentProps<typeof ConversationHarness>> = {}) => (
    <ConversationHarness registry={registry} conversations={base} agents={agents} selectedAgentId={null}
      onAgentClick={() => {}} initialOpen {...props} {...extra} />
  )
  const r = render(tree())
  return { ...r, registry, retree: (extra: Partial<React.ComponentProps<typeof ConversationHarness>>) => r.rerender(tree(extra)) }
}

const pickerButton = (r: ReturnType<typeof panel>) => r.getByRole('button', { name: /^Agent: / })
const openPicker = (r: ReturnType<typeof panel>) => { fireEvent.click(pickerButton(r)); return r.getByRole('combobox', { name: 'Search agents' }) }
const activeOption = (input: HTMLElement) => document.getElementById(input.getAttribute('aria-activedescendant') ?? '')

async function axeViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)
}

test('from 5 agents with messages one picker button replaces the tabs; its visible text is its name (WCAG 2.5.3)', () => {
  const r = panel()
  assert.equal(r.queryByRole('tablist'), null, 'no row of tabs')
  const button = pickerButton(r)
  assert.equal(button.getAttribute('aria-label'), null, 'named by its content, so the name is the visible text')
  assert.equal(button.textContent, `Agent: All (${TOTAL})`)
  assert.equal(button.getAttribute('aria-haspopup'), 'listbox')
  assert.equal(button.getAttribute('aria-expanded'), 'false')
})

test('opening moves focus to the search field (combobox); groups carry a name; finished agents are folded when many', () => {
  const r = panel()
  const input = openPicker(r)
  assert.equal(document.activeElement, input)
  assert.equal(pickerButton(r).getAttribute('aria-expanded'), 'true')
  const listbox = document.getElementById(input.getAttribute('aria-controls')!)!
  assert.equal(listbox.getAttribute('role'), 'listbox')
  const groups = Array.from(listbox.querySelectorAll('[role="group"]')).map(g => g.getAttribute('aria-label'))
  // The first group holds the agents of no team (here the main agent): it says so, not "not finished" (53 agents of workflow83
  // are not finished, the group held 1)
  assert.deepEqual(groups, ['No team (1)', 'Workflow mega (4)'])
  const toggle = r.getByRole('button', { name: 'Finished (7)' })
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(r.queryByRole('option', { name: /^done-01/ }), null)
  assert.ok(r.getByText(`5 agents of ${TOTAL}`), 'the count says what is listed')
  fireEvent.click(toggle)
  assert.ok(r.getByRole('option', { name: /^done-01 \(Done\)/ }))
  assert.ok(Array.from(listbox.querySelectorAll('[role="group"]')).some(g => g.getAttribute('aria-label') === 'Finished (7)'))
  assert.equal(r.getByRole('button', { name: 'Finished (7)' }).getAttribute('aria-expanded'), 'true')
})

test('Up and Down move the active option, Enter chooses it, closes the list and returns focus to the button', () => {
  const r = panel()
  const input = openPicker(r)
  assert.match(activeOption(input)!.textContent ?? '', /^All/, 'the current choice is the active option on opening')
  // All, then the agents of no team (orchestrator), then the workflow members
  for (let i = 0; i < 3; i++) fireEvent.keyDown(input, { key: 'ArrowDown' })
  assert.match(activeOption(input)!.textContent ?? '', /^builder-02/)
  assert.equal(activeOption(input)!.getAttribute('aria-selected'), 'true')
  fireEvent.keyDown(input, { key: 'ArrowUp' })
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  fireEvent.keyDown(input, { key: 'Enter' })
  assert.equal(r.queryByRole('listbox'), null)
  assert.equal(document.activeElement, pickerButton(r))
  assert.equal(pickerButton(r).textContent, 'Agent: builder-02 (Thinking)')
  assert.equal(r.getByRole('log').getAttribute('aria-label'), 'Messages from builder-02')
})

test('the chosen agent name in the button wraps instead of being cut by an ellipsis (nothing of the choice disappears)', () => {
  const r = panel({ selectedAgentId: 'b2' })
  const button = pickerButton(r)
  const name = button.querySelector('[lang="en"][data-i18n-exempt]')!
  assert.equal(name.textContent, 'builder-02')
  for (const el of [button, ...Array.from(button.querySelectorAll('*'))]) {
    assert.ok(!/\btruncate\b/.test(el.getAttribute('class') ?? ''), `no ellipsis in the button: ${el.outerHTML.slice(0, 80)}`)
  }
  assert.ok(/\bbreak-words\b/.test(name.parentElement!.getAttribute('class') ?? ''), 'the text of the button flows and wraps')
  assert.equal(button.textContent, 'Agent: builder-02 (Thinking)')
})

test('Escape closes the list and returns focus to the button without closing the panel', () => {
  const r = panel()
  const input = openPicker(r)
  fireEvent.keyDown(input, { key: 'Escape' })
  assert.equal(r.queryByRole('listbox'), null)
  assert.equal(document.activeElement, pickerButton(r))
  assert.ok(r.getByRole('region', { name: 'Conversation' }), 'the panel stays open')
  // Tab past the list: focus leaves it, the list closes and the focus stays where it went
  const again = openPicker(r)
  const elsewhere = r.getByRole('button', { name: 'Tool calls' })
  fireEvent.focusOut(again, { relatedTarget: elsewhere })
  assert.equal(r.queryByRole('listbox'), null)
})

test('search: matches names (finished ones too), says how many match, and has its own empty state', () => {
  const r = panel()
  const input = openPicker(r)
  fireEvent.change(input, { target: { value: 'DONE-03' } })
  assert.deepEqual(r.getAllByRole('option').map(o => (o.textContent ?? '').split(' ')[0]), ['done-03'])
  assert.ok(r.getByText(`1 agent of ${TOTAL}`))
  assert.match(activeOption(input)!.textContent ?? '', /^done-03/, 'the first match is active')
  fireEvent.change(input, { target: { value: 'zzz' } })
  assert.equal(r.queryAllByRole('option').length, 0)
  assert.ok(r.getByText('No matching agent'))
})

test('a selection made elsewhere (canvas, sessions list) is shown by the button, and its option is brought into view on opening', () => {
  const r = panel()
  r.retree({ selectedAgentId: 'd5' })
  assert.equal(pickerButton(r).textContent, 'Agent: done-05 (Done)')
  const input = openPicker(r)
  const option = activeOption(input)!
  assert.match(option.textContent ?? '', /^done-05/, 'its option is the active one, the finished group unfolded')
  assert.ok(scrolled.includes(option), 'the option is scrolled into view')
})

test('unread: a pill "n unread" beside the button opens the list on the unread agents, each saying "unread" in words', () => {
  const r = panel({ selectedAgentId: 'b1' })
  const more = new Map(base)
  more.set('b3', [...base.get('b3')!, msg('b3-2', 'assistant', 50, 'late news')])
  r.retree({ selectedAgentId: 'b1', conversations: more })
  // The pill counts agents, not messages: it says so (b3 got one message, but « 1 unread » read as one unread message)
  const pill = r.getByRole('button', { name: '1 agent unread' })
  assert.equal(pill.getAttribute('aria-label'), null)
  assert.equal(pill.textContent, '1 agent unread')
  fireEvent.click(pill)
  const only = r.getByRole('button', { name: 'Unread only' })
  assert.equal(only.getAttribute('aria-pressed'), 'true')
  const options = r.getAllByRole('option')
  assert.equal(options.length, 1)
  // 2 is the agent's total of messages; how many are unread is not known here, so the option never writes « 2 unread messages »
  assert.match(options[0].textContent ?? '', /^builder-03 \(.+\) 2 messages, some unread$/)
  assert.ok(r.getByRole('option', { name: /^builder-03 \(.+\) 2 messages, some unread$/ }))
  fireEvent.click(only)
  assert.ok(r.getAllByRole('option').length > 1, 'turning it off lists every agent again')
})

test('messages that existed before the panel mounted are not counted as unread, even opened on an agent', () => {
  const r = panel({ selectedAgentId: 'b1' })
  assert.equal(r.queryByRole('button', { name: /unread/ }), null, 'no unread pill on mount')
  openPicker(r)
  assert.ok(!r.getAllByRole('option').some(o => /unread/.test(o.textContent ?? '')))
})

test('Shift+Enter on an option filters the pair with the current agent (the Shift-click shortcut without tabs)', () => {
  const r = panel({ selectedAgentId: 'o' })
  const input = openPicker(r)
  fireEvent.change(input, { target: { value: 'builder-01' } })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  assert.deepEqual(getPair(), { a: 'o', b: 'b1' })
  assert.equal(r.queryByRole('listbox'), null)
})

test('Shift-click on an option filters the pair too', () => {
  const r = panel({ selectedAgentId: 'o' })
  openPicker(r)
  fireEvent.click(r.getByRole('option', { name: /^builder-04/ }), { shiftKey: true })
  assert.deepEqual(getPair(), { a: 'o', b: 'b4' })
})

test('every option is named by its visible text plus the words a screen reader needs (state, messages, unread)', () => {
  const r = panel()
  openPicker(r)
  const option = r.getByRole('option', { name: /^builder-02/ })
  assert.equal(option.getAttribute('aria-label'), null, 'named by its content')
  assert.equal(option.textContent, 'builder-02 (Thinking) 1 message')
  const name = r.getByRole('option', { name: 'builder-02 (Thinking) 1 message' })
  assert.equal(name, option)
  assert.equal(option.querySelector('[lang="en"][data-i18n-exempt]')?.textContent, 'builder-02', 'the agent name is data, lang="en"')
})

test('no axe violation with the list open, finished agents shown', async () => {
  const r = panel()
  openPicker(r)
  fireEvent.click(r.getByRole('button', { name: /^Finished/ }))
  assert.deepEqual(await axeViolations(r.container), [])
})

test('French: « Agent : Tous (12) », « Rechercher un agent », groups and count in French', () => {
  setLocaleChoice('fr')
  const r = panel()
  const button = r.getByRole('button', { name: /^Agent : / })
  assert.equal(button.textContent, `Agent : Tous (${TOTAL})`)
  fireEvent.click(button)
  assert.ok(r.getByRole('combobox', { name: 'Rechercher un agent' }))
  assert.equal(r.getByRole('button', { name: 'Terminés (7)' }).getAttribute('aria-expanded'), 'false')
  assert.ok(r.getByRole('group', { name: 'Sans équipe (1)' }))
  assert.ok(r.getByText(`5 agents sur ${TOTAL}`))
  act(() => { fireEvent.keyDown(r.getByRole('combobox'), { key: 'Escape' }) })
})

test('below the threshold the tabs stay, wrap instead of scrolling sideways, and keep the tablist pattern', () => {
  const few = new Map([...base].slice(0, 3))
  const r = panel({ conversations: few })
  const list = r.getByRole('tablist')
  assert.ok(list.className.includes('flex-wrap'), 'the tabs wrap')
  assert.ok(!list.className.includes('overflow-x-auto'), 'no horizontal scroll')
  assert.equal(r.queryByRole('button', { name: /^Agent: / }), null)
  assert.ok(r.getAllByRole('tab').every(t => t.className.includes('max-md:min-h-11')), '44 px targets under 768 px')
})

test('French: the pill says « agents non lus », the option keeps its total apart from « non lus »', () => {
  setLocaleChoice('fr')
  const r = panel({ selectedAgentId: 'b1' })
  const more = new Map(base)
  more.set('b3', [...base.get('b3')!, msg('b3-2', 'assistant', 50, 'late news')])
  more.set('b4', [...base.get('b4')!, msg('b4-2', 'assistant', 51, 'later news')])
  r.retree({ selectedAgentId: 'b1', conversations: more })
  const pill = r.getByRole('button', { name: '2 agents non lus' })
  fireEvent.click(pill)
  const option = r.getByRole('option', { name: /^builder-03 / })
  assert.match(option.textContent ?? '', /^builder-03 \(.+\) 2 messages, dont des non lus$/)
  assert.doesNotMatch(option.textContent ?? '', /\d+ messages non lus/, 'never « n messages non lus »: n is the total')
})

// The focused element, described in words: an assert.equal on two jsdom elements prints the whole DOM tree on failure,
// which exhausts the memory of the test process instead of saying what has the focus
const describe = (el: Element | null) => el ? `<${el.tagName.toLowerCase()}${el.getAttribute('role') ? ` role=${el.getAttribute('role')}` : ''}> ${JSON.stringify(el.textContent?.slice(0, 60) ?? '')}` : 'null'
const assertFocused = (el: Element, message: string) => assert.ok(document.activeElement === el, `${message}: focus is on ${describe(document.activeElement)}, expected ${describe(el)}`)

// The 5th agent that speaks swaps the tablist for the picker: focus on a tab must not fall to <body> (WCAG 2.4.3)
const FOUR = new Map([...base].slice(0, 4))
test('focus on a tab moves to the picker button when the 5th agent speaks and the tabs give way to the picker', () => {
  const r = panel({ conversations: FOUR })
  const tab = r.getAllByRole('tab').find(t => t.getAttribute('tabindex') === '0')!
  act(() => { tab.focus() })
  assertFocused(tab, 'the tab has the focus')
  act(() => { r.retree({ conversations: new Map([...base].slice(0, 5)) }) })
  assert.equal(r.queryByRole('tablist'), null)
  assertFocused(pickerButton(r), 'focus is on the picker button, not on <body>')
})

test('focus on the picker button moves to the active tab when the agents fall under the threshold', () => {
  const r = panel({ conversations: new Map([...base].slice(0, 5)) })
  const button = pickerButton(r)
  act(() => { button.focus() })
  act(() => { r.retree({ conversations: FOUR }) })
  const active = r.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')!
  assertFocused(active, 'focus is on the active tab, not on <body>')
})

// #613 (review of #633): the row's focus ref is cleared only by a blur that names where focus went. Focus that left a tab
// for a frame or another window (the blur has no relatedTarget) leaves the ref set: the check of document.activeElement is
// then what keeps the switch from taking it back.
test('focus that left a tab without a blur target (a frame, another window) is not taken back by the switch', () => {
  const outside = document.createElement('button')
  document.body.appendChild(outside)
  const r = panel({ conversations: FOUR })
  const tab = r.getAllByRole('tab').find(t => t.getAttribute('tabindex') === '0')!
  act(() => { tab.focus() })
  // The blur of a move to another document carries no relatedTarget; the element that holds focus in this document is not <body>
  act(() => {
    tab.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    // jsdom names the target of a focus() move: that blur is kept from React, which saw only the one above
    window.addEventListener('focusout', e => e.stopImmediatePropagation(), { capture: true, once: true })
    outside.focus()
  })
  assertFocused(outside, 'precondition: focus left the row')
  act(() => { r.retree({ conversations: new Map([...base].slice(0, 5)) }) })
  assertFocused(outside, 'focus that left the row stays where it went')
})

test('the switch never takes focus from elsewhere: focus outside the agent row stays where it is', () => {
  const outside = document.createElement('button')
  document.body.appendChild(outside)
  const r = panel({ conversations: FOUR })
  act(() => { outside.focus() })
  act(() => { r.retree({ conversations: new Map([...base].slice(0, 5)) }) })
  assertFocused(outside, 'focus outside the agent row stays there')
})

test('live: when the agent of the active option finishes, its option moves to Finished and is brought into view again (#613)', () => {
  const r = panel()
  const input = openPicker(r)
  fireEvent.click(r.getByRole('button', { name: /^Finished/ }))
  for (let i = 0; i < 4; i++) fireEvent.keyDown(input, { key: 'ArrowDown' })
  const before = activeOption(input)!
  assert.match(before.textContent ?? '', /builder-03/, 'precondition: the active option is builder-03')
  scrolled.length = 0
  const finished = new Map(agents)
  finished.set('b3', agent('b3', 'builder-03', { teamName: 'mega', teamKind: 'workflow', kind: 'teammate', activity: 'done' }))
  act(() => { r.retree({ agents: finished }) })
  const after = activeOption(input)!
  assert.match(after.textContent ?? '', /builder-03/, 'the active option is still the same agent')
  assert.match(after.textContent ?? '', /done/i)
  assert.ok(scrolled.includes(after), 'the option, now in another group, is scrolled into view again')
})
