/**
 * Launch client, pure part (#229, tranche 3): the POST /launch and /launch/<id>/stop requests, the fixed French
 * messages of each refusal, the reducer of the `launch` / `launch-list` SSE and the state words. No React here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LaunchView } from '../web/lib/bridge-types'
import {
  buildLaunchRequest, buildStopRequest, launchErrorMessage, reduceLaunches, launchStateLabel, parseLaunchView,
  parseLaunchStatus, isLaunchMessage, repoOfIssueUrl, launchCommandPreview, activeLaunchFor, isLaunchEnded,
  postLaunch, LAUNCH_WALL_CLOCK_MIN, LAUNCHES_KEPT,
} from '../web/lib/launch-client'
import { buildLaunchCommand, LAUNCH_CAPS } from '../extension/src/launch-policy'

const TOKEN = 'a'.repeat(64)
const view = (over: Partial<LaunchView> = {}): LaunchView => ({
  id: '0123456789abcdef', repo: 'o/r', issue: 7, role: 'qa-engineer', worktree: 'issue-7-qa-engineer',
  sessionId: '0f6c3a1e-58b2-4c1d-9a0e-2b7d4e5f6a7b', state: 'requested', requestedAt: 1_000,
  outputBytes: 0, outputDroppedBytes: 0, ...over,
})

test('POST /launch: strict body {repo, issue, role}, Bearer token, JSON content type', () => {
  const req = buildLaunchRequest('', { repo: 'o/r', issue: 7, role: 'qa-engineer' }, TOKEN)
  assert.equal(req.url, '/launch')
  assert.equal(req.init.method, 'POST')
  assert.deepEqual(req.init.headers, { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' })
  assert.deepEqual(JSON.parse(req.init.body), { repo: 'o/r', issue: 7, role: 'qa-engineer' })
  assert.deepEqual(Object.keys(JSON.parse(req.init.body)), ['repo', 'issue', 'role'])
  assert.equal(req.init.cache, 'no-store')
  // Extra fields of the caller never reach the body
  const extra = buildLaunchRequest('', { repo: 'o/r', issue: 7, role: 'qa-engineer', title: 'x', __proto__: {} } as never, TOKEN)
  assert.deepEqual(Object.keys(JSON.parse(extra.init.body)), ['repo', 'issue', 'role'])
})

test('the token never goes into the URL, and is trimmed of the spaces a paste adds', () => {
  const req = buildLaunchRequest('http://127.0.0.1:3001', { repo: 'o/r', issue: 7, role: 'r' }, `  ${TOKEN}\n`)
  assert.equal(req.url, 'http://127.0.0.1:3001/launch')
  assert.ok(!req.url.includes(TOKEN))
  assert.equal(req.init.headers.Authorization, `Bearer ${TOKEN}`)
})

test('POST /launch/<id>/stop: Bearer token, no body content, id checked', () => {
  const req = buildStopRequest('', '0123456789abcdef', TOKEN)
  assert.ok(req)
  assert.equal(req.url, '/launch/0123456789abcdef/stop')
  assert.equal(req.init.method, 'POST')
  assert.equal(req.init.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(buildStopRequest('', '../status', TOKEN), null, 'an id that is not 16 hex digits builds no request')
})

test('each refusal code has a fixed French message; the body and the title are never echoed', () => {
  const codes = [401, 403, 404, 409, 413, 415, 422, 429, 502]
  const messages = codes.map(c => launchErrorMessage(c))
  assert.equal(new Set(messages).size, codes.length, 'one distinct message per code')
  for (const m of messages) {
    assert.ok(m.length > 10)
    assert.match(m, /[a-zàâçéèêëîïôûùüÿœ]/, 'a sentence, not a code')
  }
  assert.match(launchErrorMessage(401), /jeton/i)
  assert.match(launchErrorMessage(422), /agent:/)
  assert.match(launchErrorMessage(429), /plus tard|limite/i)
  // The signature takes no body: a hostile body cannot reach the text
  assert.equal(launchErrorMessage.length <= 2, true)
  assert.match(launchErrorMessage(418), /418/, 'an unexpected code says its number, nothing else')
  assert.match(launchErrorMessage(404, 'stop'), /inconnu/i)
  assert.match(launchErrorMessage(409, 'stop'), /terminé/i)
})

test('postLaunch: a refusal gives the fixed message without reading the body; a network failure says the relay did not answer', async () => {
  let bodyRead = false
  const refused = await postLaunch(async () => ({
    ok: false, status: 422,
    json: async () => { bodyRead = true; return { error: '<img src=x onerror=alert(1)> Titre hostile' } },
  }), '', { repo: 'o/r', issue: 7, role: 'r' }, TOKEN)
  assert.equal(refused.ok, false)
  if (!refused.ok) {
    assert.equal(refused.message, launchErrorMessage(422))
    assert.ok(!refused.message.includes('hostile'))
  }
  assert.equal(bodyRead, false)
  const down = await postLaunch(async () => { throw new TypeError('Failed to fetch') }, '', { repo: 'o/r', issue: 7, role: 'r' }, TOKEN)
  assert.equal(down.ok, false)
  if (!down.ok) assert.match(down.message, /relais/)
  const accepted = await postLaunch(async () => ({ ok: true, status: 202, json: async () => view() }), '', { repo: 'o/r', issue: 7, role: 'r' }, TOKEN)
  assert.equal(accepted.ok, true)
  if (accepted.ok) assert.equal(accepted.launch?.id, '0123456789abcdef')
  const odd = await postLaunch(async () => ({ ok: true, status: 202, json: async () => ({ nope: 1 }) }), '', { repo: 'o/r', issue: 7, role: 'r' }, TOKEN)
  assert.equal(odd.ok, true, 'accepted by the relay even if the answer is unreadable')
  if (odd.ok) assert.equal(odd.launch, null, 'but no view is invented')
})

test('parseLaunchView keeps a well-formed view and refuses the rest', () => {
  assert.deepEqual(parseLaunchView(view({ pid: 42, state: 'started', startedAt: 2 })), view({ pid: 42, state: 'started', startedAt: 2 }))
  assert.equal(parseLaunchView({ ...view(), state: 'running' }), null)
  assert.equal(parseLaunchView({ ...view(), id: 'x' }), null)
  assert.equal(parseLaunchView({ ...view(), issue: -1 }), null)
  assert.equal(parseLaunchView(null), null)
  const odd = parseLaunchView({ ...view(), pid: 'x', worktreePath: 5, extra: 'dropped' })
  assert.ok(odd)
  assert.equal(odd!.pid, undefined)
  assert.equal(odd!.worktreePath, undefined)
  assert.equal((odd as unknown as Record<string, unknown>).extra, undefined)
})

test('parseLaunchStatus reads status.launch; absent means launching is off', () => {
  assert.equal(parseLaunchStatus({ relayVersion: '1' }), null)
  assert.equal(parseLaunchStatus(null), null)
  const s = parseLaunchStatus({ launch: { maxConcurrent: 2, launches: [view(), { bad: true }] } })
  assert.ok(s)
  assert.equal(s!.maxConcurrent, 2)
  assert.deepEqual(s!.launches.map(l => l.id), ['0123456789abcdef'])
  assert.equal(parseLaunchStatus({ launch: { maxConcurrent: 'x', launches: [] } }), null)
})

test('the reducer merges `launch` and `launch-list` into a Map by id', () => {
  let m: ReadonlyMap<string, LaunchView> = new Map()
  m = reduceLaunches(m, { type: 'launch', launch: view() })
  assert.equal(m.size, 1)
  m = reduceLaunches(m, { type: 'launch', launch: view({ state: 'started', pid: 9, startedAt: 2 }) })
  assert.equal(m.size, 1)
  assert.equal(m.get('0123456789abcdef')!.pid, 9)
  m = reduceLaunches(m, { type: 'launch-list', launches: [view({ id: 'fedcba9876543210', issue: 8 }), { junk: 1 }] })
  assert.equal(m.size, 2)
  const same = reduceLaunches(m, { type: 'other' })
  assert.equal(same, m, 'another message leaves the map as is')
  const bad = reduceLaunches(m, { type: 'launch', launch: { id: 'nope' } })
  assert.equal(bad, m, 'a malformed launch changes nothing')
  assert.ok(isLaunchMessage({ type: 'launch' }) && isLaunchMessage({ type: 'launch-list' }) && !isLaunchMessage({ type: 'agent-event' }))
})

test('the reducer stays bounded: the oldest requests are dropped first', () => {
  let m: ReadonlyMap<string, LaunchView> = new Map()
  for (let i = 0; i < LAUNCHES_KEPT + 5; i++) {
    m = reduceLaunches(m, { type: 'launch', launch: view({ id: i.toString(16).padStart(16, '0'), requestedAt: i }) })
  }
  assert.equal(m.size, LAUNCHES_KEPT)
  assert.ok(!m.has('0'.repeat(16)))
})

test('state words come from an observed fact only', () => {
  assert.match(launchStateLabel(view()), /demandé/i)
  // No "démarré" without a pid
  assert.ok(!/démarré/i.test(launchStateLabel(view({ state: 'started' }))), 'started without pid is not "démarré"')
  assert.match(launchStateLabel(view({ state: 'started', pid: 42 })), /Démarré.*42/)
  // No "session vue" without sessionSeenAt
  assert.ok(!/session vue/i.test(launchStateLabel(view({ state: 'session', pid: 42 }))))
  assert.match(launchStateLabel(view({ state: 'session', pid: 42, sessionSeenAt: 3 })), /session vue/i)
  assert.match(launchStateLabel(view({ state: 'exited', exitCode: 0, endedAt: 5 })), /Terminé.*code 0/)
  assert.match(launchStateLabel(view({ state: 'exited', signal: 'SIGKILL', endedAt: 5 })), /SIGKILL/)
  assert.match(launchStateLabel(view({ state: 'stopped', endedAt: 5 })), /Arrêté/)
  assert.match(launchStateLabel(view({ state: 'expired', endedAt: 5 })), new RegExp(`${LAUNCH_WALL_CLOCK_MIN} min`))
  assert.match(launchStateLabel(view({ state: 'failed', failure: 'ENOENT' })), /Échec.*ENOENT/)
  assert.match(launchStateLabel(view({ state: 'started', pid: 42, stopRequestedAt: 4 })), /arrêt demandé/i)
  assert.ok(!/<|\n/.test(launchStateLabel(view({ state: 'failed', failure: '<b>\nx' }))), 'a failure code is shown cleaned')
})

test('ended / active launch of an issue', () => {
  assert.equal(isLaunchEnded(view()), false)
  assert.equal(isLaunchEnded(view({ state: 'exited' })), true)
  const m = new Map([['a', view({ id: 'a'.repeat(16), state: 'exited' })], ['b', view({ id: 'b'.repeat(16), state: 'started', pid: 1 })]])
  assert.equal(activeLaunchFor(m, 'o/r', 7)?.id, 'b'.repeat(16))
  assert.equal(activeLaunchFor(m, 'o/r', 8), undefined)
})

test('repository of an issue URL', () => {
  assert.equal(repoOfIssueUrl('https://github.com/o/r/issues/7'), 'o/r')
  assert.equal(repoOfIssueUrl('https://github.com/o/r/pull/7'), undefined)
  assert.equal(repoOfIssueUrl('https://evil.example/o/r/issues/7'), undefined)
})

test('the command shown in the dialog is the argv the relay builds, in the same order', () => {
  const req = { repo: 'o/r', issue: 7, role: 'qa-engineer' }
  const preview = launchCommandPreview(req)
  const built = buildLaunchCommand(req, { sessionId: '0f6c3a1e-58b2-4c1d-9a0e-2b7d4e5f6a7b' })
  assert.ok(built.ok)
  if (!built.ok) return
  // Every fixed argument shown is there, in the order the relay uses
  const shown = preview.split(/\s+/).filter(w => w.startsWith('-') && w !== '--')
  const argv = built.value.args
  let at = -1
  for (const flag of shown) {
    const i = argv.indexOf(flag, at + 1)
    assert.ok(i > at, `${flag} is in the relay's argv, in order`)
    at = i
  }
  assert.ok(preview.startsWith('claude -p --worktree issue-7-qa-engineer'))
  assert.ok(preview.includes('--permission-mode default'))
  assert.equal(LAUNCH_WALL_CLOCK_MIN, LAUNCH_CAPS.wallClockMs / 60_000)
})
