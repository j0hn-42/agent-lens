// #467: the quota gauges of the top bar. Every figure is a recorded one (rounded for display only), never colour alone,
// the reset time is reachable by keyboard, and a state with no proof shows no number.
import { test, afterEach, before } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { QuotaGauges } from '@/components/agent-visualizer/quota-gauges'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { setLocaleChoice } from '@/lib/locale'
import { MESSAGES, loadLocale, type MessageTable } from '@/lib/messages'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import type { QuotaGaugeState, QuotaSnapshotView } from '@/lib/quota'
import { openMore } from './topbar-more'

// Reset times are formatted in the local zone: pin it so the expected strings are exact
process.env.TZ = 'UTC'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  setLocaleChoice('auto')
  window.localStorage.clear()
})

const H = 3_600_000
// Saturday 17 October 2026: the 5 h window resets at 14:40 UTC, the weekly one on Monday 19 October at 09:05 UTC
const FIVE_RESET = Date.UTC(2026, 9, 17, 14, 40) / 1000
const SEVEN_RESET = Date.UTC(2026, 9, 19, 9, 5) / 1000
const claude = (over: Partial<Extract<QuotaGaugeState, { kind: 'claude' }>> = {}): QuotaGaugeState => ({
  kind: 'claude',
  fiveHour: { remainingPercent: 38.4, resetsAt: FIVE_RESET },
  sevenDay: { remainingPercent: 66, resetsAt: SEVEN_RESET },
  ageMinutes: null,
  ...over,
})
/** The English table, read once it is loaded (#662: no table is loaded at import) */
let T: MessageTable
before(async () => { await loadLocale('en'); T = MESSAGES.en })

/** The text a screen reader gets as the description of a focusable gauge */
const descriptionOf = (el: Element) => {
  const id = el.getAttribute('aria-describedby')
  assert.ok(id, 'the focusable element has a description')
  const node = document.getElementById(id!)
  assert.ok(node, 'the description id resolves')
  return node!.textContent
}

test('claude: two meters with their values, a visible "N % left" and an accessible name each', () => {
  setLocaleChoice('en')
  const view = render(<QuotaGauges state={claude()} />)
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
  assert.equal(five.getAttribute('aria-valuetext'), '38 % left, resets at 14:40')
  assert.equal(seven.getAttribute('aria-valuetext'), '66 % left, resets Mon at 09:05')
  const text = view.container.textContent ?? ''
  assert.match(text, /5 h/)
  assert.match(text, /38 % left/)
  assert.match(text, /7 d/)
  assert.match(text, /66 % left/)
})

test('French: the labels, the texts and the reset time are the catalog ones', () => {
  setLocaleChoice('fr')
  const view = render(<QuotaGauges state={claude()} />)
  const text = view.container.textContent ?? ''
  assert.match(text, /5 h/)
  assert.match(text, /38 % restant/)
  assert.match(text, /7 j/)
  assert.match(text, /66 % restant/)
  const [five, seven] = view.getAllByRole('meter')
  assert.equal(five.getAttribute('aria-label'), MESSAGES.fr['quota.name.fiveHour'])
  assert.equal(five.getAttribute('aria-valuetext'), '38 % restant, reset à 14:40')
  assert.equal(seven.getAttribute('aria-valuetext'), '66 % restant, reset lun. à 09:05')
})

test('the quota text declares its language: a French text is not read with an English voice (WCAG 3.1.2)', () => {
  setLocaleChoice('fr')
  const fr = render(<QuotaGauges state={claude()} />)
  assert.equal(fr.container.querySelector('[data-testid="topbar-quota"]')!.getAttribute('lang'), 'fr')
  cleanup()
  setLocaleChoice('en')
  for (const state of [claude(), { kind: 'unknown' }] as QuotaGaugeState[]) {
    const view = render(<QuotaGauges state={state} />)
    assert.equal(view.container.querySelector('[data-testid="topbar-quota"]')!.getAttribute('lang'), 'en', state.kind)
    cleanup()
  }
  setLocaleChoice('fr')
  for (const state of [{ kind: 'unknown' }] as QuotaGaugeState[]) {
    const view = render(<QuotaGauges state={state} />)
    assert.equal(view.container.querySelector('[data-testid="topbar-quota"]')!.getAttribute('lang'), 'fr', state.kind)
    cleanup()
  }
})

test('one window only: one meter', () => {
  const view = render(<QuotaGauges state={claude({ sevenDay: null })} />)
  assert.equal(view.getAllByRole('meter').length, 1)
  assert.doesNotMatch(view.container.textContent ?? '', /7 d/)
})

test('low and critical are also said in words and with an icon, never by colour alone', () => {
  setLocaleChoice('en')
  const view = render(<QuotaGauges state={claude({
    fiveHour: { remainingPercent: 20, resetsAt: FIVE_RESET },
    sevenDay: { remainingPercent: 4.6, resetsAt: SEVEN_RESET },
  })} />)
  const [five, seven] = view.getAllByRole('meter')
  assert.equal(five.getAttribute('aria-valuetext'), '20 % left, low, resets at 14:40')
  assert.equal(seven.getAttribute('aria-valuetext'), '5 % left, critical, resets Mon at 09:05')
  const text = view.container.textContent ?? ''
  assert.match(text, new RegExp(T['quota.level.low']))
  assert.match(text, new RegExp(T['quota.level.critical']))
  assert.ok(view.container.querySelectorAll('svg[aria-hidden="true"]').length >= 2, 'an icon beside each level')
})

test('25 % and 10 % left are still ok and low: the thresholds are strict', () => {
  const view = render(<QuotaGauges state={claude({
    fiveHour: { remainingPercent: 25, resetsAt: FIVE_RESET },
    sevenDay: { remainingPercent: 10, resetsAt: SEVEN_RESET },
  })} />)
  const [five, seven] = view.getAllByRole('meter')
  assert.doesNotMatch(five.getAttribute('aria-valuetext') ?? '', /low|critical/)
  assert.match(seven.getAttribute('aria-valuetext') ?? '', /low/)
  assert.doesNotMatch(seven.getAttribute('aria-valuetext') ?? '', /critical/)
})

test('the age is visible text and is part of the announced value (above five minutes only)', () => {
  setLocaleChoice('en')
  const fresh = render(<QuotaGauges state={claude({ ageMinutes: null })} />)
  assert.doesNotMatch(fresh.container.textContent ?? '', /updated/)
  assert.doesNotMatch(fresh.getAllByRole('meter')[0].getAttribute('aria-valuetext') ?? '', /updated/)
  cleanup()
  const old = render(<QuotaGauges state={claude({ ageMinutes: 12 })} />)
  assert.match(old.container.textContent ?? '', /updated 12 min ago/)
  const [five, seven] = old.getAllByRole('meter')
  assert.equal(five.getAttribute('aria-valuetext'), '38 % left, resets at 14:40, updated 12 min ago')
  assert.equal(seven.getAttribute('aria-valuetext'), '66 % left, resets Mon at 09:05, updated 12 min ago')
  const visibleAge = Array.from(old.container.querySelectorAll('[aria-hidden="true"]')).find(e => /updated 12 min ago/.test(e.textContent ?? ''))
  assert.ok(visibleAge, 'the visible age is aria-hidden: the meters already announce it')
  cleanup()
  setLocaleChoice('fr')
  const fr = render(<QuotaGauges state={claude({ ageMinutes: 12 })} />)
  assert.equal(fr.getAllByRole('meter')[0].getAttribute('aria-valuetext'), '38 % restant, reset à 14:40, mis à jour il y a 12 min')
})

test('the focusable gauge says its value on Tab: named once, described with the full value', () => {
  setLocaleChoice('en')
  const view = render(<QuotaGauges state={claude({ ageMinutes: 12 })} />)
  const stops = view.container.querySelectorAll<HTMLElement>('[tabindex="0"]')
  assert.equal(stops.length, 2, 'one tab stop per gauge')
  const [five, seven] = Array.from(stops)
  assert.equal(five.getAttribute('aria-label'), null, 'no second copy of the meter name on the group')
  const labelledBy = five.getAttribute('aria-labelledby')
  assert.equal(document.getElementById(labelledBy!)!.textContent, '5 h', 'the group is named by the visible window label')
  assert.equal(descriptionOf(five), '38 % left, resets at 14:40, updated 12 min ago')
  assert.equal(descriptionOf(seven), '66 % left, resets Mon at 09:05, updated 12 min ago')
  assert.equal(document.getElementById(five.getAttribute('aria-describedby')!)!.getAttribute('aria-hidden'), 'true', 'read as a description only, not twice in browse mode')
  // The meter inside keeps the complete name axe asks for
  assert.equal(five.querySelector('[role="meter"]')!.getAttribute('aria-label'), T['quota.name.fiveHour'])
})

test('the reset time appears on keyboard focus and Escape dismisses it', () => {
  setLocaleChoice('en')
  const view = render(<QuotaGauges state={claude()} />)
  const stops = view.container.querySelectorAll<HTMLElement>('[tabindex="0"]')
  assert.equal(view.queryByRole('tooltip'), null, 'nothing before focus')
  fireEvent.focus(stops[0])
  const tip = view.getByRole('tooltip')
  assert.equal(tip.textContent, 'resets at 14:40')
  fireEvent.keyDown(document, { key: 'Escape' })
  assert.equal(view.queryByRole('tooltip'), null, 'Escape dismisses (WCAG 1.4.13)')
  fireEvent.blur(stops[0])
  fireEvent.mouseEnter(stops[1])
  assert.equal(view.getByRole('tooltip').textContent, 'resets Mon at 09:05', 'hover shows it too')
})

test('Escape with the tooltip open closes only the tooltip; without it Escape goes on to the app', () => {
  const view = render(<QuotaGauges state={claude()} />)
  const stop = view.container.querySelector<HTMLElement>('[tabindex="0"]')!
  let reached = 0
  const app = (e: KeyboardEvent) => { if (e.key === 'Escape') reached++ }
  window.addEventListener('keydown', app)
  try {
    fireEvent.keyDown(stop, { key: 'Escape' })
    assert.equal(reached, 1, 'no tooltip: the app (close panel / clear selection) still gets Escape')
    fireEvent.focus(stop)
    assert.ok(view.getByRole('tooltip'))
    fireEvent.keyDown(stop, { key: 'Escape' })
    assert.equal(view.queryByRole('tooltip'), null, 'the tooltip closed')
    assert.equal(reached, 1, 'and the app did not see this Escape')
    fireEvent.keyDown(stop, { key: 'Escape' })
    assert.equal(reached, 2, 'the next Escape is the app again')
  } finally {
    window.removeEventListener('keydown', app)
  }
})

test('the pointer can move from the gauge onto its tooltip: no gap, the tooltip is inside the hover area (WCAG 1.4.13)', () => {
  const view = render(<QuotaGauges state={claude()} />)
  const stop = view.container.querySelector<HTMLElement>('[tabindex="0"]')!
  fireEvent.mouseEnter(stop)
  const tip = view.getByRole('tooltip')
  assert.ok(stop.contains(tip), 'a descendant of the hover area: moving onto it does not leave the gauge')
  assert.doesNotMatch(tip.className, /\bm[tby]?-\d/, 'no margin that would open a hole between the two')
  assert.match(tip.className, /pt-1/, 'the spacing is padding, inside the tooltip box')
})

test('the tooltip is bounded to the viewport width (reflow at 320 px)', () => {
  const view = render(<QuotaGauges state={{ kind: 'unknown' }} />)
  fireEvent.focus(view.container.querySelector<HTMLElement>('[tabindex="0"]')!)
  assert.match(view.getByRole('tooltip').className, /max-w-\[min\(16rem,calc\(100vw-1rem\)\)\]/)
})

test('unknown: no number, the enabling command on focus, announced as the description', () => {
  setLocaleChoice('en')
  const view = render(<QuotaGauges state={{ kind: 'unknown' }} />)
  const text = view.container.textContent ?? ''
  assert.match(text.replace(/node scripts\/setup\.js --statusline/, ''), /quota: unknown for now/)
  assert.equal(view.queryAllByRole('meter').length, 0)
  const stop = view.container.querySelector<HTMLElement>('[tabindex="0"]')!
  assert.match(descriptionOf(stop) ?? "", /node scripts\/setup\.js --statusline/)
  assert.doesNotMatch(view.container.querySelector('[data-testid="topbar-quota"] > span > span')!.textContent ?? '', /\d/, 'no figure in the unknown state')
  fireEvent.focus(stop)
  assert.match(view.getByRole('tooltip').textContent ?? '', /node scripts\/setup\.js --statusline/)
})

test('hidden: nothing is drawn (Copilot and OpenCode have no permanent quota text, #532)', () => {
  setLocaleChoice('en')
  const hidden = render(<QuotaGauges state={{ kind: 'hidden' }} />)
  assert.equal(hidden.container.innerHTML, '')
})

test('no animation or transition, so nothing moves under prefers-reduced-motion', () => {
  const view = render(<QuotaGauges state={claude({ ageMinutes: 9 })} />)
  for (const el of Array.from(view.container.querySelectorAll<HTMLElement>('*'))) {
    assert.doesNotMatch(el.getAttribute('class') ?? '', /animate|transition/, el.outerHTML)
    assert.doesNotMatch(el.getAttribute('style') ?? '', /animation|transition/, el.outerHTML)
  }
})

test('read only (folded top bar): no tab stop and no tooltip, the meters are still read', () => {
  const view = render(<QuotaGauges state={claude()} interactive={false} />)
  assert.equal(view.container.querySelectorAll('[tabindex]').length, 0)
  assert.equal(view.getAllByRole('meter').length, 2)
  const unknown = render(<QuotaGauges state={{ kind: 'unknown' }} interactive={false} />)
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

test('top bar: the gauges are in More (one-line bar), which reads their figures and marks a low one while closed', () => {
  setLocaleChoice('en')
  const view = render(<TopBar {...base} quota={snapshot()} selectedRuntime="claude" />)
  const more = view.container.querySelector<HTMLElement>('#topbar-more')!
  assert.equal(view.queryAllByRole('meter').length, 0, 'More closed: no gauge drawn, no hidden Tab stop')
  const described = (more.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')
  assert.match(described, /Quota: 5 h \d+ % left/, 'More reads the quota in its description')
  assert.ok(view.container.querySelector('[data-more-mark]'), 'More carries a mark for what it holds')
  openMore()
  const meters = view.getAllByRole('meter')
  assert.equal(meters.length, 2)
  assert.ok(view.container.querySelector('[data-topbar-menu]')!.contains(meters[0]), 'the gauges are drawn in More')
  assert.ok(more.compareDocumentPosition(meters[0]) & Node.DOCUMENT_POSITION_FOLLOWING, 'after More in the Tab order')
})

test('top bar: showQuota false renders nothing of it', () => {
  const view = render(<TopBar {...base} quota={snapshot()} selectedRuntime="claude" showQuota={false} />)
  openMore()
  assert.equal(view.queryAllByRole('meter').length, 0)
  assert.doesNotMatch(view.container.textContent ?? '', /quota|% left|% restant/i)
})

test('top bar: a Claude session that never received a snapshot shows nothing of the quota; no session selected neither', () => {
  setLocaleChoice('en')
  const claudeNone = render(<TopBar {...base} quota={null} selectedRuntime="claude" />)
  assert.doesNotMatch(claudeNone.container.textContent ?? '', /quota/i)
  assert.equal(claudeNone.container.querySelector('[data-testid="topbar-quota"]'), null)
  cleanup()
  const none = render(<TopBar {...base} selectedSessionId={ALL_SESSIONS_ID} quota={null} />)
  assert.doesNotMatch(none.container.textContent ?? '', /quota/i)
})

test('top bar: a snapshot that existed and expired (over 30 min) says the quota is unknown', () => {
  setLocaleChoice('en')
  const old = { ...snapshot(), receivedAt: Date.now() - 31 * 60_000 }
  const view = render(<TopBar {...base} quota={old} selectedRuntime="claude" />)
  assert.match(view.container.textContent ?? '', /quota: unknown for now/)
  assert.equal(view.queryAllByRole('meter').length, 0)
})

test('top bar: the quota is on by default (showQuota omitted)', () => {
  const view = render(<TopBar {...base} quota={snapshot()} selectedRuntime="claude" />)
  openMore()
  assert.equal(view.getAllByRole('meter').length, 2)
})
