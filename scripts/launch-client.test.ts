/**
 * Launch client, pure part (#229, tranche 3): the POST /launch and /launch/<id>/stop requests, the fixed messages of
 * each refusal (French and English catalog), the reducer of the `launch` / `launch-list` SSE and the state words.
 * Tested through the exports the UI uses (postLaunch, postStop, reduceLaunches...). No React here.
 */
import './all-locales' // #662: both languages are loaded before the tests
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LaunchView } from '../web/lib/bridge-types'
import {
  reduceLaunches, launchStateLabel as frLabel, parseLaunchStatus, isLaunchMessage, repoOfIssueUrl, launchCommandPreview,
  activeLaunchFor, isLaunchEnded, postLaunch, postStop, LAUNCH_WALL_CLOCK_MIN, type FetchLike,
} from '../web/lib/launch-client'
import { buildLaunchCommand, LAUNCH_CAPS } from '../extension/src/launch-policy'

const TOKEN = 'a'.repeat(64)
const view = (over: Partial<LaunchView> = {}): LaunchView => ({
  id: '0123456789abcdef', repo: 'o/r', issue: 7, role: 'qa-engineer', worktree: 'issue-7-qa-engineer',
  sessionId: '0f6c3a1e-58b2-4c1d-9a0e-2b7d4e5f6a7b', state: 'requested', requestedAt: 1_000,
  outputBytes: 0, outputDroppedBytes: 0, ...over,
})
type Sent = { url: string; init: Parameters<FetchLike>[1] }
/** A fetch that records what it was asked and answers `status` with `body` */
const recorder = (status = 202, body: unknown = view()) => {
  const sent: Sent[] = []
  let bodyRead = false
  const fetchFn: FetchLike = async (url, init) => {
    sent.push({ url, init })
    return { ok: status >= 200 && status < 300, status, json: async () => { bodyRead = true; return body } }
  }
  return { sent, fetchFn, bodyRead: () => bodyRead }
}
const REQ = { repo: 'o/r', issue: 7, role: 'qa-engineer' }
const refusal = async (status: number, kind: 'launch' | 'stop', locale: 'fr' | 'en'): Promise<string> => {
  const r = recorder(status, { error: '<img src=x onerror=alert(1)> Titre hostile' })
  const out = kind === 'launch'
    ? await postLaunch(r.fetchFn, '', REQ, TOKEN, locale)
    : await postStop(r.fetchFn, '', '0123456789abcdef', TOKEN, locale)
  assert.equal(out.ok, false)
  assert.equal(r.bodyRead(), false, 'the body of a refusal is never read')
  return out.ok ? '' : out.message
}

test('POST /launch: strict body {repo, issue, role}, Bearer token, JSON content type', async () => {
  const r = recorder()
  await postLaunch(r.fetchFn, '', { ...REQ, title: 'x', extra: 1 } as never, TOKEN)
  assert.equal(r.sent.length, 1)
  const { url, init } = r.sent[0]
  assert.equal(url, '/launch')
  assert.equal(init.method, 'POST')
  assert.deepEqual(init.headers, { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' })
  assert.deepEqual(JSON.parse(init.body ?? ''), REQ)
  assert.deepEqual(Object.keys(JSON.parse(init.body ?? '')), ['repo', 'issue', 'role'], 'extra fields of the caller never reach the body')
  assert.equal(init.cache, 'no-store')
})

test('the token never goes into the URL, and is trimmed of the spaces a paste adds', async () => {
  const r = recorder()
  await postLaunch(r.fetchFn, 'http://127.0.0.1:3001', REQ, `  ${TOKEN}\n`)
  assert.equal(r.sent[0].url, 'http://127.0.0.1:3001/launch')
  assert.ok(!r.sent[0].url.includes(TOKEN))
  assert.equal(r.sent[0].init.headers.Authorization, `Bearer ${TOKEN}`)
})

test('POST /launch/<id>/stop: Bearer token, no body, id checked', async () => {
  const r = recorder()
  const out = await postStop(r.fetchFn, '', '0123456789abcdef', TOKEN)
  assert.equal(out.ok, true)
  assert.equal(r.sent[0].url, '/launch/0123456789abcdef/stop')
  assert.equal(r.sent[0].init.method, 'POST')
  assert.equal(r.sent[0].init.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(r.sent[0].init.body, undefined)
  const bad = recorder()
  const refused = await postStop(bad.fetchFn, '', '../status', TOKEN)
  assert.equal(refused.ok, false)
  assert.equal(bad.sent.length, 0, 'an id that is not 16 hex digits sends nothing')
})

test('each refusal code has a fixed French message; the body and the title are never echoed', async () => {
  const codes = [401, 403, 404, 409, 413, 415, 422, 429, 502]
  const messages = await Promise.all(codes.map(c => refusal(c, 'launch', 'fr')))
  assert.equal(new Set(messages).size, codes.length, 'one distinct message per code')
  for (const m of messages) {
    assert.ok(m.length > 10)
    assert.match(m, /[a-zàâçéèêëîïôûùüÿœ]/, 'a sentence, not a code')
    assert.ok(!m.includes('hostile') && !m.includes('<img'))
  }
  assert.match(await refusal(401, 'launch', 'fr'), /jeton/i)
  assert.match(await refusal(422, 'launch', 'fr'), /agent:/)
  assert.match(await refusal(429, 'launch', 'fr'), /plus tard|limite/i)
  assert.match(await refusal(418, 'launch', 'fr'), /418/, 'an unexpected code says its number, nothing else')
  assert.match(await refusal(404, 'stop', 'fr'), /inconnu/i)
  assert.match(await refusal(409, 'stop', 'fr'), /terminé/i)
  // The English catalog has the same codes, in English
  assert.match(await refusal(401, 'launch', 'en'), /token/i)
  assert.equal(new Set(await Promise.all(codes.map(c => refusal(c, 'launch', 'en')))).size, codes.length)
})

test('postLaunch: a network failure says the relay did not answer; an accepted answer gives the view, never an invented one', async () => {
  const down = await postLaunch(async () => { throw new TypeError('Failed to fetch') }, '', REQ, TOKEN, 'fr')
  assert.equal(down.ok, false)
  if (!down.ok) assert.match(down.message, /relais.*même origine/)
  const accepted = await postLaunch(recorder(202, view()).fetchFn, '', REQ, TOKEN)
  assert.equal(accepted.ok, true)
  if (accepted.ok) assert.equal(accepted.launch?.id, '0123456789abcdef')
  const odd = await postLaunch(recorder(202, { nope: 1 }).fetchFn, '', REQ, TOKEN)
  assert.equal(odd.ok, true, 'accepted by the relay even if the answer is unreadable')
  if (odd.ok) assert.equal(odd.launch, null, 'but no view is invented')
})

test('a view of the relay is kept when well formed, refused otherwise, and only known fields are copied', () => {
  const one = (v: unknown) => reduceLaunches(new Map(), { type: 'launch', launch: v })
  assert.deepEqual(one(view({ pid: 42, state: 'started', startedAt: 2 })).get('0123456789abcdef'), view({ pid: 42, state: 'started', startedAt: 2 }))
  for (const bad of [{ ...view(), state: 'running' }, { ...view(), id: 'x' }, { ...view(), issue: -1 }, null]) {
    assert.equal(one(bad).size, 0)
  }
  const odd = one({ ...view(), pid: 'x', worktreePath: 5, extra: 'dropped' }).get('0123456789abcdef')
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

test('the reducer merges `launch` into a Map by id', () => {
  let m: ReadonlyMap<string, LaunchView> = new Map()
  m = reduceLaunches(m, { type: 'launch', launch: view() })
  assert.equal(m.size, 1)
  m = reduceLaunches(m, { type: 'launch', launch: view({ state: 'started', pid: 9, startedAt: 2 }) })
  assert.equal(m.size, 1)
  assert.equal(m.get('0123456789abcdef')!.pid, 9)
  m = reduceLaunches(m, { type: 'launch', launch: view({ id: 'fedcba9876543210', issue: 8 }) })
  assert.equal(m.size, 2)
  const same = reduceLaunches(m, { type: 'other' })
  assert.equal(same, m, 'another message leaves the map as is')
  const bad = reduceLaunches(m, { type: 'launch', launch: { id: 'nope' } })
  assert.equal(bad, m, 'a malformed launch changes nothing')
  assert.ok(isLaunchMessage({ type: 'launch' }) && isLaunchMessage({ type: 'launch-list' }) && !isLaunchMessage({ type: 'agent-event' }))
})

test('`launch-list` is a snapshot that replaces the map, an empty one included; a list of junk proves nothing and changes nothing', () => {
  const a = view(), b = view({ id: 'fedcba9876543210', issue: 8 })
  const m: ReadonlyMap<string, LaunchView> = reduceLaunches(new Map(), { type: 'launch-list', launches: [a, b] })
  assert.equal(m.size, 2)
  const swapped = reduceLaunches(m, { type: 'launch-list', launches: [b, { junk: 1 }] })
  assert.deepEqual([...swapped.keys()], [b.id], 'what the relay no longer lists is dropped')
  assert.equal(reduceLaunches(m, { type: 'launch-list', launches: [] }).size, 0, 'an empty snapshot empties the map')
  assert.equal(reduceLaunches(m, { type: 'launch-list', launches: [{ junk: 1 }] }), m, 'unreadable list: nothing is proven, nothing changes')
  assert.equal(reduceLaunches(m, { type: 'launch-list' }), m, 'no list at all')
})

test('the reducer stays bounded: the oldest requests are dropped first', () => {
  let m: ReadonlyMap<string, LaunchView> = new Map()
  const KEPT = 50 // LAUNCHES_KEPT: the relay keeps the last 20 finished plus the running ones
  for (let i = 0; i < KEPT + 5; i++) {
    m = reduceLaunches(m, { type: 'launch', launch: view({ id: i.toString(16).padStart(16, '0'), requestedAt: i }) })
  }
  assert.equal(m.size, KEPT)
  assert.ok(!m.has('0'.repeat(16)))
})

test('state words come from an observed fact only', () => {
  const launchStateLabel = (v: LaunchView) => frLabel(v, 'fr')
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
  // Same rule in English
  assert.ok(!/Started/.test(frLabel(view({ state: 'started' }), 'en')))
  assert.match(frLabel(view({ state: 'session', pid: 42, sessionSeenAt: 3 }), 'en'), /session seen/)
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
