/**
 * Project context loader (#64): on-demand load, 60 s cache per session, anti-race token on session
 * change, manual refresh. Time and network are injected: no timer, no real fetch.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  PROJECT_CONTEXT_TTL_MS, createProjectContextLoader, fetchProjectContext, parseProjectContext,
  type ProjectContextData, type ContextState,
} from '../web/lib/project-context'

const data = (text: string): ProjectContextData => ({
  sessionId: 's', loadedAt: 1,
  files: [{ kind: 'claude-md', name: 'CLAUDE.md', found: true, text, bytes: text.length, truncated: false }],
  issues: [],
})

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setup() {
  let now = 1_000_000
  const calls: string[] = []
  const pending: Array<ReturnType<typeof deferred<ProjectContextData | 'unavailable'>>> = []
  const loader = createProjectContextLoader({
    now: () => now,
    fetchContext: (id) => { calls.push(id); const d = deferred<ProjectContextData | 'unavailable'>(); pending.push(d); return d.promise },
  })
  return { loader, calls, pending, advance: (ms: number) => { now += ms } }
}

test('nothing is loaded until load() is called', () => {
  const { loader, calls } = setup()
  assert.equal(loader.getState().status, 'idle')
  assert.equal(calls.length, 0)
})

test('load fetches once, then serves the cache for 60 s', async () => {
  assert.equal(PROJECT_CONTEXT_TTL_MS, 60_000)
  const { loader, calls, pending, advance } = setup()
  const p = loader.load('a')
  assert.equal(loader.getState().status, 'loading')
  pending[0].resolve(data('v1'))
  await p
  assert.equal(loader.getState().status, 'ready')
  advance(59_999)
  await loader.load('a')
  assert.equal(calls.length, 1, 'served from cache')
  advance(2)
  const p2 = loader.load('a')
  assert.equal(calls.length, 2, 'cache expired: reloaded')
  pending[1].resolve(data('v2'))
  await p2
  assert.equal((loader.getState() as Extract<ContextState, { status: 'ready' }>).data.files[0].text, 'v2')
})

test('manual refresh bypasses the cache', async () => {
  const { loader, calls, pending } = setup()
  const p = loader.load('a'); pending[0].resolve(data('v1')); await p
  const p2 = loader.load('a', { force: true })
  assert.equal(calls.length, 2)
  pending[1].resolve(data('v2')); await p2
})

test('a load already in flight for the same session is shared, a refresh still goes through', async () => {
  const { loader, calls, pending } = setup()
  const p1 = loader.load('a'); const p2 = loader.load('a')
  assert.equal(calls.length, 1)
  pending[0].resolve(data('v1')); await Promise.all([p1, p2])
})

test('anti-race: a slow answer for the previous session never replaces the current one', async () => {
  const { loader, pending } = setup()
  const pa = loader.load('a')
  const pb = loader.load('b')
  pending[1].resolve(data('B')); await pb
  pending[0].resolve(data('A')); await pa
  const s = loader.getState()
  assert.equal(s.status, 'ready')
  assert.equal(s.sessionId, 'b')
  assert.equal((s as Extract<ContextState, { status: 'ready' }>).data.files[0].text, 'B')
})

test('anti-race: a late error of the previous session is ignored too', async () => {
  const { loader, pending } = setup()
  const pa = loader.load('a')
  const pb = loader.load('b')
  pending[1].resolve(data('B')); await pb
  pending[0].reject(new Error('boom')); await pa
  assert.equal(loader.getState().status, 'ready')
})

test('the answer of an abandoned session is not cached as if it had been shown', async () => {
  const { loader, calls, pending } = setup()
  const pa = loader.load('a')
  const pb = loader.load('b')
  pending[1].resolve(data('B')); await pb
  pending[0].resolve(data('A')); await pa
  const p = loader.load('a')
  assert.equal(calls.length, 3, 'a is fetched again')
  pending[2].resolve(data('A2')); await p
})

test('an error is reported, not hidden, and a retry works', async () => {
  const { loader, pending } = setup()
  const p = loader.load('a'); pending[0].reject(new Error('HTTP 500')); await p
  const s = loader.getState()
  assert.equal(s.status, 'error')
  assert.match((s as Extract<ContextState, { status: 'error' }>).message, /HTTP 500/)
  const p2 = loader.load('a'); pending[1].resolve(data('ok')); await p2
  assert.equal(loader.getState().status, 'ready')
})

test('a failed refresh keeps the last data but marks it as stale', async () => {
  const { loader, pending } = setup()
  const p = loader.load('a'); pending[0].resolve(data('v1')); await p
  const p2 = loader.load('a', { force: true }); pending[1].reject(new Error('down')); await p2
  const s = loader.getState() as Extract<ContextState, { status: 'error' }>
  assert.equal(s.status, 'error')
  assert.equal(s.stale?.files[0].text, 'v1')
})

test('unavailable (no cwd known, 404) is its own state, not an empty context', async () => {
  const { loader, pending } = setup()
  const p = loader.load('a'); pending[0].resolve('unavailable'); await p
  assert.equal(loader.getState().status, 'unavailable')
})

test('subscribers are notified on every state change and can unsubscribe', async () => {
  const { loader, pending } = setup()
  const seen: string[] = []
  const off = loader.subscribe(() => seen.push(loader.getState().status))
  const p = loader.load('a'); pending[0].resolve(data('x')); await p
  assert.deepEqual(seen, ['loading', 'ready'])
  off()
  loader.reset()
  assert.deepEqual(seen, ['loading', 'ready'])
})

test('cache size is bounded', async () => {
  const { loader, calls, pending } = setup()
  for (let i = 0; i < 40; i++) { const p = loader.load(`s${i}`); pending[i].resolve(data('x')); await p }
  const p = loader.load('s0')
  assert.equal(calls.length, 41, 'the oldest entry was evicted')
  pending[40].resolve(data('x')); await p
})

test('parseProjectContext rejects malformed payloads and keeps only known fields', () => {
  assert.equal(parseProjectContext(null), null)
  assert.equal(parseProjectContext({ files: 'x' }), null)
  assert.equal(parseProjectContext({ sessionId: 's', loadedAt: 1, files: [{ kind: 'evil', name: 'x', found: true, text: '', bytes: 0, truncated: false }], issues: [] }), null)
  assert.equal(parseProjectContext({ sessionId: 's', loadedAt: 1, files: [{ kind: 'memory', name: 'x', found: false, unreadable: 'weird', text: '', bytes: 0, truncated: false }], issues: [] }), null)
  const unr = parseProjectContext({ sessionId: 's', loadedAt: 1, files: [{ kind: 'claude-md', name: 'CLAUDE.md', found: false, unreadable: 'symlink', text: '', bytes: 0, truncated: false }], issues: [] })
  assert.equal(unr?.files[0].unreadable, 'symlink')
  const ok = parseProjectContext({ sessionId: 's', loadedAt: 5, files: data('t').files, issues: [3, 'x', -1, 2.5, 7], extra: 1 })
  assert.deepEqual(ok?.issues, [3, 7])
  assert.equal(ok?.loadedAt, 5)
})

test('fetchProjectContext maps HTTP statuses', async () => {
  const mk = (status: number, body: unknown) => (async () => ({ ok: status < 300, status, json: async () => body })) as unknown as typeof fetch
  assert.equal(await fetchProjectContext('http://r', 'a', undefined, mk(404, null)), 'unavailable')
  await assert.rejects(fetchProjectContext('http://r', 'a', undefined, mk(500, null)), /HTTP 500/)
  await assert.rejects(fetchProjectContext('http://r', 'a', undefined, mk(200, { nope: 1 })), /invalid/i)
  const ok = await fetchProjectContext('http://r', 'a', undefined, mk(200, data('t')))
  assert.notEqual(ok, 'unavailable')
})

test('fetchProjectContext encodes the session id in the query', async () => {
  let url = ''
  const f = (async (u: string) => { url = u; return { ok: false, status: 404, json: async () => null } }) as unknown as typeof fetch
  await fetchProjectContext('http://r', 'a b&c', undefined, f)
  assert.equal(url, 'http://r/context?session=a%20b%26c')
})
