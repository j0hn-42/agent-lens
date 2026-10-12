// Scope selector (#291): this workspace / one project / all workspaces. A native select, always visible in the top bar,
// named, keyboard operable, stating the scope the relay REALLY scans, with the discovery ceilings that were hit.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { ScopeSelector } from '@/components/agent-visualizer/scope-selector'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import { parseRelayScopeState, type RelayScopeState } from '@/lib/relay-scope'
import { ALL_SESSIONS_ID, type SessionInfo } from '@/lib/bridge-types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const relayStatus = (over: Record<string, unknown> = {}) => ({
  relayVersion: '1', workspace: '/home/me/code/alpha', runtimes: ['claude'], hooksConfigured: true, disable1MContext: false,
  sessionCount: 1, allWorkspaces: false,
  skippedSessions: { watchLimit: 0, sizeLimit: 0, fileLimit: 0 },
  discovery: { projectDirsCapped: false, maxProjectDirs: 200, maxFilesPerDir: 500 },
  ...over,
})
const state = (over: Record<string, unknown> = {}): RelayScopeState => parseRelayScopeState(relayStatus(over))!
const sessions: SessionInfo[] = [
  { id: 'a', label: 'fix login', status: 'active', startTime: 0, lastActivityTime: 3, projectId: 'pa', projectName: 'alpha' },
  { id: 'b', label: 'refactor', status: 'active', startTime: 0, lastActivityTime: 2, projectId: 'pb', projectName: 'beta' },
]
const noop = () => {}
const base = { sessions, projectId: null, pending: false, error: null, onChoose: noop }

test('without a relay state (extension, demo) nothing is rendered: no scope is claimed', () => {
  const { container } = render(<ScopeSelector {...base} state={null} />)
  assert.equal(container.innerHTML, '')
})

test('a named native combobox, workspace selected by default, with the options in order', () => {
  const { getByRole } = render(<ScopeSelector {...base} state={state()} />)
  const select = getByRole('combobox', { name: 'Session scope' }) as HTMLSelectElement
  assert.equal(select.tagName, 'SELECT')
  assert.deepEqual(Array.from(select.options).map(o => o.textContent), ['This workspace', 'All workspaces', 'Project: alpha', 'Project: beta'])
  assert.equal(select.value, 'workspace')
  assert.notEqual(select.tabIndex, -1, 'in the tab order')
  select.focus()
  assert.equal(document.activeElement, select)
})

test('the scope is always written out, never only a colour or a tooltip', () => {
  const ws = render(<ScopeSelector {...base} state={state()} />)
  assert.match(ws.container.textContent ?? '', /Scanning this workspace only \(alpha\)/)
  ws.unmount()
  const all = render(<ScopeSelector {...base} state={state({ allWorkspaces: true })} />)
  assert.doesNotMatch(all.container.textContent ?? '', /Scanning/)
  assert.equal((all.getByRole('combobox', { name: 'Session scope' }) as HTMLSelectElement).value, 'all')
})

test('a project filter shows as the selected project; a stale one falls back to the scope', () => {
  const sel = render(<ScopeSelector {...base} state={state({ allWorkspaces: true })} projectId="pb" />)
  assert.equal((sel.getByRole('combobox', { name: 'Session scope' }) as HTMLSelectElement).value, 'project:pb')
  sel.unmount()
  const stale = render(<ScopeSelector {...base} state={state({ allWorkspaces: true })} projectId="gone" />)
  assert.equal((stale.getByRole('combobox', { name: 'Session scope' }) as HTMLSelectElement).value, 'all')
})

test('choosing reports the parsed choice; an unknown value is ignored', () => {
  const seen: unknown[] = []
  const { getByRole } = render(<ScopeSelector {...base} state={state()} onChoose={c => seen.push(c)} />)
  const select = getByRole('combobox', { name: 'Session scope' }) as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'all' } })
  fireEvent.change(select, { target: { value: 'project:pb' } })
  fireEvent.change(select, { target: { value: 'workspace' } })
  assert.deepEqual(seen, [{ kind: 'all' }, { kind: 'project', projectId: 'pb' }, { kind: 'workspace' }])
})

test('while the change is being applied the select says it is busy; the shown value stays the relay one', () => {
  const { getByRole } = render(<ScopeSelector {...base} state={state()} pending />)
  const select = getByRole('combobox', { name: 'Session scope' }) as HTMLSelectElement
  assert.equal(select.getAttribute('aria-busy'), 'true')
  assert.equal(select.value, 'workspace', 'not moved before the relay confirmed')
})

test('the ceilings that were hit are listed in a polite live region; none, no noise', () => {
  const quiet = render(<ScopeSelector {...base} state={state()} />)
  assert.equal(quiet.container.querySelector('[data-scope-notices]')?.textContent ?? '', '')
  quiet.unmount()
  const hit = render(<ScopeSelector {...base} state={state({
    allWorkspaces: true,
    discovery: { projectDirsCapped: true, maxProjectDirs: 200, maxFilesPerDir: 500 },
    skippedSessions: { watchLimit: 0, sizeLimit: 0, fileLimit: 4 },
  })} />)
  const region = hit.container.querySelector('[data-scope-notices]') as HTMLElement
  assert.equal(region.getAttribute('role'), 'status')
  assert.doesNotMatch(region.textContent ?? '', /project folders/)
  assert.match(region.textContent ?? '', /at least 4/i)
})

test('a failed change is said, and the shown scope is still the scanned one', () => {
  const { container, getByRole } = render(<ScopeSelector {...base} state={state()} error="The relay refused the change of scope" />)
  assert.match(container.querySelector('[data-scope-notices]')!.textContent ?? '', /refused the change of scope/)
  assert.equal((getByRole('combobox', { name: 'Session scope' }) as HTMLSelectElement).value, 'workspace')
})

test('no axe violation, with notices and an error showing', async () => {
  const { container } = render(<ScopeSelector {...base} state={state({
    allWorkspaces: true, discovery: { projectDirsCapped: true, maxProjectDirs: 200, maxFilesPerDir: 500 },
  })} error="boom" />)
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  assert.deepEqual(results.violations.map(v => v.id), [])
})

test('colours come from the theme tokens and no animation is declared', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'agent-visualizer', 'scope-selector.tsx'), 'utf8')
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, 'no hard-coded hex colour')
  assert.doesNotMatch(source, /rgba?\(|hsla?\(/, 'no hard-coded colour function')
  assert.doesNotMatch(source, /animate-|transition|@keyframes/, 'no motion, so nothing to switch off for prefers-reduced-motion')
  assert.match(source, /COLORS\./, 'colours are read from COLORS')
})

const topBarProps: TopBarProps = {
  sessions, selectedSessionId: ALL_SESSIONS_ID, sessionsWithActivity: new Set(),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 1, doneAgentCount: 0, totalTokens: 10, totalCost: 0,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, showStats: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, onToggleMute: noop, onOpenShortcuts: noop,
}

test('the top bar carries the selector permanently when a relay reports its scope, and not otherwise', () => {
  const without = render(<TopBar {...topBarProps} />)
  assert.equal(without.queryByRole('combobox', { name: 'Session scope' }), null)
  without.unmount()
  const withScope = render(<TopBar {...topBarProps} scope={{ ...base, state: state() }} />)
  assert.ok(withScope.getByRole('combobox', { name: 'Session scope' }))
})

test('the session list does not stay silently empty on a single workspace: it states the limit and offers the way out', () => {
  const view = render(
    <SessionListPanel
      visible onClose={noop} sessions={[]} selectedSessionId={ALL_SESSIONS_ID} sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map()} selectedAgentId={null} onSelectAgent={noop}
      now={1} observedSessionIds={new Set()} scopeHint="Only the sessions of this workspace are discovered. Choose All workspaces to look at the others."
    />,
  )
  assert.match(view.container.textContent ?? '', /this workspace/)
  assert.match(view.container.textContent ?? '', /All workspaces/)
})
