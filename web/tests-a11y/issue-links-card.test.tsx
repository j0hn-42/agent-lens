// Issue / PR links of an agent role (#63) on the real path: useIssueLinks (60 s cache, abort, eviction)
// and their rendering in AgentDetailCard, with a mocked fetch. The pure parsing is tested elsewhere.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, renderHook, cleanup, act, within } from '@testing-library/react'

import { AgentDetailCard } from '@/components/agent-visualizer/agent-detail-card'
import { useIssueLinks } from '@/hooks/use-issue-links'
import { createFreshnessClock } from '@/hooks/use-freshness-clock'

const g = globalThis as unknown as Record<string, unknown>
const realFetch = g.fetch
const ORIGIN = 'http://127.0.0.1:4321'

let fetched: Array<{ url: string; signal?: AbortSignal }> = []
let respond: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }> = async () => ({ ok: true, json: async () => ({ links: [] }) })

const link = (n: number, kind: 'issue' | 'pr' = 'issue') => ({
  kind, number: n, title: `Title ${n}`, state: 'open',
  url: `https://github.com/o/r/${kind === 'pr' ? 'pull' : 'issues'}/${n}`,
})
const ok = (links: unknown[]) => async () => ({ ok: true, json: async () => ({ role: 'x', links }) })

beforeEach(() => {
  fetched = []
  respond = ok([])
  g.fetch = (url: string, init?: { signal?: AbortSignal }) => { fetched.push({ url, signal: init?.signal }); return respond(url) }
})
afterEach(() => {
  cleanup()
  mock.timers.reset()
  g.fetch = realFetch
})

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

// Each test uses its own role: the hook cache is module-level
test('requests the role of the origin once, and returns the validated links', async () => {
  respond = ok([link(7), { ...link(8), url: 'https://evil.example/o/r/issues/8' }, link(9, 'pr')])
  const { result } = renderHook(() => useIssueLinks(ORIGIN, 'role-a'))
  await flush()
  assert.deepEqual(fetched.map(f => f.url), [`${ORIGIN}/issue-links?role=role-a`])
  assert.deepEqual(result.current.links.map(l => l.number), [7, 9], 'the foreign URL is dropped')
})

test('no relay or no role: nothing is requested and the list is empty', async () => {
  const none = renderHook(() => useIssueLinks(null, 'role-b'))
  const noRole = renderHook(() => useIssueLinks(ORIGIN, undefined))
  await flush()
  assert.equal(fetched.length, 0)
  assert.deepEqual(none.result.current.links, [])
  assert.deepEqual(noRole.result.current.links, [])
})

test('a failing relay is unavailable, not "no link": network error, non-ok, unreadable body', async () => {
  respond = async () => { throw new Error('network down') }
  const a = renderHook(() => useIssueLinks(ORIGIN, 'role-c'))
  await flush()
  assert.equal(a.result.current.status, 'unavailable')
  assert.deepEqual(a.result.current.links, [])
  respond = async () => ({ ok: false, status: 503, json: async () => ({}) })
  const b = renderHook(() => useIssueLinks(ORIGIN, 'role-c2'))
  await flush()
  assert.equal(b.result.current.status, 'unavailable')
  respond = async () => ({ ok: true, json: async () => ({ oops: true }) })
  const c = renderHook(() => useIssueLinks(ORIGIN, 'role-c3'))
  await flush()
  assert.equal(c.result.current.status, 'unavailable', 'a 200 without a links array is not "no link"')
})

const flushMicro = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
const busy = (retryAfter?: string) => async () => ({
  ok: false, status: 503, headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) }, json: async () => ({}),
})

test('503 then 200 with links: the links show on the second attempt, without waiting for the 60 s cache', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  let calls = 0
  respond = () => (++calls === 1 ? busy('1')() : ok([link(5)])())
  const { result } = renderHook(() => useIssueLinks(ORIGIN, 'role-g'))
  await flushMicro()
  assert.equal(result.current.status, 'unavailable')
  assert.equal(fetched.length, 1)
  mock.timers.tick(999)
  await flushMicro()
  assert.equal(fetched.length, 1, 'no tight loop: the retry waits for the backoff')
  mock.timers.tick(1)
  await flushMicro()
  assert.equal(fetched.length, 2)
  assert.equal(result.current.status, 'ok')
  assert.deepEqual(result.current.links.map(l => l.number), [5])
})

test('the retry honours Retry-After when it is longer than the backoff, and backs off exponentially, then stops', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  respond = busy('7')
  const { result } = renderHook(() => useIssueLinks(ORIGIN, 'role-h'))
  await flushMicro()
  mock.timers.tick(6_999)
  await flushMicro()
  assert.equal(fetched.length, 1, 'Retry-After: 7 is respected')
  respond = busy()
  mock.timers.tick(1)
  await flushMicro()
  assert.equal(fetched.length, 2)
  // next waits: 2 s, 4 s, 8 s (retries 1..3 after the first), then no more
  for (const wait of [2_000, 4_000, 8_000]) {
    mock.timers.tick(wait - 1)
    await flushMicro()
    const before: number = fetched.length
    mock.timers.tick(1)
    await flushMicro()
    assert.equal(fetched.length, before + 1, `retry after ${wait} ms`)
  }
  assert.equal(fetched.length, 5, 'one attempt plus four retries')
  mock.timers.tick(600_000)
  await flushMicro()
  assert.equal(fetched.length, 5, 'retries are bounded')
  assert.equal(result.current.status, 'unavailable')
})

test('a real empty answer (200 []) is cached, a 503 is not', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  respond = ok([])
  const empty = renderHook(() => useIssueLinks(ORIGIN, 'role-i'))
  await flushMicro()
  assert.equal(empty.result.current.status, 'ok')
  empty.unmount()
  const again = renderHook(() => useIssueLinks(ORIGIN, 'role-i'))
  assert.equal(again.result.current.status, 'ok', 'served from the cache at once')
  await flushMicro()
  assert.equal(fetched.length, 1, 'the empty answer is cached')
  again.unmount()

  respond = busy()
  const failing = renderHook(() => useIssueLinks(ORIGIN, 'role-j'))
  await flushMicro()
  failing.unmount()
  respond = ok([link(8)])
  const next = renderHook(() => useIssueLinks(ORIGIN, 'role-j'))
  await flushMicro()
  assert.equal(fetched.length, 3, 'the failure left nothing in the cache: asked again at once')
  assert.deepEqual(next.result.current.links.map(l => l.number), [8])
})

test('unmounting cancels the pending retry', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  respond = busy()
  const { unmount } = renderHook(() => useIssueLinks(ORIGIN, 'role-k'))
  await flushMicro()
  unmount()
  mock.timers.tick(600_000)
  await flushMicro()
  assert.equal(fetched.length, 1)
})

test('the answer is cached for 60 s per origin and role, then asked again', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  respond = ok([link(1)])
  const first = renderHook(() => useIssueLinks(ORIGIN, 'role-d'))
  await flush()
  assert.equal(fetched.length, 1)
  first.unmount()

  const again = renderHook(() => useIssueLinks(ORIGIN, 'role-d'))
  assert.equal(again.result.current.links.length, 1, 'served from the cache at once')
  await flush()
  assert.equal(fetched.length, 1, 'no second request')
  again.unmount()

  const otherOrigin = renderHook(() => useIssueLinks('http://127.0.0.1:9999', 'role-d'))
  await flush()
  assert.equal(fetched.length, 2, 'another relay is another key')
  otherOrigin.unmount()

  mock.timers.tick(60_001)
  const expired = renderHook(() => useIssueLinks(ORIGIN, 'role-d'))
  await flush()
  assert.equal(fetched.length, 3, 'expired entry is requested again')
  expired.unmount()
})

test('unmounting cancels the request and a late answer neither updates the state nor fills the cache', async () => {
  let release: (v: { ok: boolean; json: () => Promise<unknown> }) => void = () => {}
  respond = () => new Promise(r => { release = r })
  const a = renderHook(() => useIssueLinks(ORIGIN, 'role-e'))
  await flush()
  assert.equal(fetched.length, 1)
  assert.equal(fetched[0].signal?.aborted, false)
  a.unmount()
  assert.equal(fetched[0].signal?.aborted, true, 'the in-flight request is aborted')
  release({ ok: true, json: async () => ({ links: [link(3)] }) })
  await flush()

  respond = ok([link(4)])
  const b = renderHook(() => useIssueLinks(ORIGIN, 'role-e'))
  await flush()
  assert.equal(fetched.length, 2, 'the aborted answer was not cached')
  assert.deepEqual(b.result.current.links.map(l => l.number), [4])
})

test('changing role drops the previous role links at once and ignores its late answer', async () => {
  let releaseOld: (v: { ok: boolean; json: () => Promise<unknown> }) => void = () => {}
  respond = url => url.includes('role=role-f1')
    ? new Promise(r => { releaseOld = r })
    : ok([link(20)])()
  const { result, rerender } = renderHook(({ role }) => useIssueLinks(ORIGIN, role), { initialProps: { role: 'role-f1' } })
  await flush()
  rerender({ role: 'role-f2' })
  await flush()
  assert.deepEqual(result.current.links.map(l => l.number), [20])
  releaseOld({ ok: true, json: async () => ({ links: [link(10)] }) })
  await flush()
  assert.deepEqual(result.current.links.map(l => l.number), [20], 'the old role answer arrived late and is ignored')
})

test('the cache is bounded: past 32 roles the oldest entry is evicted and asked again', async () => {
  respond = ok([link(1)])
  for (let i = 0; i < 33; i++) {
    const h = renderHook(() => useIssueLinks(ORIGIN, `evict-${i}`))
    await flush()
    h.unmount()
  }
  assert.equal(fetched.length, 33)
  const recent = renderHook(() => useIssueLinks(ORIGIN, 'evict-32'))
  await flush()
  assert.equal(fetched.length, 33, 'a recent entry is still cached')
  recent.unmount()
  const oldest = renderHook(() => useIssueLinks(ORIGIN, 'evict-0'))
  await flush()
  assert.equal(fetched.length, 34, 'the oldest entry was evicted')
})

const NOW = 1_700_000_000_000
const clock = createFreshnessClock({ now: () => NOW, isHidden: () => true })
const agent = (extra: Record<string, unknown> = {}) => ({
  state: 'thinking' as const, tokensUsed: 1, tokensMax: 10, toolCalls: 0, timeAlive: 1,
  id: 's1:w', name: 'worker', lastEventAt: NOW, freshnessSource: 'live' as const, subagentType: 'card-role', ...extra,
})

test('AgentDetailCard lists the links of the agent role: 5 shown, "+N more", safe anchors', async () => {
  respond = ok([1, 2, 3, 4, 5, 6, 7].map(n => link(n, n % 2 ? 'issue' : 'pr')))
  const v = render(<AgentDetailCard agent={agent()} toolErrors={0} onClose={() => {}} freshnessClock={clock} relayOrigin={ORIGIN} />)
  await flush()
  const box = within(v.getByTestId('issue-links'))
  const anchors = box.getAllByRole('link')
  assert.equal(anchors.length, 5)
  for (const a of anchors) {
    assert.match(a.getAttribute('href') ?? '', /^https:\/\/github\.com\/o\/r\/(issues|pull)\/\d+$/)
    assert.equal(a.getAttribute('target'), '_blank')
    assert.match(a.getAttribute('rel') ?? '', /noopener/)
    assert.match(a.getAttribute('rel') ?? '', /noreferrer/)
  }
  assert.ok(box.getByText('+2 more'))
  assert.ok(box.getByText('agent:card-role'))
  assert.ok(v.getByRole('list', { name: 'Issues and pull requests labelled agent:card-role' }))
  assert.equal(fetched[0].url, `${ORIGIN}/issue-links?role=card-role`, 'the card asks the relay of the bridge for the role of the agent')
})

test('AgentDetailCard shows no section without relay, without role or without link', async () => {
  respond = ok([link(1)])
  const noRelay = render(<AgentDetailCard agent={agent({ subagentType: 'card-role-2' })} toolErrors={0} onClose={() => {}} freshnessClock={clock} relayOrigin={null} />)
  await flush()
  assert.equal(noRelay.queryByTestId('issue-links'), null)
  noRelay.unmount()

  const noRole = render(<AgentDetailCard agent={agent({ subagentType: undefined, agentType: undefined })} toolErrors={0} onClose={() => {}} freshnessClock={clock} relayOrigin={ORIGIN} />)
  await flush()
  assert.equal(noRole.queryByTestId('issue-links'), null)
  noRole.unmount()

  respond = ok([])
  const empty = render(<AgentDetailCard agent={agent({ subagentType: 'card-role-3' })} toolErrors={0} onClose={() => {}} freshnessClock={clock} relayOrigin={ORIGIN} />)
  await flush()
  assert.equal(empty.queryByTestId('issue-links'), null)
})

test('AgentDetailCard says "unavailable" (accessible status text) when the links could not be loaded, and never "no link"', async () => {
  respond = busy()
  const v = render(<AgentDetailCard agent={agent({ subagentType: 'card-role-4' })} toolErrors={0} onClose={() => {}} freshnessClock={clock} relayOrigin={ORIGIN} />)
  await flush()
  const box = v.getByTestId('issue-links-unavailable')
  assert.match(within(box).getByRole('status').textContent ?? '', /unavailable for now/)
  assert.equal(v.queryByTestId('issue-links'), null)
  assert.equal(within(box).queryAllByRole('link').length, 0)
})

test('AgentDetailCard says "unavailable" when gh or git failed on the relay (502, #205)', async () => {
  respond = async () => ({ ok: false, status: 502, headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? '10' : null) }, json: async () => ({}) })
  const v = render(<AgentDetailCard agent={agent({ subagentType: 'card-role-5' })} toolErrors={0} onClose={() => {}} freshnessClock={clock} relayOrigin={ORIGIN} />)
  await flush()
  assert.match(within(v.getByTestId('issue-links-unavailable')).getByRole('status').textContent ?? '', /unavailable for now/)
  assert.equal(v.queryByTestId('issue-links'), null)
})
