// #467: the quota gauges of the top bar. Every figure is a recorded one (rounded for display only), never colour alone,
// the reset time is reachable by keyboard, and a state with no proof shows no number.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { QuotaGauges } from '@/components/agent-visualizer/quota-gauges'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { setLocaleChoice } from '@/lib/locale'
import { MESSAGES } from '@/lib/messages'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import type { QuotaGaugeState, QuotaSnapshotView } from '@/lib/quota'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  setLocaleChoice('auto')
  window.localStorage.clear()
})

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const inSeconds = (ms: number) => Math.floor((NOW + ms) / 1000)
const H = 3_600_000
const claude = (over: Partial<Extract<QuotaGaugeState, { kind: 'claude' }>> = {}): QuotaGaugeState => ({
  kind: 'claude',
  fiveHour: { remainingPercent: 38.4, resetsAt: inSeconds(2 * H) },
  sevenDay: { remainingPercent: 66, resetsAt: inSeconds(50 * H) },
  ageMinutes: null,
  ...over,
})
const T = MESSAGES.en

test('claude: two meters with their values, a visible "N % left" and an accessible name each', () => {
  setLocaleChoice('en')
  const view = render(<QuotaGauges state={claude()} now={NOW} />)
  const meters = view.getAllByRole('meter')
  assert.equal(meters.length, 2)
  const [five, seven] = meters
  assert.equal(five.getAttribute('aria-label'), T['quota.name.fiveHour'])
  assert.equal(seven.getAttribute('aria-label'), T['quota.name.sevenDay'])
  for (const [m, now] of [[five, 38], [seven, 66]] as const) {
    assert.equal(m.getAttribute('aria-valuemin'), '0')
    assert.equal(m.getAttribute('aria-valuemax'), '100')
    assert.equal(m.getAttribute('aria-valuenow'), String(now), 'the meter carries the same rounded number as the text')
  }
  assert.match(five.getAttribute('aria-valuetext') ?? '', /^38 % left, resets at \d{2}:\d{2}$/)
  assert.match(seven.getAttribute('aria-valuetext') ?? '', /^66 % left, resets \S+ at \d{2}:\d{2}$/, 'the weekly window names the weekday')
  const text = view.container.textContent ?? ''
  assert.match(text, /5 h/)
  assert.match(text, /38 % left/)
  assert.match(text, /7 d/)
  assert.match(text, /66 % left/)
})

test('French: the labels and the texts are the catalog ones', () => {
  setLocaleChoice('fr')
  const view = render(<QuotaGauges state={claude()} now={NOW} />)
  const text = view.container.textContent ?? ''
  assert.match(text, /5 h/)
  assert.match(text, /38 % restant/)
  assert.match(text, /7 j/)
  assert.match(text, /66 % restant/)
  assert.equal(view.getAllByRole('meter')[0].getAttribute('aria-label'), MESSAGES.fr['quota.name.fiveHour'])
  assert.match(view.getAllByRole('meter')[0].getAttribute('aria-valuetext') ?? '', /^38 % restant, reset à \d{2}:\d{2}$/)
})

test('one window only: one meter', () => {
  const view = render(<QuotaGauges state={claude({ sevenDay: null })} now={NOW} />)
  assert.equal(view.getAllByRole('meter').length, 1)
  assert.doesNotMatch(view.container.textContent ?? '', /7 d/)
})

test('low and critical are also said in words and with an icon, never by colour alone', () => {
  setLocaleChoice('en')
  const view = render(<QuotaGauges state={claude({
    fiveHour: { remainingPercent: 20, resetsAt: inSeconds(H) },
    sevenDay: { remainingPercent: 4.6, resetsAt: inSeconds(40 * H) },
  })} now={NOW} />)
  const [five, seven] = view.getAllByRole('meter')
  assert.match(five.getAttribute('aria-valuetext') ?? '', /^20 % left, low, /)
  assert.match(seven.getAttribute('aria-valuetext') ?? '', /^5 % left, critical, /)
  const text = view.container.textContent ?? ''
  assert.match(text, new RegExp(T['quota.level.low']))
  assert.match(text, new RegExp(T['quota.level.critical']))
  assert.ok(view.container.querySelectorAll('svg[aria-hidden="true"]').length >= 2, 'an icon beside each level')
})

test('25 % and 10 % left are still ok and low: the thresholds are strict', () => {
  const view = render(<QuotaGauges state={claude({
    fiveHour: { remainingPercent: 25, resetsAt: inSeconds(H) },
    sevenDay: { remainingPercent: 10, resetsAt: inSeconds(40 * H) },
  })} now={NOW} />)
  const [five, seven] = view.getAllByRole('meter')
  assert.doesNotMatch(five.getAttribute('aria-valuetext') ?? '', /low|critical/)
  assert.match(seven.getAttribute('aria-valuetext') ?? '', /low/)
  assert.doesNotMatch(seven.getAttribute('aria-valuetext') ?? '', /critical/)
})

test('the age shows only above five minutes (ageMinutes set), as visible text', () => {
  setLocaleChoice('en')
  const fresh = render(<QuotaGauges state={claude({ ageMinutes: null })} now={NOW} />)
  assert.doesNotMatch(fresh.container.textContent ?? '', /updated/)
  cleanup()
  const old = render(<QuotaGauges state={claude({ ageMinutes: 12 })} now={NOW} />)
  assert.match(old.container.textContent ?? '', /updated 12 min ago/)
})

test('the reset time appears on keyboard focus and Escape dismisses it', () => {
  setLocaleChoice('en')
  const view = render(<QuotaGauges state={claude()} now={NOW} />)
  const stops = view.container.querySelectorAll<HTMLElement>('[tabindex="0"]')
  assert.equal(stops.length, 2, 'one tab stop per gauge')
  assert.equal(view.queryByRole('tooltip'), null, 'nothing before focus')
  fireEvent.focus(stops[0])
  const tip = view.getByRole('tooltip')
  assert.match(tip.textContent ?? '', /resets at \d{2}:\d{2}/)
  fireEvent.keyDown(document, { key: 'Escape' })
  assert.equal(view.queryByRole('tooltip'), null, 'Escape dismisses (WCAG 1.4.13)')
  fireEvent.blur(stops[0])
  fireEvent.mouseEnter(stops[1])
  assert.match(view.getByRole('tooltip').textContent ?? '', /resets \S+ at \d{2}:\d{2}/, 'hover shows it too')
})

test('unknown: no number, the enabling command on focus', () => {
  setLocaleChoice('en')
  const view = render(<QuotaGauges state={{ kind: 'unknown' }} now={NOW} />)
  const text = view.container.textContent ?? ''
  assert.match(text, /quota: unknown for now/)
  assert.doesNotMatch(text, /\d/, 'no figure in the unknown state')
  assert.equal(view.queryAllByRole('meter').length, 0)
  const stop = view.container.querySelector<HTMLElement>('[tabindex="0"]')!
  fireEvent.focus(stop)
  assert.match(view.getByRole('tooltip').textContent ?? '', /node scripts\/setup\.js --statusline/)
  assert.ok(stop.getAttribute('aria-describedby'), 'the help is read with the text')
})

test('copilot: not available; opencode: no subscription quota; hidden: nothing', () => {
  setLocaleChoice('en')
  assert.match(render(<QuotaGauges state={{ kind: 'unavailable', runtime: 'copilot' }} now={NOW} />).container.textContent ?? '', /quota not available/)
  cleanup()
  assert.match(render(<QuotaGauges state={{ kind: 'no-subscription', runtime: 'opencode' }} now={NOW} />).container.textContent ?? '', /no subscription quota/)
  cleanup()
  const hidden = render(<QuotaGauges state={{ kind: 'hidden' }} now={NOW} />)
  assert.equal(hidden.container.innerHTML, '')
})

test('no animation or transition, so nothing moves under prefers-reduced-motion', () => {
  const view = render(<QuotaGauges state={claude({ ageMinutes: 9 })} now={NOW} />)
  for (const el of Array.from(view.container.querySelectorAll<HTMLElement>('*'))) {
    assert.doesNotMatch(el.getAttribute('class') ?? '', /animate|transition/, el.outerHTML)
    assert.doesNotMatch(el.getAttribute('style') ?? '', /animation|transition/, el.outerHTML)
  }
})

test('read only (folded top bar): no tab stop and no tooltip, the meters are still read', () => {
  const view = render(<QuotaGauges state={claude()} now={NOW} interactive={false} />)
  assert.equal(view.container.querySelectorAll('[tabindex]').length, 0)
  assert.equal(view.getAllByRole('meter').length, 2)
  const unknown = render(<QuotaGauges state={{ kind: 'unknown' }} now={NOW} interactive={false} />)
  assert.equal(unknown.container.querySelectorAll('[tabindex]').length, 0)
})

// ─── In the top bar ────────────────────────────────────────────────────────────

const noop = () => {}
const base: TopBarProps = {
  sessions: [{ id: 's1', label: 'one', status: 'active', startTime: 1, lastActivityTime: 2, runtime: 'claude' }],
  selectedSessionId: 's1', sessionsWithActivity: new Set(),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 1, doneAgentCount: 0, totalTokens: 33000, totalCost: 0.312,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, showStats: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, onToggleMute: noop, onOpenShortcuts: noop,
}
const snapshot = (): QuotaSnapshotView => ({
  fiveHour: { remainingPercent: 38, resetsAt: Math.floor((Date.now() + 2 * H) / 1000) },
  sevenDay: { remainingPercent: 66, resetsAt: Math.floor((Date.now() + 50 * H) / 1000) },
  receivedAt: Date.now(),
})

test('top bar: the gauges sit with the totals, after the tokens and cost', () => {
  setLocaleChoice('en')
  const view = render(<TopBar {...base} quota={snapshot()} selectedRuntime="claude" />)
  const tokens = Array.from(view.container.querySelectorAll('span')).filter(s => /tokens in context/.test(s.textContent ?? '')).pop()!
  const meters = view.getAllByRole('meter')
  assert.equal(meters.length, 2)
  assert.ok(tokens.compareDocumentPosition(meters[0]) & Node.DOCUMENT_POSITION_FOLLOWING, 'the gauges come after the tokens')
  assert.ok(view.container.querySelector('[role="toolbar"]')!.compareDocumentPosition(meters[0]) & Node.DOCUMENT_POSITION_PRECEDING, 'and before the view controls')
})

test('top bar: showQuota false renders nothing of it', () => {
  const view = render(<TopBar {...base} quota={snapshot()} selectedRuntime="claude" showQuota={false} />)
  assert.equal(view.queryAllByRole('meter').length, 0)
  assert.doesNotMatch(view.container.textContent ?? '', /quota|% left|% restant/i)
})

test('top bar: a Claude session without a snapshot says the quota is unknown; no session selected shows nothing', () => {
  setLocaleChoice('en')
  const claudeNone = render(<TopBar {...base} quota={null} selectedRuntime="claude" />)
  assert.match(claudeNone.container.textContent ?? '', /quota: unknown for now/)
  cleanup()
  const none = render(<TopBar {...base} selectedSessionId={ALL_SESSIONS_ID} quota={null} />)
  assert.doesNotMatch(none.container.textContent ?? '', /quota/i)
})

test('top bar: the quota is on by default (showQuota omitted)', () => {
  const view = render(<TopBar {...base} quota={snapshot()} selectedRuntime="claude" />)
  assert.equal(view.getAllByRole('meter').length, 2)
})
