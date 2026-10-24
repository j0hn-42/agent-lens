/**
 * Scope selector, pure part (#291): what the relay says it scans (GET /status), the choices offered, the text
 * that states the scope, and the POST /scope client. No React here.
 */
import './all-locales' // #662: both languages are loaded before the tests
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionInfo } from '../web/lib/bridge-types'
import {
  parseRelayScopeState, scopeValue, parseScopeValue, scopeOptions, planScopeChoice, scopeSummary, scopeNotices,
  scopeEmptyHint, applyRelayScope, runtimeProblemRecheckDelay, runtimeRecheckKey, scopeLossNotices, type RelayScopeState,
} from '../web/lib/relay-scope'
import { restrictToProject } from '../web/hooks/simulation/session-visibility'
import { sanitizePref, sanitizePrefs, DEFAULT_UI_PREFS } from '../web/lib/ui-preferences'

const status = (over: Record<string, unknown> = {}) => ({
  relayVersion: '1', workspace: '/home/me/code/alpha', runtimes: ['claude'], hooksConfigured: true, disable1MContext: false,
  sessionCount: 2, allWorkspaces: false,
  skippedSessions: { watchLimit: 0, sizeLimit: 0, fileLimit: 0 },
  discovery: { projectDirsCapped: false, maxProjectDirs: 200, maxFilesPerDir: 500 },
  ...over,
})
const state = (over: Partial<RelayScopeState> = {}): RelayScopeState => ({ ...parseRelayScopeState(status())!, ...over })
const sess = (id: string, projectId?: string, projectName?: string): SessionInfo =>
  ({ id, label: id, status: 'active', startTime: 0, lastActivityTime: 1, ...(projectId ? { projectId, projectName } : {}) }) as SessionInfo

test('parseRelayScopeState reads what the relay reports, strictly', () => {
  const s = parseRelayScopeState(status())!
  assert.equal(s.scope, 'workspace')
  assert.equal(s.workspace, '/home/me/code/alpha')
  assert.deepEqual(s.discovery, { projectDirsCapped: false, maxProjectDirs: 200, maxFilesPerDir: 500, skipped: { watchLimit: 0, sizeLimit: 0, fileLimit: 0 } })
  assert.equal(parseRelayScopeState(status({ allWorkspaces: true }))!.scope, 'all')
})

test('parseRelayScopeState refuses what it cannot prove', () => {
  for (const bad of [null, undefined, 'x', 3, [], {}, status({ allWorkspaces: 'yes' }), status({ allWorkspaces: 1 }), status({ workspace: 4 })]) {
    assert.equal(parseRelayScopeState(bad), null, JSON.stringify(bad))
  }
})

test('an older relay (no ceilings reported) keeps its scope but claims nothing about the ceilings', () => {
  const old = parseRelayScopeState({ ...status(), discovery: undefined, skippedSessions: { watchLimit: 0, sizeLimit: 0 } })!
  assert.equal(old.scope, 'workspace')
  assert.equal(old.discovery, null)
  assert.deepEqual(scopeNotices(old), [])
})

test('malformed ceilings are dropped, not guessed', () => {
  const s = parseRelayScopeState(status({ discovery: { projectDirsCapped: 'true', maxProjectDirs: -1, maxFilesPerDir: 'a' } }))!
  assert.equal(s.discovery, null)
  const t = parseRelayScopeState(status({ skippedSessions: { watchLimit: -3, sizeLimit: 1.5, fileLimit: 'x' } }))!
  assert.equal(t.discovery, null)
})

test('select values round-trip and refuse anything else', () => {
  assert.equal(scopeValue('workspace', null), 'workspace')
  assert.equal(scopeValue('all', null), 'all')
  assert.equal(scopeValue('all', 'p1'), 'project:p1')
  assert.deepEqual(parseScopeValue('workspace'), { kind: 'workspace' })
  assert.deepEqual(parseScopeValue('all'), { kind: 'all' })
  assert.deepEqual(parseScopeValue('project:p1'), { kind: 'project', projectId: 'p1' })
  for (const bad of ['', 'project:', 'project', 'everything', 'ALL', `project:${'x'.repeat(300)}`, 'all ', null, undefined, 4]) {
    assert.equal(parseScopeValue(bad as string), null, String(bad))
  }
})

test('options: this workspace, all workspaces, then the projects present in the list, by name', () => {
  const sessions = [sess('1', 'pb', 'beta'), sess('2', 'pa', 'alpha'), sess('3', 'pa', 'alpha'), sess('4')]
  assert.deepEqual(scopeOptions(sessions), [
    { value: 'workspace', label: 'This workspace' },
    { value: 'all', label: 'All workspaces' },
    { value: 'project:pa', label: 'Project: alpha' },
    { value: 'project:pb', label: 'Project: beta' },
  ])
  assert.deepEqual(scopeOptions([]).map(o => o.value), ['workspace', 'all'])
})

test('choosing: the relay scope follows workspace/all; a project keeps the scope and sets the filter', () => {
  assert.deepEqual(planScopeChoice({ kind: 'workspace' }, 'all'), { relayScope: 'workspace', projectId: null })
  assert.deepEqual(planScopeChoice({ kind: 'all' }, 'workspace'), { relayScope: 'all', projectId: null })
  assert.deepEqual(planScopeChoice({ kind: 'project', projectId: 'p1' }, 'all'), { relayScope: 'all', projectId: 'p1' })
  assert.deepEqual(planScopeChoice({ kind: 'project', projectId: 'p1' }, 'workspace'), { relayScope: 'workspace', projectId: 'p1' })
})

test('the summary states the scope that is really scanned, with the workspace name', () => {
  assert.equal(scopeSummary(state()), 'Scanning this workspace only (alpha)')
  assert.equal(scopeSummary(state({ scope: 'all' })), null)
  assert.equal(scopeSummary(state({ workspace: 'C:\\Users\\me\\code\\beta' })), 'Scanning this workspace only (beta)')
})

test('an empty list on this workspace says the scope is limited; on all workspaces it does not', () => {
  assert.match(scopeEmptyHint(state())!, /only the sessions of this workspace/i)
  assert.match(scopeEmptyHint(state())!, /All workspaces/)
  assert.equal(scopeEmptyHint(state({ scope: 'all' })), null)
  assert.equal(scopeEmptyHint(null), null, 'scope unknown (no relay): nothing is claimed')
})

test('ceilings that were hit are listed, with their numbers; none hit, nothing is shown', () => {
  assert.deepEqual(scopeNotices(state()), [])
  const hit = state({ scope: 'all', discovery: { projectDirsCapped: true, maxProjectDirs: 200, maxFilesPerDir: 500, skipped: { watchLimit: 3, sizeLimit: 1, fileLimit: 2 } } })
  const notices = scopeNotices(hit)
  assert.equal(notices.length, 3)
  assert.ok(!notices.some(n => /project folders/.test(n)))
  assert.ok(notices.some(n => /at least 2/i.test(n) && /500/.test(n)))
  assert.ok(notices.some(n => /at least 1/i.test(n) && /too large/i.test(n)))
  assert.ok(notices.some(n => /at least 3/i.test(n) && /limit/i.test(n)))
})

test('#420: a runtime the relay reports unusable (database not found) is stated, word for word', () => {
  const s = parseRelayScopeState(status({ runtimes: ['opencode'], runtimeProblems: [{ runtime: 'opencode', message: 'OpenCode: database not found.' }] }))!
  assert.deepEqual(s.runtimeProblems, [{ runtime: 'opencode', message: 'OpenCode: database not found.' }])
  assert.deepEqual(scopeNotices(s), ['OpenCode: database not found.'])
  // An older relay, or one with nothing to report: nothing is claimed
  assert.deepEqual(parseRelayScopeState(status())!.runtimeProblems, [])
})

test('#420: runtime problems are read strictly and bounded', () => {
  const parse = (runtimeProblems: unknown) => parseRelayScopeState(status({ runtimes: ['opencode'], runtimeProblems }))!.runtimeProblems ?? []
  // Not a list, or entries of the wrong shape: dropped, never shown
  assert.deepEqual(parse('OpenCode: down'), [])
  assert.deepEqual(parse([{ runtime: 'opencode' }, { message: 'x' }, { runtime: 'opencode', message: '' }, null, 3]), [])
  // A runtime the relay does not watch is not trusted
  assert.deepEqual(parse([{ runtime: 'codex', message: 'Codex: down' }]), [])
  // Control characters are removed and the text is capped
  const [one] = parse([{ runtime: 'opencode', message: `OpenCode: \u001b[2Jbad${'x'.repeat(1000)}` }])
  assert.equal(/[\u0000-\u001f]/.test(one.message), false)
  // The one definition of forbidden characters (web/lib/control-chars.ts): bidi and invisible ones too
  const [bidi] = parse([{ runtime: 'opencode', message: 'OpenCode: \u202eevil\u200b\u2066x\ufeff' }])
  assert.equal(bidi.message, 'OpenCode: evilx')
  assert.ok(one.message.length <= 300)
  // At most one entry per watched runtime
  assert.equal(parse([{ runtime: 'opencode', message: 'a' }, { runtime: 'opencode', message: 'b' }]).length, 1)
})

test('#420: losses outside the followed sessions are stated as lower bounds, in the page language', () => {
  const s = parseRelayScopeState(status({ runtimes: ['opencode'], runtimeLosses: [{ runtime: 'opencode', unreadableRows: 2, missedUpdates: 1 }] }))!
  assert.deepEqual(s.runtimeLosses, [{ runtime: 'opencode', unreadableRows: 2, missedUpdates: 1 }])
  assert.deepEqual(scopeLossNotices(s), [
    'OpenCode: at least 1 update not read outside the followed sessions.',
    'OpenCode: at least 2 unreadable rows ignored outside the followed sessions.',
  ])
  assert.deepEqual(scopeLossNotices(s, 'fr'), [
    'OpenCode : au moins 1 mise à jour non lue hors des sessions suivies.',
    'OpenCode : au moins 2 lignes illisibles ignorées hors des sessions suivies.',
  ])
  // The count grows while the relay runs: it stays out of the notices of the live region, so a rise is not announced again
  assert.deepEqual(scopeNotices(s), [])
  // A zero is not a loss: no sentence for it
  const one = parseRelayScopeState(status({ runtimes: ['opencode'], runtimeLosses: [{ runtime: 'opencode', unreadableRows: 0, missedUpdates: 3 }] }))!
  assert.deepEqual(scopeLossNotices(one), ['OpenCode: at least 3 updates not read outside the followed sessions.'])
  // An older relay, or nothing lost: nothing is claimed
  assert.deepEqual(parseRelayScopeState(status())!.runtimeLosses, [])
  // The count only grows while the relay runs: it is read again on the same schedule as a problem, so it does not stay behind
  assert.equal(runtimeProblemRecheckDelay(s, 0), 5_000)
  assert.equal(runtimeProblemRecheckDelay(s, 20), 60_000)
})

test('#420: runtime losses are read strictly and bounded', () => {
  const parse = (runtimeLosses: unknown) => parseRelayScopeState(status({ runtimes: ['opencode'], runtimeLosses }))!.runtimeLosses ?? []
  assert.deepEqual(parse('3 lost'), [])
  // Not counts: dropped, never shown as a number
  assert.deepEqual(parse([
    { runtime: 'opencode', unreadableRows: -1, missedUpdates: 1 },
    { runtime: 'opencode', unreadableRows: 1.5, missedUpdates: 1 },
    { runtime: 'opencode', unreadableRows: '2', missedUpdates: 1 },
    { runtime: 'opencode', missedUpdates: 1 },
    null, 3,
  ]), [])
  assert.deepEqual(parse([{ runtime: 'opencode', unreadableRows: 0, missedUpdates: 0 }]), [], 'nothing lost is no entry')
  // A runtime the relay does not watch is not trusted
  assert.deepEqual(parse([{ runtime: 'codex', unreadableRows: 1, missedUpdates: 1 }]), [])
  // A watched runtime the page cannot name is not put raw into a translated sentence
  const future = parseRelayScopeState(status({ runtimes: ['opencode', 'x'.repeat(500)], runtimeLosses: [{ runtime: 'x'.repeat(500), unreadableRows: 1, missedUpdates: 0 }] }))!
  assert.deepEqual(future.runtimeLosses, [])
  // At most one entry per watched runtime
  assert.equal(parse([{ runtime: 'opencode', unreadableRows: 1, missedUpdates: 0 }, { runtime: 'opencode', unreadableRows: 2, missedUpdates: 0 }]).length, 1)
})

test('#420: GET /status is read again while a runtime problem is shown, never more often than its schedule', () => {
  const shown = parseRelayScopeState(status({ runtimes: ['opencode'], runtimeProblems: [{ runtime: 'opencode', message: 'OpenCode: database not found.' }] }))!
  const delays = Array.from({ length: 12 }, (_, i) => runtimeProblemRecheckDelay(shown, i))
  assert.equal(delays[0], 5_000, 'a notice that turned false is lifted within seconds')
  for (let i = 1; i < delays.length; i++) assert.ok(delays[i]! >= delays[i - 1]!, 'the delay never shrinks')
  // The re-read never stops while the notice is shown: a stale notice would claim a state that is no longer true
  assert.equal(delays[delays.length - 1], 60_000)
  // Nothing shown: nothing to re-read
  assert.equal(runtimeProblemRecheckDelay(parseRelayScopeState(status())!, 0), null)
  assert.equal(runtimeProblemRecheckDelay(null, 0), null)
  // A bad attempt number still gives a bounded delay
  assert.equal(runtimeProblemRecheckDelay(shown, -1), 5_000)
  assert.equal(runtimeProblemRecheckDelay(shown, Number.NaN), 5_000)
})

test('#420: the re-read schedule starts again from 5 s when the runtime problems change, not when a loss count grows', () => {
  const lossy = (n: number, problems: unknown[] = []) => parseRelayScopeState(status({
    runtimes: ['opencode'], runtimeProblems: problems, runtimeLosses: [{ runtime: 'opencode', unreadableRows: 0, missedUpdates: n }],
  }))
  const missing = [{ runtime: 'opencode', message: 'OpenCode: database not found.' }]
  assert.equal(runtimeRecheckKey(lossy(1)), runtimeRecheckKey(lossy(9)), 'a growing count keeps the schedule')
  assert.notEqual(runtimeRecheckKey(lossy(9)), runtimeRecheckKey(lossy(9, missing)), 'a new problem restarts it')
  assert.notEqual(runtimeRecheckKey(lossy(9, missing)), runtimeRecheckKey(lossy(9)), 'so does a problem that went away')
  assert.equal(runtimeRecheckKey(null), '')
})

test('applyRelayScope POSTs strict JSON and trusts only a coherent answer', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const ok = (body: unknown, status = 200) => async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  const r = await applyRelayScope('http://127.0.0.1:3001', 'all', ok({ scope: 'all', allWorkspaces: true }) as never)
  assert.deepEqual(r, { ok: true, scope: 'all' })
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/scope')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal((calls[0].init.headers as Record<string, string>)['Content-Type'], 'application/json')
  assert.equal(calls[0].init.body, '{"scope":"all"}')
  assert.equal(calls[0].init.cache, 'no-store')

  assert.equal((await applyRelayScope('', 'workspace', ok({ scope: 'workspace', allWorkspaces: false }) as never)).ok, true)
  assert.equal(calls[1].url, '/scope', 'same origin (standalone app)')
  // The answer contradicts the request or itself: not trusted
  for (const body of [{ scope: 'workspace', allWorkspaces: false }, { scope: 'all', allWorkspaces: false }, {}, null, 'x']) {
    assert.equal((await applyRelayScope('', 'all', ok(body) as never)).ok, false, JSON.stringify(body))
  }
  assert.equal((await applyRelayScope('', 'all', ok({ scope: 'all', allWorkspaces: true }, 405) as never)).ok, false)
  assert.equal((await applyRelayScope('', 'all', (async () => { throw new Error('down') }) as never)).ok, false)
})

test('the chosen scope is a validated, remembered preference (null = never chosen)', () => {
  assert.equal(DEFAULT_UI_PREFS.relayScope, null)
  assert.equal(sanitizePref('relayScope', 'all'), 'all')
  assert.equal(sanitizePref('relayScope', 'workspace'), 'workspace')
  for (const bad of ['ALL', 'project', '', 1, true, null, {}, ['all']]) assert.equal(sanitizePref('relayScope', bad), null, JSON.stringify(bad))
  assert.equal(sanitizePrefs({ relayScope: 'all' }).relayScope, 'all')
})

test('a project scope narrows the sessions the All view shows, and never invents any', () => {
  const sessions = [sess('1', 'pa', 'alpha'), sess('2', 'pb', 'beta'), sess('3', 'pa', 'alpha'), sess('4')]
  assert.equal(restrictToProject(null, sessions, null), null, 'no project: unchanged')
  assert.deepEqual([...restrictToProject(null, sessions, 'pa')!].sort(), ['1', '3'], 'everything shown, narrowed to the project')
  assert.deepEqual([...restrictToProject(new Set(['1', '2']), sessions, 'pa')!], ['1'], 'only active ones stay')
  assert.equal(restrictToProject(null, sessions, 'gone'), null, 'a project nobody belongs to any more is ignored (the view is not emptied)')
  assert.equal(restrictToProject(new Set(['2']), sessions, 'gone')!.size, 1)
})
