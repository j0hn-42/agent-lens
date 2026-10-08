// Issue #52: the "listed - activity not observed" status flows through EVERY consumer of a session's
// status (top bar, sessions list, screen reader announcements), through the real components and the
// real app-wide observation tracker.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'

import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ChromeAnnouncer } from '@/components/agent-visualizer/chrome-announcer'
import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import { connectionDisplay } from '@/lib/chrome-utils'
import { ALL_SESSIONS_ID, type SessionInfo } from '@/lib/bridge-types'
import { observedSessions, SESSION_NOT_OBSERVED_TEXT } from '@/lib/session-model'
import { STALE_AFTER_MS } from '@/lib/canvas-constants'
import type { FreshnessClock } from '@/hooks/use-freshness-clock'

beforeEach(() => observedSessions.clear())
afterEach(() => {
  cleanup()
  observedSessions.clear()
  document.body.replaceChildren()
})

const noop = () => {}
const sessions: SessionInfo[] = [
  { id: 'seen', label: 'Seen', status: 'active', startTime: 1, lastActivityTime: 3 },
  { id: 'ghost', label: 'Ghost', status: 'active', startTime: 1, lastActivityTime: 2 },
  { id: 'done', label: 'Done', status: 'completed', startTime: 1, lastActivityTime: 1 },
]

const topBar: TopBarProps = {
  sessions, selectedSessionId: ALL_SESSIONS_ID, sessionsWithActivity: new Set(),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 1, doneAgentCount: 0, totalTokens: 10, totalCost: 0,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, showStats: false, onToggleMute: noop, onOpenShortcuts: noop,
}

// ─── Top bar ─────────────────────────────────────────────────────────────────

test('top bar: the Sessions button says how many listed sessions are not observed, and follows the tracker', () => {
  const { getByRole } = render(<TopBar {...topBar} />)
  const button = getByRole('button', { name: /Sessions/ })
  assert.ok(button.textContent!.includes('2 activity not observed'), 'two active sessions, none heard from')
  act(() => { observedSessions.mark('seen') })
  assert.ok(button.textContent!.includes('1 activity not observed'), 'an event arrived for one of them')
  assert.equal(button.textContent!.includes('2 activity not observed'), false)
  act(() => { observedSessions.mark('ghost') })
  assert.equal(button.textContent!.includes('not observed'), false, 'nothing unknown left: no text')
})

test('top bar: a live hook flag counts as observed', () => {
  const { getByRole } = render(<TopBar {...topBar} sessionsWithActivity={new Set(['seen'])} />)
  assert.ok(getByRole('button', { name: /Sessions/ }).textContent!.includes('1 activity not observed'))
})

// ─── Announcements ───────────────────────────────────────────────────────────

function announcer(extra: Partial<React.ComponentProps<typeof ChromeAnnouncer>> = {}) {
  return (
    <ChromeAnnouncer
      connection={connectionDisplay('watching', false)} sessionLabel="All sessions" isReviewing={false} isEmpty={false}
      sessions={sessions} sessionsWithActivity={new Set()} {...extra}
    />
  )
}

test('announcer: the live region announces unobserved sessions and updates when one is heard from', () => {
  const { getByRole } = render(announcer())
  const region = getByRole('status')
  assert.equal(region.getAttribute('aria-live'), 'polite')
  assert.equal(region.textContent, 'Connection: live. Session: All sessions. Live mode. 2 sessions listed, activity not observed')
  act(() => { observedSessions.mark('seen') })
  assert.equal(region.textContent, 'Connection: live. Session: All sessions. Live mode. 1 session listed, activity not observed')
  act(() => { observedSessions.mark('ghost') })
  assert.equal(region.textContent, 'Connection: live. Session: All sessions. Live mode')
})

// ─── Sessions list ───────────────────────────────────────────────────────────

function panel(extra: Partial<React.ComponentProps<typeof SessionListPanel>> = {}) {
  return (
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="seen" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map()} selectedAgentId={null} onSelectAgent={noop}
      now={10_000} {...extra}
    />
  )
}

function rowText(container: HTMLElement, label: string): string {
  const btn = Array.from(container.querySelectorAll<HTMLElement>('button[data-row-main]')).find(b => b.textContent?.includes(label))
  assert.ok(btn, `row ${label}`)
  return btn.textContent!
}

test('sessions list: with the app-wide tracker (no override) an active session without events reads "not observed", not active', () => {
  const { container } = render(panel())
  assert.ok(rowText(container, 'Ghost').includes(SESSION_NOT_OBSERVED_TEXT))
  assert.ok(rowText(container, 'Seen').includes(SESSION_NOT_OBSERVED_TEXT), 'the tracker is empty: nobody was heard from')
  assert.ok(container.textContent!.includes('0 active / 3'))
  act(() => { observedSessions.mark('seen') })
  assert.equal(rowText(container, 'Seen').includes(SESSION_NOT_OBSERVED_TEXT), false)
  assert.ok(rowText(container, 'Seen').includes('active,'), 'now announced as active')
  assert.ok(container.textContent!.includes('1 active / 3'))
})

test('sessions list: "Active only" uses the same observation as the status (default filter, through the panel)', () => {
  const { container, getByRole } = render(panel({ selectedSessionId: ALL_SESSIONS_ID }))
  act(() => { observedSessions.mark('seen') })
  act(() => { getByRole('button', { name: 'Active only' }).click() })
  assert.ok(container.textContent!.includes('Seen'))
  assert.equal(container.textContent!.includes('Ghost'), false, 'not counted as active, so filtered out')
  assert.equal(container.textContent!.includes('Done'), false)
})

// ─── The freshness announcer is mounted by the panel, also while the panel is closed ─────────────

test('sessions list: the panel mounts the freshness announcer (it speaks even while the panel is hidden)', () => {
  let now = 1_000_000_000_000
  const listeners = new Set<() => void>()
  const clock: FreshnessClock = {
    getNow: () => now,
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
  }
  const agents = new Map([
    ['seen:main', { id: 'seen:main', sessionId: 'seen', parentKey: null, name: 'main', state: 'thinking', tokensUsed: 1, spawnTime: 1, lastEventAt: now }],
  ])
  const { getAllByRole } = render(panel({ visible: false, agents, freshnessClock: clock }))
  now += STALE_AFTER_MS + 1
  act(() => { for (const l of [...listeners]) l() })
  const spoken = getAllByRole('status', { hidden: true }).map(r => r.textContent).join('|')
  assert.ok(spoken.includes('main is no longer reporting, showing the last known state.'), spoken)
})
