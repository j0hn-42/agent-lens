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
  assert.deepEqual(result.current.map(l => l.number), [7, 9], 'the foreign URL is dropped')
})

test('no relay or no role: nothing is requested and the list is empty', async () => {
  const none = renderHook(() => useIssueLinks(null, 'role-b'))
  const noRole = renderHook(() => useIssueLinks(ORIGIN, undefined))
  await flush()
  assert.equal(fetched.length, 0)
  assert.deepEqual(none.result.current, [])
  assert.deepEqual(noRole.result.current, [])
})

test('a failing relay degrades silently to no link', async () => {
  respond = async () => { throw new Error('network down') }
  const a = renderHook(() => useIssueLinks(ORIGIN, 'role-c'))
  await flush()
  assert.deepEqual(a.result.current, [])
  respond = async () => ({ ok: false, json: async () => ({}) })
  const b = renderHook(() => useIssueLinks(ORIGIN, 'role-c2'))
  await flush()
  assert.deepEqual(b.result.current, [])
})

test('the answer is cached for 60 s per origin and role, then asked again', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  respond = ok([link(1)])
  const first = renderHook(() => useIssueLinks(ORIGIN, 'role-d'))
  await flush()
  assert.equal(fetched.length, 1)
  first.unmount()

  const again = renderHook(() => useIssueLinks(ORIGIN, 'role-d'))
  assert.equal(again.result.current.length, 1, 'served from the cache at once')
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
  assert.deepEqual(b.result.current.map(l => l.number), [4])
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
  assert.deepEqual(result.current.map(l => l.number), [20])
  releaseOld({ ok: true, json: async () => ({ links: [link(10)] }) })
  await flush()
  assert.deepEqual(result.current.map(l => l.number), [20], 'the old role answer arrived late and is ignored')
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
