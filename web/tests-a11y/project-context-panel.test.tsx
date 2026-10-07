// Project context panel (#64): loads only when opened, 60 s cache, refresh button, honest states, axe-clean.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import axe from 'axe-core'

import { ProjectContextPanel } from '@/components/agent-visualizer/project-context-panel'
import type { ProjectContextData } from '@/lib/project-context'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

const ctx = (over: Partial<ProjectContextData> = {}): ProjectContextData => ({
  sessionId: 's1', loadedAt: 1,
  files: [
    { kind: 'claude-md', name: 'CLAUDE.md', found: true, text: 'Project rules <b>x</b>', bytes: 22, truncated: false },
    { kind: 'memory', name: 'MEMORY.md', found: false, text: '', bytes: 0, truncated: false },
  ],
  issues: [12, 64],
  ...over,
})

function makeFetch(results: Array<ProjectContextData | 'unavailable' | Error>) {
  const calls: string[] = []
  const fetchContext = async (id: string) => {
    calls.push(id)
    const r = results[Math.min(calls.length - 1, results.length - 1)]
    if (r instanceof Error) throw r
    return r
  }
  return { calls, fetchContext }
}

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)
}

test('nothing is fetched while the panel is closed', async () => {
  const f = makeFetch([ctx()])
  render(<ProjectContextPanel visible={false} sessionId="s1" fetchContext={f.fetchContext} onClose={noop} />)
  await flush()
  assert.equal(f.calls.length, 0)
})

test('opening the panel loads the context; files, truncation and issue refs are shown', async () => {
  const f = makeFetch([ctx({ files: [
    { kind: 'claude-md', name: 'CLAUDE.md', found: true, text: 'Project rules <b>x</b>', bytes: 99_000, truncated: true },
    { kind: 'memory', name: 'MEMORY.md', found: false, text: '', bytes: 0, truncated: false },
  ] })])
  const { container, getByText, queryByText } = render(<ProjectContextPanel visible sessionId="s1" fetchContext={f.fetchContext} onClose={noop} />)
  await flush()
  assert.deepEqual(f.calls, ['s1'])
  assert.ok(getByText('CLAUDE.md'))
  assert.ok(container.textContent?.includes('Project rules <b>x</b>'), 'text is rendered as text, not HTML')
  assert.equal(container.querySelector('b'), null)
  assert.match(container.textContent ?? '', /Truncated: first 64 KB of 97 KB/)
  assert.match(container.textContent ?? '', /MEMORY\.md[\s\S]*not found/i)
  assert.ok(queryByText('#12') && queryByText('#64'))
  assert.match(container.textContent ?? '', /cited in the files above/i)
})

test('a present but unreadable file is not shown as not found', async () => {
  const f = makeFetch([ctx({ files: [
    { kind: 'claude-md', name: 'CLAUDE.md', found: false, unreadable: 'symlink', text: '', bytes: 0, truncated: false },
    { kind: 'memory', name: 'MEMORY.md', found: false, text: '', bytes: 0, truncated: false },
  ] })])
  const { container } = render(<ProjectContextPanel visible sessionId="s1" fetchContext={f.fetchContext} onClose={noop} />)
  await flush()
  const text = container.textContent ?? ''
  assert.match(text, /CLAUDE\.md is present but was not read \(symbolic link\)/)
  assert.doesNotMatch(text, /CLAUDE\.md not found/)
  assert.match(text, /MEMORY\.md not found/)
})

test('reopening within 60 s does not fetch again; Refresh does', async () => {
  const f = makeFetch([ctx(), ctx()])
  const { rerender, getByRole } = render(<ProjectContextPanel visible sessionId="s1" fetchContext={f.fetchContext} onClose={noop} />)
  await flush()
  rerender(<ProjectContextPanel visible={false} sessionId="s1" fetchContext={f.fetchContext} onClose={noop} />)
  rerender(<ProjectContextPanel visible sessionId="s1" fetchContext={f.fetchContext} onClose={noop} />)
  await flush()
  assert.equal(f.calls.length, 1)
  fireEvent.click(getByRole('button', { name: 'Refresh project context' }))
  await flush()
  assert.equal(f.calls.length, 2)
})

test('switching session while open loads the new session', async () => {
  const f = makeFetch([ctx(), ctx({ sessionId: 's2' })])
  const { rerender } = render(<ProjectContextPanel visible sessionId="s1" fetchContext={f.fetchContext} onClose={noop} />)
  await flush()
  rerender(<ProjectContextPanel visible sessionId="s2" fetchContext={f.fetchContext} onClose={noop} />)
  await flush()
  assert.deepEqual(f.calls, ['s1', 's2'])
})

test('a failure is announced as an alert and offers a retry', async () => {
  const f = makeFetch([new Error('HTTP 500'), ctx()])
  const { getByRole, container } = render(<ProjectContextPanel visible sessionId="s1" fetchContext={f.fetchContext} onClose={noop} />)
  await flush()
  assert.match(getByRole('alert').textContent ?? '', /HTTP 500/)
  fireEvent.click(getByRole('button', { name: 'Refresh project context' }))
  await flush()
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.ok(container.textContent?.includes('Project rules'))
})

test('unavailable context is explained, not shown as empty', async () => {
  const f = makeFetch(['unavailable'])
  const { container } = render(<ProjectContextPanel visible sessionId="s1" fetchContext={f.fetchContext} onClose={noop} />)
  await flush()
  assert.match(container.textContent ?? '', /No project context is available for this session/)
})

test('without a single session (All / team view) nothing is fetched and the panel says why', async () => {
  const f = makeFetch([ctx()])
  const { container } = render(<ProjectContextPanel visible sessionId={null} fetchContext={f.fetchContext} onClose={noop} />)
  await flush()
  assert.equal(f.calls.length, 0)
  assert.match(container.textContent ?? '', /Select a single session/)
})

test('when the relay is not reachable from here (VS Code, demo) the reason is stated and nothing is fetched', async () => {
  const f = makeFetch([ctx()])
  const { container } = render(<ProjectContextPanel visible sessionId="s1" fetchContext={f.fetchContext} unavailableReason="Not available in demo mode." onClose={noop} />)
  await flush()
  assert.equal(f.calls.length, 0)
  assert.match(container.textContent ?? '', /Not available in demo mode/)
})

test('axe: loaded, error and unavailable states have no violations', async () => {
  for (const results of [[ctx()], [new Error('boom')], ['unavailable' as const]]) {
    const f = makeFetch(results)
    const { container, unmount } = render(<ProjectContextPanel visible sessionId="s1" fetchContext={f.fetchContext} onClose={noop} />)
    await flush()
    assert.deepEqual(await violations(container), [])
    unmount()
  }
})

test('top bar: the Context button is a native toggle that reports aria-pressed and asks for the context panel', () => {
  const asked: string[] = []
  const base: TopBarProps = {
    sessions: [{ id: 's1', label: 'one', status: 'active', startTime: 1, lastActivityTime: 2 }],
    selectedSessionId: ALL_SESSIONS_ID, sessionsWithActivity: new Set(),
    showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
    activeAgentCount: 1, doneAgentCount: 0, totalTokens: 10, totalCost: 0,
    showFileAttention: false, showTranscript: false, showCostOverlay: false, showTimeline: false, isMuted: false,
    onTogglePanel: p => asked.push(p), onToggleTimeline: noop, onToggleMute: noop, onOpenShortcuts: noop,
  }
  const { getByRole, rerender } = render(<TopBar {...base} />)
  const btn = getByRole('button', { name: 'Context' })
  assert.equal(btn.getAttribute('aria-pressed'), 'false')
  fireEvent.click(btn)
  assert.deepEqual(asked, ['context'])
  rerender(<TopBar {...base} showContext />)
  assert.equal(getByRole('button', { name: 'Context' }).getAttribute('aria-pressed'), 'true')
})
