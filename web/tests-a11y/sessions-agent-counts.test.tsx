// #523 (user request): the agent counts by state left the top bar. They are totalled nowhere else, so the Sessions panel
// header draws them, with the same text and the same qualifiers ("last known"), and screen readers read the full wording.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import axe from 'axe-core'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import { ALL_SESSIONS_ID, type SessionInfo } from '@/lib/bridge-types'
import { setLocaleChoice } from '@/lib/locale'

const T0 = 1_000_000_000_000
const noop = () => {}
afterEach(() => { cleanup(); setLocaleChoice('en') })

const sessions: SessionInfo[] = [
  { id: 's1', label: 'payments-api', status: 'active', startTime: T0 - 60_000, lastActivityTime: T0 - 1_000 },
]
const counts = { active: 0, done: 26, stale: 4, idle: 0, error: 0 }

function panel(selectedSessionId = 's1', allSessionCount?: number) {
  return (
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId={selectedSessionId} sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map()} selectedAgentId={null} onSelectAgent={noop}
      now={T0} observedSessionIds={new Set(['s1'])} agentCounts={counts} allSessionCount={allSessionCount}
    />
  )
}

/** What is drawn: the text without the visually hidden parts. */
function drawnText(el: Element): string {
  const copy = el.cloneNode(true) as Element
  for (const hidden of Array.from(copy.querySelectorAll('.sr-only, [hidden]'))) hidden.remove()
  return copy.textContent ?? ''
}

test('the Sessions panel header draws the agent counts by state that the top bar drew', async () => {
  const { getByTestId, container } = render(panel())
  const el = getByTestId('sessions-agent-counts')
  assert.equal(drawnText(el).trim(), '30 agents: 0 active · 4 last known · 26 done')
  assert.equal(el.querySelector('[aria-hidden="true"]')?.textContent, '30 agents: 0 active · 4 last known · 26 done')
  // Real DOM text for screen readers, in the full wording ("last known state")
  assert.equal(el.querySelector('.sr-only')?.textContent, '30 agents: 0 active - 4 last known state - 26 done')
  // In the panel header, before the search
  const header = container.querySelector('#session-list-title')!.closest('div')!.parentElement!
  assert.ok(header.contains(el) || header.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING, 'below the title')
  assert.ok(el.compareDocumentPosition(container.querySelector('input[type="search"]')!) & Node.DOCUMENT_POSITION_FOLLOWING, 'before the search')
  assert.equal(el.getAttribute('tabindex'), null, 'plain text, not a Tab stop')
  const results = await axe.run(container, { rules: { region: { enabled: false } } })
  assert.deepEqual(results.violations.map(v => v.id), [])
})

test('All: sessions and agents, as the top bar drew them', () => {
  const { getByTestId } = render(panel(ALL_SESSIONS_ID, 3))
  const el = getByTestId('sessions-agent-counts')
  assert.equal(drawnText(el).trim(), '3 sessions · 30 agents')
  assert.equal(el.querySelector('.sr-only')?.textContent, '3 sessions, 30 agents')
})

test('the counts follow the interface language, and no passage is marked English (#523)', () => {
  setLocaleChoice('fr')
  const { getByTestId } = render(panel())
  const el = getByTestId('sessions-agent-counts')
  assert.equal(drawnText(el).trim(), '30 agents : 0 actif · 4 dernier connu · 26 terminés')
  assert.equal(el.querySelector('.sr-only')?.textContent, '30 agents : 0 actif - 4 dernier état connu - 26 terminés')
  assert.equal(el.closest('[lang]')?.getAttribute('lang'), 'fr', 'the nearest language is the interface one, not English')
  assert.equal(el.hasAttribute('data-i18n-exempt'), false)
})

test('without counts (no view data passed) nothing is drawn', () => {
  const { queryByTestId } = render(
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="s1" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map()} selectedAgentId={null} onSelectAgent={noop} now={T0}
    />,
  )
  assert.equal(queryByTestId('sessions-agent-counts'), null)
})
