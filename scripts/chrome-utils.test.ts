import './all-locales' // #662: both languages are loaded before the tests
import { test } from 'node:test'
import { translate } from '../web/lib/messages'
import { strict as assert } from 'node:assert'
import { STALE_AFTER_MS } from '../web/lib/canvas-constants'
import {
  sessionStatusKind, scrubberKeyTarget, scrubberTimeFromX, scrubberValueText,
  connectionDisplay, liveBadge, buildAnnouncement, buildAnnouncementParts, formatMissedEvents,
  agentActivityCounts, topBarContextText, viewCountsText, emptyStateChecklist, shouldRestoreFocus, toastRemaining, contextMenuPosition, runEscapeHandlers,
} from '../web/lib/chrome-utils'

/** The two wordings of viewCountsText for one session (formatAgentCounts / formatAgentCountsCompact are internal since #523). */
const formatAgentCounts = (active: number, done: number, stale = 0, idle = 0, error = 0) => viewCountsText({ active, done, stale, idle, error }, null).spoken
const formatAgentCountsCompact = (active: number, done: number, stale = 0, idle = 0, error = 0) => viewCountsText({ active, done, stale, idle, error }, null).drawn

test('session status: unseen activity beats active, selected tab never shows new activity', () => {
  assert.equal(sessionStatusKind({ status: 'active' }, true, false), 'new-activity')
  assert.equal(sessionStatusKind({ status: 'active' }, true, true), 'active')
  assert.equal(sessionStatusKind({ status: 'completed' }, false, false), 'completed')
})

test('scrubber keyboard steps are clamped', () => {
  assert.equal(scrubberKeyTarget('ArrowRight', false, 5, 100), 6)
  assert.equal(scrubberKeyTarget('ArrowRight', true, 5, 100), 15)
  assert.equal(scrubberKeyTarget('ArrowLeft', false, 0, 100), 0)
  assert.equal(scrubberKeyTarget('End', false, 5, 100), 100)
  assert.equal(scrubberKeyTarget('ArrowRight', true, 95, 100), 100)
  assert.equal(scrubberKeyTarget('x', false, 5, 100), null)
})

test('scrubber pointer position maps to time', () => {
  assert.equal(scrubberTimeFromX(150, 100, 200, 60), 15)
  assert.equal(scrubberTimeFromX(0, 100, 200, 60), 0)
  assert.equal(scrubberTimeFromX(999, 100, 200, 60), 60)
  assert.equal(scrubberTimeFromX(150, 100, 0, 60), 0)
  assert.equal(scrubberValueText(75, 3725), '1:15 of 1:02:05')
})

test('agent counts text', () => {
  assert.equal(formatAgentCounts(2, 3), '5 agents: 2 active - 3 done')
  assert.equal(formatAgentCounts(1, 0), '1 agent: 1 active - 0 done')
})

test('connection badge: DEMO never shows as LIVE, connecting is distinct', () => {
  assert.equal(connectionDisplay('watching', true).label, 'DEMO')
  assert.equal(connectionDisplay('watching', false).label, 'LIVE')
  assert.equal(connectionDisplay('connected', false).label, 'CONNECTED')
  assert.equal(connectionDisplay('connected', false).label, liveBadge('connected', false).label)
  assert.equal(connectionDisplay('connecting', false).label, 'CONNECTING')
  assert.equal(connectionDisplay('disconnected', false).label, 'OFFLINE')
})

test('announcement and missed events', () => {
  const connection = connectionDisplay('watching', false)
  assert.equal(
    buildAnnouncement({ connection, sessionLabel: 'main', isReviewing: true, isEmpty: false }),
    'Connection: live. Session: main. Review mode, use Resume live to return',
  )
  assert.match(buildAnnouncement({ connection, sessionLabel: null, isReviewing: false, isEmpty: true }), /Waiting for an agent session/)
  assert.equal(formatMissedEvents(0), null)
  assert.equal(formatMissedEvents(1), '1 event missed while reviewing')
  assert.equal(formatMissedEvents(7), '7 events missed while reviewing')
})

test('empty-state checklist reflects connection and sessions', () => {
  const down = emptyStateChecklist({ status: 'disconnected', relayPort: '3001', sessionCount: 0 })
  assert.deepEqual(down.map(i => i.ok), [false, false, false])
  assert.match(down[0].detail ?? '', /:3001/)
  const up = emptyStateChecklist({ status: 'watching', sessionCount: 2 })
  assert.deepEqual(up.map(i => i.ok), [true, true, true])
})

test('empty-state checklist reports the Claude Code hooks state (#176)', () => {
  const base = { status: 'watching' as const, sessionCount: 0 }
  const find = (items: ReturnType<typeof emptyStateChecklist>) => items.find(i => i.id === 'hooks')
  const ok = find(emptyStateChecklist({ ...base, hooksConfigured: true }))
  assert.equal(ok?.label, 'Claude Code hooks configured')
  assert.equal(ok?.ok, true)
  assert.equal(ok?.detail, undefined)
  const missingCli = find(emptyStateChecklist({ ...base, hooksConfigured: false }))
  assert.equal(missingCli?.ok, false)
  assert.match(missingCli?.detail ?? '', /pnpm run setup/)
  const missingVsc = find(emptyStateChecklist({ ...base, hooksConfigured: false, isVSCode: true }))
  assert.match(missingVsc?.detail ?? '', /Agent Lens: Configure Claude Code Hooks/)
  // Unknown (old relay, Codex only): never a default tick
  assert.equal(find(emptyStateChecklist(base)), undefined)
})

test('focus is restored only from inside the panel or from body', () => {
  const body = {}
  const inside = {}
  const outside = {}
  const panel = { contains: (el: unknown) => el === inside }
  assert.equal(shouldRestoreFocus(inside, panel, body), true)
  assert.equal(shouldRestoreFocus(body, panel, body), true)
  assert.equal(shouldRestoreFocus(null, panel, body), true)
  assert.equal(shouldRestoreFocus(outside, panel, body), false)
})

test('toast remaining time shrinks while running and never goes negative', () => {
  assert.equal(toastRemaining(5000, 1000, 3000), 3000)
  assert.equal(toastRemaining(5000, 1000, 9000), 0)
  assert.equal(toastRemaining(5000, 1000, 500), 5000)
})

test('keyboard context menu falls back to the focused element centre', () => {
  const rect = { left: 100, top: 50, width: 40, height: 20 }
  assert.deepEqual(contextMenuPosition(0, 0, rect), { x: 120, y: 60 })
  assert.deepEqual(contextMenuPosition(0, 0, null), { x: 0, y: 0 })
  assert.deepEqual(contextMenuPosition(7, 9, rect), { x: 7, y: 9 })
})

test('escape handlers run newest first and stop at the first that closes something', () => {
  const calls: string[] = []
  const h = (name: string, result: boolean) => () => { calls.push(name); return result }
  assert.equal(runEscapeHandlers([h('a', true), h('b', false)]), true)
  assert.deepEqual(calls, ['b', 'a'])
  calls.length = 0
  assert.equal(runEscapeHandlers([h('a', false), h('b', false)]), false)
  assert.deepEqual(calls, ['b', 'a'])
  assert.equal(runEscapeHandlers([]), false)
})

test('agent counts: an agent whose status is older than the freshness limit is not counted as active (#145)', () => {
  const now = 1_000_000
  const old = now - STALE_AFTER_MS - 1
  const agents = [
    { state: 'thinking', lastEventAt: now },
    { state: 'tool_calling', lastEventAt: old },
    { state: 'idle', lastEventAt: old },
    { state: 'complete', lastEventAt: old },
  ]
  assert.deepEqual(agentActivityCounts(agents, now), { active: 1, done: 1, stale: 2, idle: 0, error: 0 })
  assert.equal(formatAgentCounts(1, 1, 2), '4 agents: 1 active - 2 last known state - 1 done')
  assert.equal(formatAgentCounts(0, 0, 9), '9 agents: 0 active - 9 last known state - 0 done')
})

test('agent counts: without stale agents the text is unchanged; agents never heard from stay counted as before', () => {
  assert.equal(formatAgentCounts(2, 3, 0), '5 agents: 2 active - 3 done')
  assert.deepEqual(agentActivityCounts([{ state: 'idle' }, { state: 'complete' }], 5), { active: 0, done: 1, stale: 0, idle: 1, error: 0 })
})

test('empty-state checklist states the scope the relay really scans (#291)', () => {
  const ws = emptyStateChecklist({ status: 'connected', sessionCount: 0, scope: 'workspace' }).find(i => i.id === 'workspace')
  assert.equal(ws?.label, 'Workspace watched')
  assert.match(ws?.detail ?? '', /this workspace only/i)
  assert.match(ws?.detail ?? '', /All workspaces/)
  const all = emptyStateChecklist({ status: 'connected', sessionCount: 0, scope: 'all' }).find(i => i.id === 'workspace')
  assert.equal(all?.label, 'All workspaces watched')
  assert.equal(all?.ok, true)
  assert.equal(all?.detail, undefined)
  // Scope unknown (extension, old relay): the previous wording, no claim
  assert.equal(emptyStateChecklist({ status: 'connected', sessionCount: 0 }).find(i => i.id === 'workspace')?.label, 'Workspace watched')
})

test('the playback badge uses the same word as the top bar and only pulses while activity is watched (#367)', () => {
  for (const status of ['watching', 'connected', 'connecting', 'disconnected'] as const) {
    assert.equal(liveBadge(status, false).label, connectionDisplay(status, false).label)
  }
  assert.equal(liveBadge('connected', false).live, false)
  assert.equal(liveBadge('watching', false).live, true)
})

test('agent counts: idle and error agents are not counted as active (#367)', () => {
  const now = 1_000_000
  const agents = [
    { state: 'thinking', lastEventAt: now },
    { state: 'idle', lastEventAt: now },
    { state: 'error', lastEventAt: now },
    { state: 'complete', lastEventAt: now },
  ]
  assert.deepEqual(agentActivityCounts(agents, now), { active: 1, done: 1, stale: 0, idle: 1, error: 1 })
  assert.equal(formatAgentCounts(1, 1, 0, 1, 1), '4 agents: 1 active - 1 idle - 1 error - 1 done')
  assert.equal(formatAgentCounts(2, 3), '5 agents: 2 active - 3 done')
})

test('connection detail (#371): the reconnect detail reaches the label description, only while offline', () => {
  const d = 'reconnecting (attempt 2, retry in 10s)'
  assert.match(connectionDisplay('disconnected', false, d).description, /attempt 2, retry in 10s/)
  assert.equal(connectionDisplay('disconnected', false, d).label, 'OFFLINE')
  assert.equal(connectionDisplay('disconnected', false, null).description, 'Relay offline')
  assert.equal(connectionDisplay('watching', false, d).description, 'Live: watching for agent activity')
  assert.doesNotMatch(connectionDisplay('watching', true, d).description, /attempt/)
})

test('empty-state checklist (#371): workspace and session are unknown, not failed, while the relay is unreachable', () => {
  const down = emptyStateChecklist({ status: 'disconnected', relayPort: '3001', sessionCount: 0 })
  assert.equal(down[0].unknown, undefined)
  assert.equal(down[1].unknown, true)
  assert.equal(down[2].unknown, true)
  assert.match(down[1].detail ?? '', /unknown/)
  const connecting = emptyStateChecklist({ status: 'connecting', sessionCount: 0 })
  assert.equal(connecting[1].unknown, true)
  const up = emptyStateChecklist({ status: 'connected', sessionCount: 0 })
  assert.equal(up[2].unknown, undefined, 'the relay answers: no session is a fact')
  assert.equal(up[2].ok, false)
})

// #523: the totals are no longer drawn in the top bar; screen readers still read them there (the Cost panel is a canvas)
test('top bar: tokens and cost that are not reported each name what is missing (#383)', () => {
  const none = { value: null, status: 'unavailable', estimated: false } as const
  const ok = { value: 1200, status: 'available', estimated: false } as const
  assert.deepEqual(topBarContextText(none, none), { tokens: 'tokens not reported', spoken: 'cost not reported' })
  assert.deepEqual(topBarContextText(ok, none), { tokens: '1.2k tokens in context', spoken: 'cost not reported' })
  assert.equal(topBarContextText(none, ok).tokens, 'tokens not reported')
  assert.match(topBarContextText(ok, ok).spoken, /^context cost estimate \$/)
})

test('top bar: partial, estimated and value-less available totals are qualified or named missing (#383)', () => {
  const partial = { value: 1200, status: 'partial', estimated: false } as const
  const estimated = { value: 1200, status: 'available', estimated: true } as const
  const noValue = { value: null, status: 'available', estimated: false } as const
  assert.equal(topBarContextText(partial, partial).tokens, 'at least 1.2k tokens in context')
  assert.match(topBarContextText(partial, partial).spoken, /^context cost estimate at least \$/)
  assert.match(topBarContextText(estimated, estimated).spoken, /^context cost estimate \$.* estimated$/)
  assert.equal(topBarContextText(noValue, noValue).tokens, 'tokens not reported')
  assert.equal(topBarContextText(noValue, noValue).spoken, 'cost not reported')
  assert.equal(topBarContextText({ value: 5_300_000, status: 'partial', estimated: true }, noValue).tokens, 'at least 5.3M estimated tokens in context')
})

test('agent counts (#497): the full wording for screen readers, the compact one drawn; zero kinds are not listed', () => {
  assert.equal(formatAgentCounts(0, 26, 4), '30 agents: 0 active - 4 last known state - 26 done')
  assert.equal(formatAgentCountsCompact(0, 26, 4), '30 agents: 0 active · 4 last known · 26 done')
  assert.equal(formatAgentCountsCompact(2, 3), '5 agents: 2 active · 3 done')
  assert.equal(formatAgentCountsCompact(1, 1, 0, 1, 1), '4 agents: 1 active · 1 idle · 1 error · 1 done')
  assert.equal(formatAgentCountsCompact(1, 0), '1 agent: 1 active · 0 done')
})

test('view counts (#523): the text the top bar drew, moved to the Sessions panel header, unchanged', () => {
  const one = { active: 0, done: 26, stale: 4, idle: 0, error: 0 }
  assert.deepEqual(viewCountsText(one, null), {
    drawn: '30 agents: 0 active · 4 last known · 26 done',
    spoken: '30 agents: 0 active - 4 last known state - 26 done',
  })
  // All: sessions and agents, no state split (as the bar drew it)
  assert.deepEqual(viewCountsText(one, 3), { drawn: '3 sessions · 30 agents', spoken: '3 sessions, 30 agents' })
  assert.deepEqual(viewCountsText({ active: 1, done: 0, stale: 0, idle: 0, error: 0 }, 1), { drawn: '1 session · 1 agent', spoken: '1 session, 1 agent' })
})

test('announcement of review mode names the button with the catalog text of the locale (#383)', () => {
  const connection = connectionDisplay('watching', false)
  const base = { connection, sessionLabel: null, isReviewing: true, isEmpty: false }
  assert.match(buildAnnouncement({ ...base, locale: 'en' }), new RegExp(`use ${translate('en', 'bar.resumeLive')} to return`))
  const fr = buildAnnouncement({ ...base, locale: 'fr' })
  assert.ok(fr.includes(translate('fr', 'bar.resumeLive')), fr)
  assert.ok(!fr.includes('Resume live'), 'the English button name is not given as an instruction in French')
  const parts = buildAnnouncementParts({ ...base, locale: 'fr' })
  assert.equal(parts.find(p => p.text.includes('Reprendre en direct'))?.lang, 'fr')
  assert.ok(parts.every(p => p.lang === 'fr'), 'the whole sentence is in French (#613)')
  assert.ok(buildAnnouncementParts({ ...base, locale: 'en' }).every(p => p.lang === 'en'))
  assert.equal(buildAnnouncement({ ...base, isReviewing: false, locale: 'fr' }), 'Connexion : en direct. Mode direct')
})

test('the session name of the announcement is data: its own piece declares lang="en", the sentence around it stays in the locale (#613)', () => {
  const base = { connection: connectionDisplay('watching', false), sessionLabel: 'refactor-auth', isReviewing: false, isEmpty: false }
  const fr = buildAnnouncementParts({ ...base, locale: 'fr' }).find(p => p.segments)!
  assert.equal(fr.text, 'Session : refactor-auth', 'the text is the same sentence')
  assert.deepEqual(fr.segments, [{ text: 'Session : ', lang: 'fr' }, { text: 'refactor-auth', lang: 'en' }])
  const en = buildAnnouncementParts({ ...base, locale: 'en' }).find(p => p.segments)!
  assert.deepEqual(en.segments, [{ text: 'Session: ', lang: 'en' }, { text: 'refactor-auth', lang: 'en' }])
  assert.equal(buildAnnouncementParts({ ...base, sessionLabel: null, locale: 'fr' }).some(p => p.segments), false)
})

test('the whole announcement follows the locale: connection, session, live mode, empty, unobserved, full screen, presentation (#613)', () => {
  const all = (locale: 'en' | 'fr', fullscreen: 'on' | 'off', presentation: 'on' | 'off', status: Parameters<typeof connectionDisplay>[0] = 'watching') => buildAnnouncement({
    connection: connectionDisplay(status, false), sessionLabel: 'main', isReviewing: false, isEmpty: true, unobservedSessions: 2,
    fullscreenNote: fullscreen, presentationNote: presentation, locale,
  })
  assert.equal(all('en', 'on', 'off'), 'Connection: live. Session: main. Live mode. Waiting for an agent session. 2 sessions listed, activity not observed. Full screen on. Presentation mode off')
  assert.equal(all('fr', 'on', 'off'), 'Connexion : en direct. Session : main. Mode direct. En attente d’une session d’agent. 2 sessions listées, activité non observée. Plein écran activé. Mode présentation désactivé')
  assert.equal(all('fr', 'off', 'on'), 'Connexion : en direct. Session : main. Mode direct. En attente d’une session d’agent. 2 sessions listées, activité non observée. Plein écran désactivé. Mode présentation activé')
  for (const [status, fr] of [['connected', 'connecté'], ['connecting', 'connexion'], ['disconnected', 'hors ligne']] as const) {
    assert.ok(all('fr', 'on', 'on', status).startsWith(`Connexion : ${fr}.`), status)
  }
  assert.ok(buildAnnouncement({ connection: connectionDisplay('watching', true), sessionLabel: null, isReviewing: false, isEmpty: false, locale: 'fr' }).startsWith('Connexion : démo.'))
  assert.equal(buildAnnouncement({ connection: connectionDisplay('watching', false), sessionLabel: null, isReviewing: false, isEmpty: false, unobservedSessions: 1, locale: 'fr' }), 'Connexion : en direct. Mode direct. 1 session listée, activité non observée')
})
