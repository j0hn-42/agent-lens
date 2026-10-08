import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { ALL_SESSIONS_ID, teamSelectionId, type SessionInfo } from '../web/lib/bridge-types'
import {
  buildSessionMeta, buildSessionProjects, clusterSelectionTarget, observeTopbarHeight, topbarOffsetPx,
} from '../web/lib/chrome-utils'
import {
  ACTIVE_WINDOW_MS, activeSessionIds, finishedSessionIds, pruneReplayStamps, shouldStampActivity, isStaleCompleted,
} from '../web/hooks/simulation/session-visibility'
import { computeClusters, clusterLabelLines, clusterAnnouncement } from '../web/components/agent-visualizer/canvas/cluster-model'
import {
  EMPTY_PAIR, pairAfterShiftClick, pairChipLabel, prunePair,
} from '../web/lib/pair-filter'
import { agentNameOf } from '../web/lib/feed-utils'

const HOUR = 60 * 60 * 1000
const NOW = 1_700_000_000_000

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id, label: id, status: 'active', startTime: NOW - 5 * HOUR, lastActivityTime: NOW, ...over,
})

// ─── D2: replayed history must not make a finished session active ────────────

// The end-to-end replay behaviour (list + events in one tick) is tested through the real useVSCodeBridge in
// web/tests-a11y/bridge-ref-sync.test.tsx; here only the pure window rules.
test('visibility window: a finished session without a stamp stays out of "All", a replay-only stamp ages out', () => {
  const sessions = [session('live'), session('old', { status: 'completed', lastActivityTime: NOW - 3 * HOUR })]
  const stamps = new Map<string, number>([['live', NOW]])
  const active = activeSessionIds({ sessions, lastEventAt: stamps, now: NOW })
  assert.deepEqual([...active].sort(), ['live'])
  assert.deepEqual(finishedSessionIds(sessions, active), ['old'])
  const later = NOW + ACTIVE_WINDOW_MS + 60_000
  assert.deepEqual([...activeSessionIds({ sessions, lastEventAt: stamps, now: later })], ['live'])
  const completedLive = [session('live', { status: 'completed', lastActivityTime: NOW - 1000 })]
  assert.deepEqual([...activeSessionIds({ sessions: completedLive, lastEventAt: stamps, now: later })], [])
  // and a stamp for the finished one WOULD make it active: the bridge must not create it (see bridge-ref-sync)
  assert.ok(activeSessionIds({ sessions, lastEventAt: new Map([['old', NOW]]), now: NOW }).has('old'))
})

test('events replayed before the session list are undone when the list shows the session finished', () => {
  const stamps = new Map<string, number>([['old', NOW], ['live', NOW], ['unknown', NOW]])
  const list = [session('live'), session('old', { status: 'completed', lastActivityTime: NOW - 3 * HOUR })]
  assert.equal(pruneReplayStamps(stamps, list, NOW), 1)
  assert.deepEqual([...stamps.keys()].sort(), ['live', 'unknown'])
})

test('real live events keep counting: active status, recent activity or an unknown session', () => {
  assert.equal(shouldStampActivity(session('a'), NOW), true)
  assert.equal(shouldStampActivity(undefined, NOW), true)
  // completed but touched a minute ago (a live event just moved lastActivityTime)
  assert.equal(shouldStampActivity(session('a', { status: 'completed', lastActivityTime: NOW - 60_000 }), NOW), true)
  // a resumed session is active again
  assert.equal(isStaleCompleted(session('a', { status: 'active', lastActivityTime: NOW - 3 * HOUR }), NOW), false)
  // exactly at the window boundary is still recent
  assert.equal(isStaleCompleted(session('a', { status: 'completed', lastActivityTime: NOW - ACTIVE_WINDOW_MS }), NOW), false)
  assert.equal(isStaleCompleted(session('a', { status: 'completed', lastActivityTime: NOW - ACTIVE_WINDOW_MS - 1 }), NOW), true)
  // garbage activity time is not treated as stale
  assert.equal(isStaleCompleted(session('a', { status: 'completed', lastActivityTime: Number.NaN }), NOW), false)
})

// ─── D1: halo titles and cluster selection ───────────────────────────────────

function agent(id: string, sessionId: string, over: Record<string, unknown> = {}) {
  return {
    id, name: id, sessionId, x: id.length * 10, y: 0, state: 'thinking', tokensUsed: 0, opacity: 1, isMain: id.startsWith('main'),
    ...over,
  } as never
}

test('session meta from the list gives the halo its label, runtime and workspace instead of the id', () => {
  const meta = buildSessionMeta([
    session('sess-a', { label: 'payments-api', workspace: 'payments', runtime: 'codex' }),
    session('sess-b', { label: 'web' }),
  ])
  assert.deepEqual(meta.get('sess-a'), { label: 'payments-api', status: 'active', runtime: 'codex', workspace: 'payments' })
  assert.deepEqual(meta.get('sess-b'), { label: 'web', status: 'active' })
  const agents = [agent('main-a', 'sess-a'), agent('w1', 'sess-a'), agent('main-b', 'sess-b')]
  const clusters = computeClusters(agents, undefined, { sessions: meta })
  const a = clusters.find(c => c.sessionIds.includes('sess-a'))
  assert.ok(a)
  assert.equal(a.title, 'payments-api')
  assert.notEqual(a.title, 'sess-a')
  // Without the meta (the old wiring) the title falls back to the id
  const bare = computeClusters(agents, undefined).find(c => c.sessionIds.includes('sess-a'))
  assert.ok(bare)
  assert.equal(bare.title, 'sess-a')
})

test('project (#86): the halo carries the repository name only when every session of the cluster proves the same one', () => {
  const list = [
    session('s1', { label: 'a', projectId: 'P1', projectName: 'alpha' }),
    session('s2', { label: 'b', projectId: 'P1', projectName: 'alpha' }),
    session('s3', { label: 'c', projectId: 'P2', projectName: 'beta' }),
    session('s4', { label: 'd' }),
    session('s5', { label: 'e', projectId: 'P1' }),
  ]
  const projects = buildSessionProjects(list)
  assert.deepEqual(Array.from(projects.keys()), ['s1', 's2', 's3'], 'outside git or without a name: no project')
  const meta = buildSessionMeta(list)
  const clusters = computeClusters([agent('m1', 's1'), agent('m2', 's2'), agent('m3', 's3'), agent('m4', 's4'), agent('m5', 's5')], undefined, { sessions: meta })
  const byTitle = (l: string) => clusters.find(c => c.title === l)!
  assert.equal(byTitle('a').projectName, 'alpha')
  assert.equal(byTitle('c').projectName, 'beta')
  assert.equal(byTitle('d').projectName, undefined)
  assert.equal(byTitle('e').projectName, undefined)
  assert.match(clusterLabelLines(byTitle('a')).detail, /alpha/)
  assert.doesNotMatch(clusterLabelLines(byTitle('d')).detail, /alpha|beta/)
  assert.match(clusterAnnouncement(byTitle('a')), /project alpha/)
})

test('halo click: a session cluster selects its session, a team cluster the team tab, All stays All with several sessions', () => {
  const sessionCluster = { kind: 'session' as const, sessionIds: ['s1'] }
  assert.equal(clusterSelectionTarget(sessionCluster, 's2', 3), 's1')
  assert.equal(clusterSelectionTarget(sessionCluster, 's1', 3), null, 'already selected')
  assert.equal(clusterSelectionTarget(sessionCluster, ALL_SESSIONS_ID, 3), null, 'All stays All')
  assert.equal(clusterSelectionTarget(sessionCluster, ALL_SESSIONS_ID, 1), 's1', 'a single session: select it')
  assert.equal(clusterSelectionTarget(sessionCluster, null, 2), 's1')
  assert.equal(clusterSelectionTarget({ kind: 'team', sessionIds: ['s1', 's2'], teamName: 'core' }, ALL_SESSIONS_ID, 3), teamSelectionId('core'))
  assert.equal(clusterSelectionTarget({ kind: 'team', sessionIds: ['s1'], teamName: 'core' }, teamSelectionId('core'), 3), null)
  assert.equal(clusterSelectionTarget({ kind: 'team', sessionIds: ['s1'] }, 's1', 3), null, 'a team without a name selects nothing')
  assert.equal(clusterSelectionTarget({ kind: 'session', sessionIds: ['s1', 's2'] }, 's9', 3), null, 'ambiguous cluster')
})

// ─── Pair filter wiring ──────────────────────────────────────────────────────

test('canvas Shift-click: the selected agent becomes the first end, then the usual sequence', () => {
  assert.deepEqual(pairAfterShiftClick(EMPTY_PAIR, 'orch', 'ux'), { a: 'orch', b: 'ux' })
  assert.deepEqual(pairAfterShiftClick(EMPTY_PAIR, null, 'ux'), { a: 'ux', b: '' })
  assert.deepEqual(pairAfterShiftClick(EMPTY_PAIR, 'ux', 'ux'), { a: 'ux', b: '' })
  assert.deepEqual(pairAfterShiftClick({ a: 'orch', b: '' }, 'zzz', 'ux'), { a: 'orch', b: 'ux' })
  assert.deepEqual(pairAfterShiftClick({ a: 'orch', b: 'ux' }, 'orch', 'qa'), { a: 'qa', b: '' })
  assert.deepEqual(pairAfterShiftClick(EMPTY_PAIR, 'orch', 'all'), EMPTY_PAIR)
})

test('a pair is pruned when an agent leaves the simulation and the chip falls back to display names', () => {
  const agents = new Map([['s1:orch', { name: 'orchestrator' }], ['s1:ux', { name: 'audit-ux' }]])
  const pair = { a: 's1:orch', b: 's1:ux' }
  assert.equal(prunePair(pair, k => agents.has(k)), pair, 'unchanged object when everyone is still there')
  agents.delete('s1:ux')
  const pruned = prunePair(pair, k => agents.has(k))
  assert.deepEqual(pruned, { a: 's1:orch', b: '' })
  const nameOf = (k: string) => agentNameOf(agents, k)
  assert.equal(pairChipLabel(pair, nameOf), 'orchestrator ↔ ux', 'a missing agent shows its name part, not the raw key')
})

// ─── --topbar-h measurement ──────────────────────────────────────────────────

test('topbarOffsetPx adds the offset to the measured height and ignores nonsense', () => {
  assert.equal(topbarOffsetPx(28), 48)
  assert.equal(topbarOffsetPx(27.2), 48)
  assert.equal(topbarOffsetPx(0), 20)
  assert.equal(topbarOffsetPx(Number.NaN), 20)
  assert.equal(topbarOffsetPx(-5), 20)
})

test('observeTopbarHeight publishes on mount and on every resize (wrapped rows), then disconnects', () => {
  let height = 28
  const el = { getBoundingClientRect: () => ({ height }) }
  const props: Record<string, string> = {}
  const root = { style: { setProperty: (n: string, v: string) => { props[n] = v } } }
  let trigger: () => void = () => {}
  let disconnected = false
  class FakeRO {
    constructor(cb: () => void) { trigger = cb }
    observe() {}
    disconnect() { disconnected = true }
  }
  const stop = observeTopbarHeight(el, root, FakeRO)
  assert.equal(props['--topbar-h'], '48px')
  height = 62 // the bar wrapped onto a second row
  trigger()
  assert.equal(props['--topbar-h'], '82px')
  stop()
  assert.equal(disconnected, true)
})

test('observeTopbarHeight without ResizeObserver still publishes once', () => {
  const props: Record<string, string> = {}
  const stop = observeTopbarHeight(
    { getBoundingClientRect: () => ({ height: 30 }) },
    { style: { setProperty: (n, v) => { props[n] = v } } },
    undefined,
  )
  assert.equal(props['--topbar-h'], '50px')
  assert.doesNotThrow(stop)
})
