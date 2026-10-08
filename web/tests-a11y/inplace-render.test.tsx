// In-place rendering (issue #69) and collapsed sections (issue #70) of the sessions panel.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { rowRenderProbe } from '@/lib/row-sync'
import { SessionListPanel, type SessionListAgent } from '@/components/agent-visualizer/session-list-panel'

afterEach(() => {
  rowRenderProbe.onRender = null
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}
const sessions = [{ id: 'a', label: 'Sa', status: 'active' as const, startTime: 0, lastActivityTime: 10 }]

function agent(id: string, over: Partial<SessionListAgent> = {}): SessionListAgent {
  return { id, sessionId: 'a', parentKey: null, name: id, state: 'thinking', tokensUsed: 10, spawnTime: 1, lastEventAt: Date.now(), ...over }
}

function panel(agents: SessionListAgent[], extra: Partial<React.ComponentProps<typeof SessionListPanel>> = {}) {
  return (
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="a" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map(agents.map(a => [a.id, a]))}
      selectedAgentId={null} onSelectAgent={noop} now={5000} observedSessionIds={new Set(['a'])} {...extra}
    />
  )
}

const rowByKey = (c: HTMLElement, key: string) => c.querySelector<HTMLElement>(`[data-row-key="${key}"]`)!

test('in place: a change to one agent leaves the DOM of the other rows untouched', async () => {
  const { container, rerender } = render(panel([agent('m1'), agent('m2', { tokensUsed: 5 })]))
  const untouched = rowByKey(container, 'agent:m1').closest('li')!
  const watcher = new MutationObserver(noop)
  watcher.observe(untouched, { subtree: true, childList: true, attributes: true, characterData: true })
  rerender(panel([agent('m1'), agent('m2', { tokensUsed: 6 })]))
  assert.equal(watcher.takeRecords().length, 0, 'unchanged row is not rewritten')
  assert.equal(rowByKey(container, 'agent:m1').closest('li'), untouched, 'same DOM node')
  assert.match(rowByKey(container, 'agent:m2').textContent ?? '', /6/)
})

function countRenders() {
  const counts: Record<string, number> = {}
  rowRenderProbe.onRender = id => { counts[id] = (counts[id] ?? 0) + 1 }
  return counts
}

test('in place: only the row whose signature changed is rendered again', () => {
  const counts = countRenders()
  const { rerender } = render(panel([agent('m1'), agent('m2', { tokensUsed: 5 })]))
  assert.deepEqual(counts, { m1: 1, m2: 1 })
  rerender(panel([agent('m1'), agent('m2', { tokensUsed: 6 })]))
  assert.equal(counts.m1, 1, 'unchanged row not rendered again')
  assert.equal(counts.m2, 2, 'changed row rendered again')
})

test('in place: a new onSelectAgent identity from the parent does not render the rows again', () => {
  const counts = countRenders()
  const first: (id: string) => void = () => {}
  const { rerender } = render(panel([agent('m1'), agent('m2')], { onSelectAgent: first }))
  rerender(panel([agent('m1'), agent('m2')], { onSelectAgent: () => {} }))
  assert.deepEqual(counts, { m1: 1, m2: 1 })
})

test('in place: the latest onSelectAgent is the one called on click', () => {
  const calls: string[] = []
  const { container, rerender } = render(panel([agent('m1')], { onSelectAgent: () => calls.push('old') }))
  rerender(panel([agent('m1')], { onSelectAgent: () => calls.push('new') }))
  fireEvent.click(rowByKey(container, 'agent:m1'))
  assert.deepEqual(calls, ['new'])
})

test('in place: the row that changed does update', () => {
  const { container, rerender } = render(panel([agent('m1')]))
  rerender(panel([agent('m1', { state: 'tool_calling', currentTool: 'Read' })]))
  assert.match(rowByKey(container, 'agent:m1').textContent ?? '', /Read/)
})

test('in place: selecting an agent updates the row inside an otherwise unchanged subtree', () => {
  const sub = agent('s', { parentKey: 'm1' })
  const { container, rerender } = render(panel([agent('m1'), sub]))
  assert.equal(rowByKey(container, 'agent:s').getAttribute('aria-current'), null)
  rerender(panel([agent('m1'), sub], { selectedAgentId: 's' }))
  assert.equal(rowByKey(container, 'agent:s').getAttribute('aria-current'), 'true')
})

test('focus: kept on the focused row across frequent updates', () => {
  const { container, rerender } = render(panel([agent('m1'), agent('m2')]))
  const row = rowByKey(container, 'agent:m2')
  row.focus()
  for (let i = 0; i < 5; i++) rerender(panel([agent('m1', { tokensUsed: i }), agent('m2', { tokensUsed: i })]))
  assert.equal(document.activeElement, rowByKey(container, 'agent:m2'))
  assert.equal(document.activeElement, row, 'same node, never rebuilt')
})

test('focus: restored on the same row when its node had to be rebuilt', () => {
  // The sub-agent is re-parented: React remounts its row, focus would fall to <body>
  const sub = agent('s', { parentKey: 'm1' })
  const { container, rerender } = render(panel([agent('m1'), agent('m2'), sub]))
  const before = rowByKey(container, 'agent:s')
  before.focus()
  assert.equal(document.activeElement, before)
  rerender(panel([agent('m1'), agent('m2'), { ...sub, parentKey: 'm2' }]))
  const after = rowByKey(container, 'agent:s')
  assert.notEqual(after, before, 'the node really was replaced')
  assert.equal(document.activeElement, after, 'focus restored by key')
})

test('focus: not taken back from an element the user moved to', () => {
  const sub = agent('s', { parentKey: 'm1' })
  const { container, rerender, getByRole } = render(panel([agent('m1'), agent('m2'), sub]))
  rowByKey(container, 'agent:s').focus()
  getByRole('button', { name: 'Active only' }).focus()
  rerender(panel([agent('m1'), agent('m2'), { ...sub, parentKey: 'm2' }]))
  assert.equal(document.activeElement, getByRole('button', { name: 'Active only' }))
})

// ─── Collapsed sections (#70) ───────────────────────────────────────────────

test('collapsed: the agents stay in the DOM but are inert and hidden from assistive tech', () => {
  const { container, getByRole } = render(panel([agent('m1')]))
  const toggle = getByRole('button', { name: 'Collapse agents of Sa' })
  const section = container.querySelector<HTMLElement>('[data-collapsible]')!
  assert.equal(section.hasAttribute('inert'), false)
  assert.equal(section.style.gridTemplateRows, '1fr')
  fireEvent.click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(section.hasAttribute('inert'), true)
  assert.equal(section.getAttribute('aria-hidden'), 'true')
  assert.equal(section.style.gridTemplateRows, '0fr')
  assert.ok(container.querySelector('[data-row-key="agent:m1"]'), 'content kept for the animation')
  fireEvent.click(toggle)
  assert.equal(section.hasAttribute('inert'), false)
  assert.equal(section.style.gridTemplateRows, '1fr')
})

test('collapsed: the open wrapper clips with a margin wider than the focus ring, the closed one clips hard', () => {
  const { container, getByRole } = render(panel([agent('m1')]))
  const inner = container.querySelector<HTMLElement>('[data-collapsible] > div')!
  const margin = /overflow-clip-margin:(\d+)px/.exec(inner.className)
  assert.ok(margin && Number(margin[1]) >= 4, 'outline 2px + offset 2px must stay visible')
  assert.ok(!inner.className.includes('overflow-hidden'))
  fireEvent.click(getByRole('button', { name: 'Collapse agents of Sa' }))
  assert.ok(inner.className.includes('overflow-hidden'))
  assert.ok(!inner.className.includes('overflow-clip'))
})

test('collapsed: arrow navigation skips rows inside an inert section', () => {
  const { container } = render(panel([agent('m1')]))
  const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-row-main]'))
  const sessionRow = rows().find(r => r.dataset.sessionId === 'a')!
  sessionRow.focus()
  fireEvent.keyDown(sessionRow, { key: 'ArrowLeft' })
  fireEvent.keyDown(sessionRow, { key: 'End' })
  assert.equal(document.activeElement, sessionRow, 'End stays on the last reachable row')
})

test('collapsed: the change is announced politely', () => {
  const { container, getByRole } = render(panel([agent('m1')]))
  const live = container.querySelector('[role="status"][data-panel-announcer]')!
  assert.equal(live.getAttribute('aria-live'), 'polite')
  assert.equal(live.textContent, '')
  fireEvent.click(getByRole('button', { name: 'Collapse agents of Sa' }))
  assert.equal(live.textContent, 'Agents of Sa collapsed')
  fireEvent.click(getByRole('button', { name: 'Expand agents of Sa' }))
  assert.equal(live.textContent, 'Agents of Sa expanded')
})

test('collapsed: the Active only filter announces how many sessions remain', () => {
  const { container, getByRole } = render(panel([]))
  const live = container.querySelector('[role="status"][data-panel-announcer]')!
  fireEvent.click(getByRole('button', { name: 'Active only' }))
  assert.match(live.textContent ?? '', /^Active sessions only: \d+ shown$/)
})

// ─── Stylesheet ─────────────────────────────────────────────────────────────

const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8')

test('css: forced-colors keeps focus, selection and borders visible with system colours', () => {
  const block = /@media \(forced-colors: active\) \{([\s\S]*?)\n\}\n/.exec(css)?.[1] ?? ''
  assert.ok(block, 'forced-colors block exists')
  assert.match(block, /:focus-visible[\s\S]*Highlight/)
  assert.match(block, /\[aria-current="true"\][\s\S]*(Highlight|CanvasText)/)
  assert.match(block, /\.glass-card[\s\S]*CanvasText/)
})

test('css: collapsible sections animate rows 0fr/1fr and stop animating under reduced motion', () => {
  assert.match(css, /\[data-collapsible\][\s\S]*grid-template-rows/)
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n/.exec(css)?.[1] ?? ''
  assert.match(reduced, /transition-duration/)
})

test('css: light theme tokens exist and follow the data-theme attribute', () => {
  assert.match(css, /html\[data-theme="light"\]|:root\[data-theme="light"\]/)
})
