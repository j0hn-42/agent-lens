// #36 / #12: mount the REAL AgentVisualizer (index.tsx) and check the wiring between the bridge, the
// simulation, the canvas and the pair filter. Each test fails when the wiring it guards is removed.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { clearPair, getPair } from '@/lib/pair-filter-store'

// Web Audio is not in jsdom: a deep no-op stub
const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }

;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

beforeEach(() => { clearPair(); })
afterEach(() => { cleanup(); document.body.replaceChildren(); clearPair() })

const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }))
const spawn = (sessionId: string, name: string, extra: Record<string, unknown> = {}) => ({
  type: 'agent-event',
  event: { time: 1, type: 'agent_spawn', sessionId, payload: { name, ...extra } },
})
const info = (id: string, label: string, workspace: string) => ({
  id, label, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now(), workspace, runtime: 'claude',
})
const wait = (ms = 400) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

async function mountTwoSessions() {
  const r = render(<AgentVisualizer />)
  await act(async () => {
    post({ type: '__vscode-bridge-init' })
    post({ type: 'session-list', sessions: [info('sa', 'payments-api', '/w/payments'), info('sb', 'web-app', '/w/web')] })
  })
  await wait(100)
  await act(async () => { fireEvent.click(r.getByRole('tab', { name: /All/ })) })
  await wait(100)
  await act(async () => {
    post(spawn('sa', 'main-a', { isMain: true }))
    post(spawn('sa', 'worker-a', { parent: 'main-a' }))
    post(spawn('sb', 'main-b', { isMain: true }))
  })
  await act(async () => { fireEvent.click(r.getByRole('button', { name: /Hide inactive agents/ })) })
  await wait(1500)
  return r
}

function shiftClickAt(el: Element, x: number, y: number) {
  const init = { clientX: x, clientY: y, shiftKey: true, button: 0, pointerId: 1, pointerType: 'mouse', bubbles: true }
  fireEvent.pointerDown(el, init)
  fireEvent.pointerUp(el, init)
}

/** Shift-click scan over the area where the layout puts the agents, until `done` holds (jsdom has no layout) */
function shiftClickScan(el: Element, done: () => boolean): boolean {
  for (let x = 280; x <= 520; x += 4) {
    for (let y = 130; y <= 270; y += 4) {
      shiftClickAt(el, x, y)
      if (done()) return true
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
  await act(async () => { fireEvent.click(r.getByRole('tab', { name: /^All/ })) })
  await wait(100)
  await act(async () => {
    post(spawn('sa', 'main-a', { isMain: true }))
    post(spawn('sa', 'worker-a', { parent: 'main-a' }))
  })
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Hide inactive agents' })) })
  await wait(1500)
  const tab = () => r.getAllByRole('tab').find(t => /payments-api/.test(t.textContent ?? ''))!
  assert.equal(r.getAllByRole('tab')[0].getAttribute('aria-selected'), 'true', 'All is selected before the click')
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Zoom to session payments-api' })) })
  await wait(300)
  assert.equal(tab().getAttribute('aria-selected'), 'true', 'the session tab is selected by the halo click')
  assert.equal(r.getAllByRole('tab')[0].getAttribute('aria-selected'), 'false')
})

test('Shift-click on the canvas picks the pair, and the pair is pruned when its agents leave', async () => {
  const r = await mountTwoSessions()
  const canvas = r.container.querySelector('canvas')!
  assert.equal(getPair().a, '')
  const picked = shiftClickScan(canvas, () => getPair().a !== '' && getPair().b !== '')
  assert.ok(picked, 'two Shift-clicks on two agents complete the pair')
  const pair = getPair()
  assert.notEqual(pair.a, pair.b)
  assert.ok(pair.a.startsWith('sa:') && pair.b.startsWith('sa:'), JSON.stringify(pair))

  // Switching to the other session removes both agents from the simulation: the pair must not outlive them
  await act(async () => { fireEvent.click(r.getAllByRole('tab').find(t => /web-app/.test(t.textContent ?? ''))!) })
  await wait(800)
  assert.deepEqual(getPair(), { a: '', b: '' })
})
