// Issue #32 in the REAL shell (index.tsx): the Conversation panel is wired to the top bar, the C key, the
// right dock shared with Files, the Escape stack (LIFO) and the selection (per-agent preset).
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'
import { clearPair } from '@/lib/pair-filter-store'

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

beforeEach(() => { clearPair() })
afterEach(() => { cleanup(); document.body.replaceChildren(); clearPair(); resetDefaultUiPreferencesStore() })

const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }))
const wait = (ms = 200) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const key = (k: string) => act(async () => { fireEvent.keyDown(document.body, { key: k }) })

/** Demo mode: the shell has agents and messages without a relay. */
async function mountDemo() {
  const r = render(<AgentVisualizer />)
  await act(async () => { post({ type: '__vscode-bridge-init' }) })
  await wait(100)
  const demo = r.queryByRole('button', { name: 'Load demo' })
  if (demo) await act(async () => { fireEvent.click(demo) })
  await wait(2500)
  return r
}

const conversationRegion = (r: ReturnType<typeof render>) => r.queryByRole('region', { name: 'Conversation' })
const filesRegion = (r: ReturnType<typeof render>) => r.queryByRole('region', { name: 'Files accessed by agents' })
const timelineRegion = (r: ReturnType<typeof render>) => r.queryByRole('region', { name: 'Execution timeline' })

test('the top bar button is named Conversation (C) and toggles the panel; key C does the same', async () => {
  const r = await mountDemo()
  const button = r.getByRole('button', { name: 'Conversation (C)' })
  assert.equal(button.textContent, 'Conversation')
  assert.equal(button.getAttribute('aria-pressed'), 'false')
  assert.equal(r.queryByRole('button', { name: /^Chat/ }), null, 'the old Chat button is gone')
  assert.equal(conversationRegion(r), null)
  await act(async () => { fireEvent.click(button) })
  assert.ok(conversationRegion(r), 'click opens the panel')
  assert.equal(button.getAttribute('aria-pressed'), 'true')
  await key('c')
  assert.equal(conversationRegion(r), null, 'C closes it')
  await key('c')
  assert.ok(conversationRegion(r), 'C opens it')
})

test('Conversation and Files share the right dock: opening one closes the other', async () => {
  const r = await mountDemo()
  await key('c')
  assert.ok(conversationRegion(r))
  await key('f')
  assert.ok(filesRegion(r), 'Files opened')
  assert.equal(conversationRegion(r), null, 'Conversation closed by Files')
  await key('c')
  assert.ok(conversationRegion(r))
  assert.equal(filesRegion(r), null, 'Files closed by Conversation')
})

test('Escape closes the most recently opened panel first, one per press, then the selection', async () => {
  const r = await mountDemo()
  await key('t')
  assert.ok(timelineRegion(r))
  await key('c')
  assert.ok(conversationRegion(r))
  await key('Escape')
  assert.equal(conversationRegion(r), null, 'the newest panel (Conversation) closes first')
  assert.ok(timelineRegion(r), 'the older panel (Timeline) is still open')
  await key('Escape')
  assert.equal(timelineRegion(r), null)
  // the other order: Conversation first, Timeline second
  await key('c')
  await key('t')
  await key('Escape')
  assert.equal(timelineRegion(r), null)
  assert.ok(conversationRegion(r), 'now Conversation is the older one and stays')
})

test('the shortcuts dialog describes the Conversation panel and the Escape order', async () => {
  const r = await mountDemo()
  await key('?')
  const dialog = r.getByRole('dialog')
  const text = dialog.textContent ?? ''
  assert.ok(text.includes('Toggle Conversation panel'))
  assert.ok(text.includes('Close the most recently opened panel, then clear the selection'))
  assert.ok(!/transcript/i.test(text))
})

const spawn = (sessionId: string, name: string, extra: Record<string, unknown> = {}) => ({
  type: 'agent-event',
  event: { time: 1, type: 'agent_spawn', sessionId, payload: { name, ...extra } },
})

test('selecting an agent opens the Conversation panel on that agent (no second chat panel)', async () => {
  const r = render(<AgentVisualizer />)
  await act(async () => {
    post({ type: '__vscode-bridge-init' })
    post({ type: 'session-list', sessions: [{ id: 'sa', label: 'payments-api', status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now(), workspace: '/w', runtime: 'claude' }] })
  })
  await wait(100)
  await act(async () => {
    post(spawn('sa', 'main-a', { isMain: true }))
    post(spawn('sa', 'worker-a', { parent: 'main-a' }))
  })
  await act(async () => { fireEvent.click(r.getByRole('button', { name: /Hide inactive agents/ })) })
  await wait(1500)
  assert.equal(conversationRegion(r), null)
  // the canvas outline lists the agents as buttons: clicking one selects it like a canvas click
  const agentButton = Array.from(r.container.querySelectorAll<HTMLButtonElement>('section[aria-label="Agent graph outline"] li > button'))
    .find(b => (b.textContent ?? '').startsWith('worker-a'))
  assert.ok(agentButton, 'the outline exposes the agent to select')
  await act(async () => { fireEvent.click(agentButton!) })
  await wait(100)
  const region = conversationRegion(r)
  assert.ok(region, 'selection opened the panel')
  assert.ok((region!.textContent ?? '').includes('worker-a'), 'the panel header names the preset agent')
  assert.equal(r.queryByRole('region', { name: /^Conversation with / }), null, 'no separate per-agent chat panel')
  // a manual close stays closed while the same agent stays selected
  await key('Escape')
  assert.equal(conversationRegion(r), null)
  await wait(100)
  assert.equal(conversationRegion(r), null)
})

// --- Escape order and the right dock, through the real UI (selection by the agent outline) -----------------

const session = (id: string, label: string, extra: Record<string, unknown> = {}) =>
  ({ id, label, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now(), workspace: '/w', runtime: 'claude', ...extra })

async function mountWithAgents() {
  const r = render(<AgentVisualizer />)
  await act(async () => {
    post({ type: '__vscode-bridge-init' })
    post({ type: 'session-list', sessions: [session('sa', 'payments-api')] })
  })
  await wait(100)
  await act(async () => {
    post(spawn('sa', 'main-a', { isMain: true }))
    post(spawn('sa', 'worker-a', { parent: 'main-a' }))
  })
  await act(async () => { fireEvent.click(r.getByRole('button', { name: /Hide inactive agents/ })) })
  await wait(1500)
  return r
}

async function selectAgentNamed(r: ReturnType<typeof render>, name: string) {
  const button = Array.from(r.container.querySelectorAll<HTMLButtonElement>('section[aria-label="Agent graph outline"] li > button'))
    .find(b => (b.textContent ?? '').startsWith(name))
  assert.ok(button, 'the outline exposes the agent to select')
  await act(async () => { fireEvent.click(button!) })
  await wait(100)
}
const selectWorker = (r: ReturnType<typeof render>) => selectAgentNamed(r, 'worker-a')

const agentCard = (r: ReturnType<typeof render>) => r.container.querySelector<HTMLElement>('[data-dock-panel="detail"]')
const escapeOn = (el: Element) => act(async () => { fireEvent.keyDown(el, { key: 'Escape' }) })

test('Escape after selecting an agent: the newest panel closes first, one thing per press, the selection last (focus in the agent card)', async () => {
  const r = await mountWithAgents()
  await key('t')
  assert.ok(timelineRegion(r), 'Timeline opened first (older)')
  await selectWorker(r)
  assert.ok(conversationRegion(r), 'selecting opened Conversation (newer than Timeline)')
  const card = agentCard(r)
  assert.ok(card, 'the agent card shows the selection')
  assert.ok(card!.contains(document.activeElement), 'focus sits in the agent card, which handles Escape itself')

  await escapeOn(document.activeElement!)
  assert.ok(conversationRegion(r) === null, 'press 1 closes the newest panel (Conversation)')
  assert.ok(timelineRegion(r), 'press 1 leaves the older panel')
  assert.ok(agentCard(r), 'press 1 leaves the selection')

  await escapeOn(document.activeElement!)
  assert.ok(timelineRegion(r) === null, 'press 2 closes the older panel (Timeline)')
  assert.ok(agentCard(r), 'press 2 still leaves the selection')

  await escapeOn(document.activeElement!)
  assert.ok(agentCard(r) === null, 'press 3 clears the selection (fails when clearSelection is a no-op)')
})

test('Escape with focus on the page: Conversation first, the selection second (closing the panel must not close the card)', async () => {
  const r = await mountWithAgents()
  await selectWorker(r)
  assert.ok(conversationRegion(r))
  assert.ok(agentCard(r))
  await act(async () => { (document.activeElement as HTMLElement).blur() })
  await key('Escape')
  assert.ok(conversationRegion(r) === null, 'press 1 closes the panel')
  assert.ok(agentCard(r), 'press 1 does not clear the selection')
  await wait(100)
  assert.ok(agentCard(r), 'nor does the focus return of the closed panel')
  await act(async () => { (document.activeElement as HTMLElement | null)?.blur() })
  await key('Escape')
  assert.ok(agentCard(r) === null, 'press 2 clears the selection')
})

test('selecting an agent closes Files and the Cost overlay like the C / F toggles do: they share the right dock', async () => {
  const r = await mountWithAgents()
  await key('f')
  assert.ok(filesRegion(r), 'Files open')
  await selectWorker(r)
  assert.ok(conversationRegion(r), 'selection opened Conversation')
  assert.ok(filesRegion(r) === null, 'Files closed by the selection path (openConversation)')

  // Cost overlay open (the toggle path closes Conversation); selecting ANOTHER agent must close Cost again
  const cost = r.container.querySelector<HTMLElement>('#topbar-toggle-cost')!
  await key('$')
  assert.equal(cost.getAttribute('aria-pressed'), 'true', 'control: the Cost overlay opened')
  assert.ok(conversationRegion(r) === null, 'control: the toggle path closed Conversation')
  await selectAgentNamed(r, 'main-a')
  assert.ok(conversationRegion(r), 'the new selection opened Conversation')
  assert.equal(cost.getAttribute('aria-pressed'), 'false', 'Cost closed by the selection path (openConversation)')
})
