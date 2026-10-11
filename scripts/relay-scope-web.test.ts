/**
 * Scope selector, pure part (#291): what the relay says it scans (GET /status), the choices offered, the text
 * that states the scope, and the POST /scope client. No React here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionInfo } from '../web/lib/bridge-types'
import {
  parseRelayScopeState, scopeValue, parseScopeValue, scopeOptions, planScopeChoice, scopeSummary, scopeNotices,
  scopeEmptyHint, applyRelayScope, type RelayScopeState,
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
  assert.equal(scopeSummary(state({ scope: 'all' })), 'Scanning all workspaces')
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
  assert.equal(notices.length, 4)
  assert.ok(notices.some(n => /first 200 project folders/.test(n)))
  assert.ok(notices.some(n => /at least 2/i.test(n) && /500/.test(n)))
  assert.ok(notices.some(n => /at least 1/i.test(n) && /too large/i.test(n)))
  assert.ok(notices.some(n => /at least 3/i.test(n) && /limit/i.test(n)))
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
