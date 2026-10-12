import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { STALE_AFTER_MS } from '../web/lib/canvas-constants'
import {
  sessionStatusKind, scrubberKeyTarget, scrubberTimeFromX, scrubberValueText,
  formatAgentCounts, connectionDisplay, buildAnnouncement, formatMissedEvents,
  agentActivityCounts, emptyStateChecklist, shouldRestoreFocus, toastRemaining, contextMenuPosition, runEscapeHandlers,
} from '../web/lib/chrome-utils'

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
  assert.equal(connectionDisplay('connecting', false).label, 'CONNECTING')
  assert.equal(connectionDisplay('disconnected', false).label, 'OFFLINE')
})

test('announcement and missed events', () => {
  const connection = connectionDisplay('watching', false)
  assert.equal(
    buildAnnouncement({ connection, sessionLabel: 'main', isReviewing: true, isEmpty: false }),
    'Connection: live. Session: main. Review mode',
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
  assert.deepEqual(agentActivityCounts(agents, now), { active: 1, done: 1, stale: 2 })
  assert.equal(formatAgentCounts(1, 1, 2), '4 agents: 1 active - 2 last known state - 1 done')
  assert.equal(formatAgentCounts(0, 0, 9), '9 agents: 0 active - 9 last known state - 0 done')
})

test('agent counts: without stale agents the text is unchanged; agents never heard from stay counted as before', () => {
  assert.equal(formatAgentCounts(2, 3, 0), '5 agents: 2 active - 3 done')
  assert.deepEqual(agentActivityCounts([{ state: 'idle' }, { state: 'complete' }], 5), { active: 1, done: 1, stale: 0 })
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
