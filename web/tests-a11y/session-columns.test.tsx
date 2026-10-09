// Sessions panel columns (Name / Model / Tokens / Time): pure cells, rendered rows and the live time cell.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import axe from 'axe-core'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import { LiveTimeValue } from '@/components/agent-visualizer/session-columns'
import type { FreshnessClock } from '@/hooks/use-freshness-clock'
import type { SessionInfo } from '@/lib/bridge-types'
import { ACTIVE_UNKNOWN_TEXT } from '@/lib/active-time'
import type { RollupTotal } from '@/lib/cost-rollup'
import {
  NO_VALUE, activityCell, agentTimeCell, branchCell, costCell, formatDurationCompact, modelCell, rollupTokensCell, runtimeCell, sessionTimeCell, tokensCell,
} from '@/lib/session-columns'

const T0 = 1_000_000_000_000
const noop = () => {}

beforeEach(() => { mock.timers.enable({ apis: ['setInterval'] }) })
afterEach(() => { cleanup(); mock.timers.reset() })

// ─── Pure cells ──────────────────────────────────────────────────────────────

test('formatDurationCompact: short units that keep the column width', () => {
  assert.equal(formatDurationCompact(0), '0s')
  assert.equal(formatDurationCompact(42_000), '42s')
  assert.equal(formatDurationCompact(192_000), '3m 12s')
  assert.equal(formatDurationCompact(3_900_000), '1h 05m')
  assert.equal(formatDurationCompact(3 * 86_400_000 + 4 * 3_600_000), '3d 4h')
  assert.equal(formatDurationCompact(5_000, true), '5s+')
  assert.equal(formatDurationCompact(NaN), '0s')
})

test('modelCell: short name with the id as tooltip source, a named dash when unknown or a pseudo-model', () => {
  const known = modelCell('claude-opus-4-5-20251101')
  assert.equal(known.empty, false)
  assert.ok(known.text.length > 0 && known.text.length <= 10, known.text)
  assert.equal(known.label, `model ${known.text}`)
  for (const none of [undefined, null, '', '<synthetic>']) {
    const c = modelCell(none)
    assert.deepEqual([c.text, c.empty, c.label], [NO_VALUE, true, 'model not reported'])
  }
})

test('tokensCell: compact, lower bounds and estimates marked and spelled out, unknown is a dash (never 0)', () => {
  assert.equal(tokensCell({ value: 12_400, status: 'available', estimated: false }).text, '12k')
  const partial = tokensCell({ value: 9_000, status: 'partial', estimated: true })
  assert.equal(partial.text, '≥~9k')
  assert.match(partial.label, /at least 9k estimated tokens/)
  const none = tokensCell({ value: null, status: 'unavailable', estimated: false })
  assert.deepEqual([none.text, none.empty], [NO_VALUE, true])
  assert.match(none.label, /not reported/)
})

test('rollupTokensCell: incomplete totals are a lower bound in words, no data is a dash', () => {
  const total = (over: Partial<RollupTotal>): RollupTotal => ({ tokens: 1_500_000, cost: 9, agents: 2, known: 2, unknown: 0, complete: true, estimated: false, ...over })
  assert.equal(rollupTokensCell(total({})).text, '1.5M')
  const inc = rollupTokensCell(total({ complete: false, unknown: 1 }))
  assert.equal(inc.text, '≥1.5M')
  assert.match(inc.label, /incomplete/)
  assert.equal(rollupTokensCell(total({ known: 0 })).empty, true)
  assert.equal(rollupTokensCell(null).empty, true)
})

test('agentTimeCell: closed + running span while fresh; unknown otherwise', () => {
  assert.equal(agentTimeCell({ activeMs: 95_000 }, 'closed', 0).text, '1m 35s')
  assert.equal(agentTimeCell({ activeMs: 95_000, activeSince: 1 }, 'fresh', 12_000).text, '1m 47s')
  assert.equal(agentTimeCell({ activeSince: 1 }, 'fresh', 12_000).text, '12s')
  const stale = agentTimeCell({ activeMs: 95_000, activeSince: 1 }, 'stale', 12_000)
  assert.deepEqual([stale.text, stale.label], [NO_VALUE, ACTIVE_UNKNOWN_TEXT])
  assert.equal(agentTimeCell({}, 'never-observed', 0).label, ACTIVE_UNKNOWN_TEXT)
})

test('sessionTimeCell: elapsed while active, start to last activity once completed, unknown end is a dash', () => {
  const base = { startTime: T0, lastActivityTime: T0 + 192_000 }
  assert.equal(sessionTimeCell({ ...base, status: 'active' }, T0 + 60_000).text, '1m 00s')
  assert.equal(sessionTimeCell({ ...base, status: 'completed' }, T0 + 9_999_999).text, '3m 12s')
  assert.equal(sessionTimeCell({ ...base, status: 'completed', lastActivityUnknown: true }, T0).empty, true)
  assert.equal(sessionTimeCell({ startTime: T0 + 5, lastActivityTime: 0, status: 'active' }, T0).empty, true, 'a start in the future is not a duration')
})

test('costCell: money with its lower-bound / estimate marks spelled out, a named dash without data', () => {
  const total = (over: Partial<RollupTotal>): RollupTotal => ({ tokens: 1, cost: 0.1234, agents: 1, known: 1, unknown: 0, complete: true, estimated: false, ...over })
  assert.equal(costCell(total({})).text, '$0.123')
  const inc = costCell(total({ complete: false, estimated: true }))
  assert.equal(inc.text, '≥~$0.123')
  assert.match(inc.label, /estimated/)
  assert.match(inc.label, /incomplete/)
  assert.deepEqual([costCell(total({ known: 0 })).empty, costCell(null).label], [true, 'cost unknown'])
})

test('branchCell / runtimeCell / activityCell: value, or a dash that says why', () => {
  assert.deepEqual([branchCell('feat/x').text, branchCell('feat/x').label], ['feat/x', 'branch feat/x'])
  assert.equal(branchCell(undefined).label, 'branch not recorded')
  assert.deepEqual([runtimeCell('claude').text, runtimeCell('codex').text], ['Claude', 'Codex'])
  assert.equal(runtimeCell('codex').label, 'runtime Codex')
  assert.equal(runtimeCell(undefined).label, 'runtime not reported')
  assert.equal(activityCell({ lastActivityTime: T0 - 120_000 }, T0).text, '2 min ago')
  assert.equal(activityCell({ lastActivityTime: T0, lastActivityUnknown: true }, T0).label, 'activity unknown')
})

// ─── Rendered panel ──────────────────────────────────────────────────────────

const LONG = 'A very long agent name that cannot possibly fit in the name column of the panel'
const sessions: SessionInfo[] = [
  { id: 's1', label: 'payments-api', status: 'active', startTime: T0 - 192_000, lastActivityTime: T0 - 1000 },
  { id: 's2', label: 'docs-site', status: 'completed', startTime: T0 - 600_000, lastActivityTime: T0 - 300_000 },
]
const agent = (id: string, sessionId: string, parentKey: string | null, name: string, over: Record<string, unknown> = {}) =>
  [id, { id, sessionId, parentKey, name, state: 'thinking', tokensUsed: 12_400, tokenStatus: 'available' as const, spawnTime: 1, lastEventAt: T0, ...over }] as const

function clock(): FreshnessClock {
  return { getNow: () => T0, subscribe: () => () => {} }
}

function panel(agents: Map<string, never>, sessionModels?: Map<string, string>) {
  return (
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="s1" sessionsWithActivity={new Set(['s1', 's2'])}
      sessionModels={sessionModels} onSelectSession={noop} onCloseSession={noop} agents={agents as never}
      selectedAgentId={null} onSelectAgent={noop} now={T0} freshnessClock={clock()}
    />
  )
}

const cells = (row: Element) => Object.fromEntries(
  [...row.querySelectorAll('[data-column]')].map(c => [c.getAttribute('data-column')!, c]),
)

test('panel: header and a Name / Model / Tokens / Time value on every session and agent row', () => {
  const agents = new Map([
    agent('s1:main', 's1', null, 'orchestrator', { model: 'claude-opus-4-5-20251101', activeMs: 192_000 }),
    agent('s1:sub', 's1', 's1:main', LONG, { tokensUsed: 0, tokenStatus: 'unavailable' }),
  ])
  const { container, getByTestId } = render(panel(agents as never, new Map([['s1', 'claude-sonnet-4-5-20250929']])))
  const header = getByTestId('session-columns-header')
  assert.deepEqual([...header.children].map(c => c.textContent), ['Name', 'Model', 'Runtime', 'Branch', 'Tokens', 'Cost', 'Time', 'Activity'])
  assert.equal(header.getAttribute('aria-hidden'), 'true', 'each cell names itself: the visible header is not read twice')

  const rows = [...container.querySelectorAll<HTMLElement>('[data-row-main]')]
  const byKey = (key: string) => rows.find(r => r.dataset.rowKey === key)!
  const s1 = cells(byKey('session:s1'))
  assert.equal(s1.model.getAttribute('title'), 'claude-sonnet-4-5-20250929')
  assert.match(s1.tokens.textContent!, /Tokens, .*tokens/, 'a session shows the total of its agents')
  assert.match(s1.time.textContent!, /3m 12s since start/)
  const main = cells(byKey('agent:s1:main'))
  assert.match(main.model.textContent!, /model Opus/)
  assert.match(main.time.textContent!, /3m 12s/)
  // Data absent: a dash with an accessible name, never 0
  const sub = cells(byKey('agent:s1:sub'))
  assert.match(sub.model.textContent!, /model not reported/)
  assert.match(sub.tokens.textContent!, /tokens not reported/)
  assert.ok([...sub.tokens.querySelectorAll('[aria-hidden]')].some(n => n.textContent === NO_VALUE), 'the dash itself is decorative, its name is the sr-only text')
  assert.match(sub.time.textContent!, new RegExp(ACTIVE_UNKNOWN_TEXT))
  // Long name: the full name stays available as a tooltip, the row stays one button
  const longName = byKey('agent:s1:sub').querySelector(`[title="${LONG}"]`)
  assert.ok(longName?.className.includes('truncate'))
  // A completed session has a duration from its own times
  assert.match(cells(byKey('session:s2')).time.textContent!, /5m 00s long/)
})

test('panel: Cost, Branch, Runtime and Activity cells on session rows, a cost on agent rows', () => {
  const withMeta = sessions.map(x => (x.id === 's1' ? { ...x, runtime: 'claude' as const, branch: 'feat/columns' } : x))
  const agents = new Map([agent('s1:main', 's1', null, 'orchestrator', { model: 'claude-opus-4-5-20251101' })])
  const { container } = render(
    <SessionListPanel
      visible onClose={noop} sessions={withMeta} selectedSessionId="s1" sessionsWithActivity={new Set(['s1', 's2'])}
      onSelectSession={noop} onCloseSession={noop} agents={agents as never} selectedAgentId={null} onSelectAgent={noop} now={T0} freshnessClock={clock()}
    />,
  )
  const rows = [...container.querySelectorAll<HTMLElement>('[data-row-main]')]
  const s1 = cells(rows.find(r => r.dataset.rowKey === 'session:s1')!)
  assert.equal(s1.branch.getAttribute('title'), 'feat/columns')
  assert.match(s1.runtime.textContent!, /runtime Claude Code/)
  assert.match(s1.cost.textContent!, /Cost, .*cost/)
  assert.match(s1.activity.textContent!, /last activity just now/)
  const s2 = cells(rows.find(r => r.dataset.rowKey === 'session:s2')!)
  assert.match(s2.branch.textContent!, /branch not recorded/)
  assert.match(s2.activity.textContent!, /last activity 5 min ago/)
  const main = cells(rows.find(r => r.dataset.rowKey === 'agent:s1:main')!)
  assert.match(main.cost.textContent!, /cost/)
  assert.equal(cells(rows.find(r => r.dataset.rowKey === 'agent:s1:main')!).branch, undefined, 'an agent has no branch: blank slot, nothing to read')
})

test('panel: every row is still a button of the roving list', () => {
  const agents = new Map([agent('s1:main', 's1', null, 'orchestrator')])
  const { container } = render(panel(agents as never))
  const rows = [...container.querySelectorAll<HTMLElement>('[data-row-main]')]
  assert.ok(rows.every(r => r.tagName === 'BUTTON'))
  assert.ok(rows.length >= 3)
})

test('panel: no axe violation with the columns', async () => {
  const agents = new Map([
    agent('s1:main', 's1', null, 'orchestrator', { model: 'claude-opus-4-5-20251101', activeSince: T0 - 5000, activeMs: 1000 }),
    agent('s1:sub', 's1', 's1:main', LONG, { tokensUsed: 0, tokenStatus: 'unavailable' }),
  ])
  const { container } = render(panel(agents as never))
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  assert.deepEqual(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html.slice(0, 80)).join(' | ')}`), [])
})

// ─── Live update ─────────────────────────────────────────────────────────────

test('LiveTimeValue: a running agent counts up once per second, and reads unknown once it is no longer fresh', () => {
  let mono = 0
  const running = { activeMs: 60_000, activeSince: T0 }
  const props = { now: () => T0, monotonic: () => mono }
  const { container, rerender } = render(<LiveTimeValue agent={running} freshness="fresh" {...props} />)
  const live = () => container.querySelector('[data-testid="row-active-time"]')!.textContent
  assert.equal(live(), '1m 00s')
  mono = 5_000
  act(() => { mock.timers.tick(1000) })
  assert.equal(live(), '1m 05s')
  mono = 65_000
  act(() => { mock.timers.tick(1000) })
  assert.equal(live(), '2m 05s')
  // Same box every time: tabular digits, no wrapping
  assert.ok(container.firstElementChild!.className.includes('tabular-nums'))
  rerender(<LiveTimeValue agent={running} freshness="stale" {...props} />)
  assert.equal(container.querySelector('[data-testid="row-active-time"]'), null)
  assert.match(container.textContent!, new RegExp(ACTIVE_UNKNOWN_TEXT))
})
