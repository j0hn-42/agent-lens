// PRs by branch with their checks, and issues without an agent (#228): the section of the project context panel,
// on the real path (useSessionWork, loaded only while the panel is open) with a mocked fetch. Honest states, safe
// anchors, a real table, axe-clean.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, renderHook, cleanup, act, within } from '@testing-library/react'
import axe from 'axe-core'

import { ProjectContextPanel } from '@/components/agent-visualizer/project-context-panel'
import { useSessionWork } from '@/hooks/use-session-work'
import type { ProjectContextData } from '@/lib/project-context'

const g = globalThis as unknown as Record<string, unknown>
const realFetch = g.fetch
const ORIGIN = 'http://127.0.0.1:4321'
const U = 'https://github.com/o/r'

type Reply = { ok: boolean; status?: number; headers?: { get(n: string): string | null }; json: () => Promise<unknown> }
let fetched: string[] = []
let respond: () => Promise<Reply> = async () => ({ ok: true, json: async () => work() })

const checks = (state: string, total = 3, failing = 0, pending = 0) => ({ state, total, failing, pending })
const pr = (n: number, branch: string, extra: Record<string, unknown> = {}) => ({
  number: n, title: `PR title ${n}`, url: `${U}/pull/${n}`, branch, checks: checks('passing'), ...extra,
})
function work(extra: Record<string, unknown> = {}) {
  return {
    scope: 'session', session: 's1', repo: U,
    prs: [pr(11, 'feat/b', { checks: checks('failing', 4, 1, 1) }), pr(10, 'feat/a', { draft: true, checks: checks('none', 0) }), pr(12, 'feat/b')],
    issues: [{ number: 40, title: 'Orphan issue', url: `${U}/issues/40` }],
    prsTruncated: false, issuesTruncated: false, ...extra,
  }
}
const ok = (body: unknown) => async (): Promise<Reply> => ({ ok: true, json: async () => body })
const status = (code: number): (() => Promise<Reply>) => async () => ({ ok: false, status: code, headers: { get: () => null }, json: async () => ({}) })

const ctx = (): ProjectContextData => ({ sessionId: 's1', loadedAt: 1, files: [], issues: [] })
const fetchContext = async () => ctx()
const flush = () => act(async () => { await new Promise(r => setImmediate(r)) })
const noop = () => {}

beforeEach(() => {
  fetched = []
  SID = `sess-${++counter}`
  respond = ok(work())
  g.fetch = (url: string) => { fetched.push(url); return respond() }
})
afterEach(() => {
  cleanup()
  mock.timers.reset()
  g.fetch = realFetch
  document.body.replaceChildren()
})

let SID = "s0"
let counter = 0
const panel = (over: Record<string, unknown> = {}) => (
  <ProjectContextPanel visible sessionId={SID} fetchContext={fetchContext} relayOrigin={ORIGIN} sessionBranch="feat/b" onClose={noop} {...over} />
)

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)
}

test('nothing is requested while the panel is closed, without relay, or without a session', async () => {
  render(panel({ visible: false }))
  render(panel({ relayOrigin: null }))
  render(panel({ sessionId: null }))
  render(panel({ unavailableReason: 'demo' }))
  await flush()
  assert.deepEqual(fetched.filter(u => u.includes('scope=session')), [])
})

test('opening the panel lists the open PRs by branch in a real table, with checks in words', async () => {
  const v = render(panel())
  await flush()
  assert.deepEqual(fetched, [`${ORIGIN}/issue-links?scope=session&session=${SID}`])
  const table = v.getByRole('table', { name: 'Open pull requests by branch' })
  const rows = within(table).getAllByRole('row').slice(1)
  assert.equal(rows.length, 3)
  assert.deepEqual(within(table).getAllByRole('columnheader').map(h => h.textContent), ['Branch', 'Pull request', 'Checks'])
  // sorted by branch, then number
  assert.match(rows[0].textContent ?? '', /feat\/a.*#10.*draft.*no checks reported/)
  assert.match(rows[1].textContent ?? '', /feat\/b.*#11.*1 failing, 1 pending of 4/)
  assert.match(rows[2].textContent ?? '', /feat\/b.*#12.*3 of 3 passing/)
})

test('the PR of the session branch is named as such, in words; other rows are not', async () => {
  const v = render(panel())
  await flush()
  const rows = within(v.getByRole('table', { name: 'Open pull requests by branch' })).getAllByRole('row').slice(1)
  assert.ok(!/this session/i.test(rows[0].textContent ?? ''))
  assert.match(rows[1].textContent ?? '', /this session/)
  assert.match(rows[2].textContent ?? '', /this session/)
})

test('a session whose branch was not recorded matches no PR and says so', async () => {
  const v = render(panel({ sessionBranch: undefined }))
  await flush()
  assert.ok(!/\(this session\)/.test(v.container.textContent ?? ''))
  assert.match(v.getByTestId('session-work-no-branch').textContent ?? '', /branch of this session was not recorded/i)
})

test('PR and issue anchors are safe: exact github URL, new tab, noopener noreferrer', async () => {
  const v = render(panel())
  await flush()
  const anchors = within(v.getByTestId('session-work')).getAllByRole('link')
  assert.equal(anchors.length, 4)
  for (const a of anchors) {
    assert.match(a.getAttribute('href') ?? '', /^https:\/\/github\.com\/o\/r\/(issues|pull)\/\d+$/)
    assert.equal(a.getAttribute('target'), '_blank')
    assert.match(a.getAttribute('rel') ?? '', /noopener/)
    assert.match(a.getAttribute('rel') ?? '', /noreferrer/)
  }
})

test('issues without an agent are listed with an accessible name', async () => {
  const v = render(panel())
  await flush()
  const list = v.getByRole('list', { name: 'Open issues without an agent' })
  assert.match(list.textContent ?? '', /#40.*Orphan issue/)
})

test('true empty lists are said, not left blank', async () => {
  respond = ok(work({ prs: [], issues: [] }))
  const v = render(panel())
  await flush()
  assert.ok(v.getByText('No open pull request.'))
  assert.ok(v.getByText('No open issue without an agent.'))
  assert.equal(v.queryByRole('table'), null)
})

test('a partial answer says "at least" and that more may exist', async () => {
  respond = ok(work({ prsTruncated: true, issuesTruncated: true }))
  const v = render(panel())
  await flush()
  const text = v.getByTestId('session-work').textContent ?? ''
  assert.match(text, /At least 3 open pull requests shown; more may exist/)
  assert.match(text, /At least 1 open issue without an agent shown; more may exist/)
})

test('no GitHub repository, unknown project and failure are three different honest statements, never "no PR"', async () => {
  respond = ok(work({ repo: null, prs: [], issues: [] }))
  const a = render(panel())
  await flush()
  assert.match(a.getByTestId('session-work').textContent ?? '', /no GitHub repository/i)
  assert.equal(a.queryByText('No open pull request.'), null)
  a.unmount()

  respond = status(404)
  const b = render(panel({ sessionId: SID + 'x' }))
  await flush()
  assert.match(b.getByTestId('session-work').textContent ?? '', /project of this session is unknown/i)
  assert.equal(b.queryByText('No open pull request.'), null)
  b.unmount()

  respond = status(502)
  const c = render(panel({ sessionId: SID + 'x' }))
  await flush()
  assert.match(within(c.getByTestId('session-work')).getByRole('status').textContent ?? '', /unavailable for now/)
  assert.equal(c.queryByText('No open pull request.'), null)
  assert.equal(c.queryByRole('table'), null)
})

test('a failure is retried with a backoff and then shown', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  respond = status(502)
  const v = render(panel({ sessionId: SID + 'x' }))
  await flush()
  const first = fetched.length
  respond = ok(work())
  mock.timers.tick(30_000)
  await flush()
  assert.ok(fetched.length > first, 'retried')
  assert.ok(v.getByRole('table', { name: 'Open pull requests by branch' }))
})

test('the hook caches an answer for 60 s per session, and aborts the request on unmount', async () => {
  const first = renderHook(() => useSessionWork(ORIGIN, SID + 'h', true))
  await flush()
  assert.equal(first.result.current.status, 'ok')
  const again = renderHook(() => useSessionWork(ORIGIN, SID + 'h', true))
  await flush()
  assert.equal(again.result.current.status, 'ok')
  assert.equal(fetched.length, 1, 'the second mount used the cache')
  const signals: AbortSignal[] = []
  g.fetch = (_url: string, init?: { signal?: AbortSignal }) => { if (init?.signal) signals.push(init.signal); return new Promise(() => {}) }
  const pending = renderHook(() => useSessionWork(ORIGIN, 's5b', true))
  pending.unmount()
  assert.equal(signals[0]?.aborted, true)
})

test('the section is axe-clean with data, an empty answer and a failure', async () => {
  const a = render(panel())
  await flush()
  assert.deepEqual(await violations(a.container), [])
  a.unmount()
  respond = ok(work({ prs: [], issues: [], prsTruncated: true }))
  const b = render(panel({ sessionId: SID + 'x' }))
  await flush()
  assert.deepEqual(await violations(b.container), [])
  b.unmount()
  respond = status(502)
  const c = render(panel({ sessionId: SID + 'y' }))
  await flush()
  assert.deepEqual(await violations(c.container), [])
})

test('every link of the section is reachable with the keyboard and shows a focus ring', async () => {
  const v = render(panel())
  await flush()
  const anchors = within(v.getByTestId('session-work')).getAllByRole('link')
  for (const a of anchors) {
    assert.notEqual(a.getAttribute('tabindex'), '-1')
    a.focus()
    assert.equal(document.activeElement, a)
    assert.match(a.className, /focus-visible/)
  }
})
