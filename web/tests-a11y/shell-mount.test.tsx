// #36 / #12: mount the REAL AgentVisualizer (index.tsx) and check the wiring between the bridge, the
// simulation, the canvas and the pair filter. Each test fails when the wiring it guards is removed.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { clearPair, getPair } from '@/lib/pair-filter-store'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'

// Web Audio is not in jsdom: a deep no-op stub
const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }

;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

beforeEach(() => { clearPair(); })
afterEach(() => { cleanup(); document.body.replaceChildren(); clearPair(); resetDefaultUiPreferencesStore() })

const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }))
const spawn = (sessionId: string, name: string, extra: Record<string, unknown> = {}) => ({
  type: 'agent-event',
  event: { time: 1, type: 'agent_spawn', sessionId, payload: { name, ...extra } },
})
const info = (id: string, label: string, workspace: string) => ({
  id, label, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now(), workspace, runtime: 'claude',
})
const wait = (ms = 400) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
/** Poll an observable condition (inside act) instead of sleeping a fixed time: a loaded CI runner is slower, not wrong. */
async function waitUntil(cond: () => boolean, what: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timeout waiting for: ${what}`)
    await wait(50)
  }
}

/** The Sessions panel replaced the session tabs: open it (once) and work on its rows. */
async function openSessions(r: ReturnType<typeof render>) {
  if (!r.container.querySelector('[data-row-main]')) {
    await act(async () => { fireEvent.click(r.getByRole('button', { name: /^Sessions:/ })) })
    await wait(100)
  }
}
const sessionRows = (r: ReturnType<typeof render>) => Array.from(r.container.querySelectorAll<HTMLElement>('[data-row-main]'))
const sessionRow = (r: ReturnType<typeof render>, label: RegExp) =>
  sessionRows(r).find(el => label.test(el.textContent ?? '') && !el.getAttribute('aria-label'))!
const selectAll = async (r: ReturnType<typeof render>) => {
  await openSessions(r)
  await act(async () => { fireEvent.click(sessionRows(r)[0]) })
}

async function mountTwoSessions() {
  const r = render(<AgentVisualizer />)
  await act(async () => {
    post({ type: '__vscode-bridge-init' })
    post({ type: 'session-list', sessions: [info('sa', 'payments-api', '/w/payments'), info('sb', 'web-app', '/w/web')] })
  })
  await wait(100)
  await selectAll(r)
  await wait(100)
  await act(async () => {
    post(spawn('sa', 'main-a', { isMain: true }))
    post(spawn('sa', 'worker-a', { parent: 'main-a' }))
    post(spawn('sb', 'main-b', { isMain: true }))
  })
  await act(async () => { fireEvent.click(r.getByRole('button', { name: /Hide inactive agents/ })) })
  const agentItems = () => Array.from(r.container.querySelectorAll('li')).map(li => li.textContent ?? '')
  await waitUntil(() => ['main-a', 'worker-a', 'main-b'].every(n => agentItems().some(t => t.startsWith(n))), 'the three agents are drawn')
  await wait(300)
  return r
}

function shiftClickAt(el: Element, x: number, y: number) {
  const init = { clientX: x, clientY: y, shiftKey: true, button: 0, pointerId: 1, pointerType: 'mouse', bubbles: true }
  fireEvent.pointerDown(el, init)
  fireEvent.pointerUp(el, init)
}

/** Shift-click scan over the area where the layout puts the agents, until `done` holds (jsdom has no layout).
 *  A Shift-click on the agent already picked toggles it off, so a hit on the same agent must be undone, not counted. */
function shiftClickScan(el: Element, done: () => boolean): boolean {
  for (let x = 280; x <= 520; x += 4) {
    for (let y = 130; y <= 270; y += 4) {
      const before = getPair()
      shiftClickAt(el, x, y)
      if (done()) return true
      // Picking the agent that is already the first one clears the pair (a toggle): a pixel next to the previous
      // hit lands on the same agent, so put the first pick back and carry on looking for a different agent.
      if (before.a !== '' && before.b === '' && getPair().a === '') shiftClickAt(el, x, y)
    }
  }
  return false
}

test('sessions (label, workspace) reach the canvas: halo outline carries the session meta', async () => {
  const r = await mountTwoSessions()
  const text = r.container.textContent ?? ''
  assert.ok(text.includes('Session payments-api, 2 agents, Claude, workspace /w/payments'), 'halo title from the sessions prop')
  assert.ok(text.includes('Session web-app, 1 agent, Claude, workspace /w/web'))
})

test('the canvas draws labelled agents: each agent carries its session label', async () => {
  const r = await mountTwoSessions()
  const items = Array.from(r.container.querySelectorAll('li')).map(li => li.textContent ?? '')
  const mainA = items.find(t => t.startsWith('main-a'))
  const mainB = items.find(t => t.startsWith('main-b'))
  assert.ok(mainA?.includes('Session payments-api.'), `main-a: ${mainA}`)
  assert.ok(mainB?.includes('Session web-app.'), `main-b: ${mainB}`)
})

test('onClusterSelect reaches the canvas: a halo click selects its session tab when All shows one session', async () => {
  const r = render(<AgentVisualizer />)
  await act(async () => {
    post({ type: '__vscode-bridge-init' })
    post({
      type: 'session-list',
      sessions: [
        info('sa', 'payments-api', '/w/payments'),
        { ...info('sb', 'web-app', '/w/web'), status: 'completed', lastActivityTime: Date.now() - 3 * 3_600_000 },
      ],
    })
  })
  await wait(100)
  await selectAll(r)
  await wait(100)
  await act(async () => {
    post(spawn('sa', 'main-a', { isMain: true }))
    post(spawn('sa', 'worker-a', { parent: 'main-a' }))
  })
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Hide inactive agents' })) })
  await waitUntil(() => r.container.textContent?.includes('Session payments-api, 2 agents') ?? false, 'the payments-api halo is drawn')
  await wait(300)
  await openSessions(r)
  const tab = () => sessionRow(r, /payments-api/)
  assert.equal(sessionRows(r)[0].getAttribute('aria-current'), 'true', 'All is selected before the click')
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Zoom to session payments-api' })) })
  await waitUntil(() => tab().getAttribute('aria-current') === 'true', 'the halo click selects the session row')
  assert.equal(tab().getAttribute('aria-current'), 'true', 'the session row is selected by the halo click')
  assert.equal(sessionRows(r)[0].getAttribute('aria-current'), null)
})

test('Shift-click on the canvas picks the pair, and the pair is pruned when its agents leave', async () => {
  const r = await mountTwoSessions()
  const canvas = r.container.querySelector('canvas')!
  assert.equal(getPair().a, '')
  const done = () => getPair().a !== '' && getPair().b !== ''
  // The layout settles asynchronously: rescan (letting the simulation advance in between) until the pair is complete
  let picked = false
  const deadline = Date.now() + 25_000
  while (!picked && Date.now() < deadline) {
    picked = shiftClickScan(canvas, done)
    if (!picked) await wait(200)
  }
  assert.ok(picked, 'two Shift-clicks on two agents complete the pair')
  const pair = getPair()
  assert.notEqual(pair.a, pair.b)
  assert.ok(pair.a.startsWith('sa:') && pair.b.startsWith('sa:'), JSON.stringify(pair))

  // Switching to the other session removes both agents from the simulation: the pair must not outlive them
  await openSessions(r)
  await act(async () => { fireEvent.click(sessionRow(r, /web-app/)) })
  await waitUntil(() => getPair().a === '' && getPair().b === '', 'the pair is pruned')
  assert.deepEqual(getPair(), { a: '', b: '' })
})
