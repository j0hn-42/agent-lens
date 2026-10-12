// Guided tour on a real session (#244): mounts the REAL AgentVisualizer (index.tsx) fed like a relay would,
// and checks that the tour explains what is on screen, never seeks, and says when a step is no longer true.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { AgentVisualizer } from '@/components/agent-visualizer'
import { GuidedTourCard } from '@/components/agent-visualizer/guided-tour-card'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'
import { LEGEND_ENTRY_IDS } from '@/lib/legend-entries'

// Web Audio is not in jsdom: a deep no-op stub
const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

afterEach(() => { cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore(); window.localStorage.clear() })

const post = (data: unknown) => vscodeBridge!.dispatch(data)
const event = (type: string, payload: Record<string, unknown>, sessionId = 'live') => ({ type: 'agent-event', event: { time: 1, type, sessionId, payload } })
const wait = (ms = 400) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
async function waitUntil(cond: () => boolean, what: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timeout waiting for: ${what}`)
    await wait(50)
  }
}
const entries = () => [...document.querySelectorAll('[data-legend-entry]')].map(el => el.getAttribute('data-legend-entry'))

async function mountLiveSession() {
  const r = render(<AgentVisualizer />)
  await act(async () => {
    post({ type: '__vscode-bridge-init' })
    post({ type: 'session-list', sessions: [{ id: 'live', label: 'live-session', status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now(), workspace: '/w/live', runtime: 'claude' }] })
    post(event('agent_spawn', { name: 'main', isMain: true, task: 'Fix the build' }))
    post(event('permission_requested', { agent: 'main' }))
  })
  await waitUntil(() => r.queryByRole('button', { name: 'Tour this session' }) !== null, 'the live tour is offered')
  return r
}

test('a real session with agents on screen offers the tour; the guided demo name is not used', async () => {
  const r = await mountLiveSession()
  assert.equal(r.queryByRole('button', { name: 'Guided tour' }), null)
})

test('the legend of a live session lists the symbols on screen only', async () => {
  const r = await mountLiveSession()
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Legend' })) })
  await waitUntil(() => entries().includes('shape-main'), 'the main agent is in the legend')
  const shown = new Set(entries())
  assert.ok(shown.size > 0 && shown.size < LEGEND_ENTRY_IDS.length, `${shown.size} of ${LEGEND_ENTRY_IDS.length}`)
  assert.ok(shown.has('state-waiting_permission'), 'the permission request is proven by the event')
  for (const absent of ['rt-codex', 'shape-discovery', 'edge-file-conflict', 'team-row', 'link-error'] as const) assert.ok(!shown.has(absent), absent)
})

test('the live tour explains what is on screen, keeps the scene live, and Escape ends it', async () => {
  const r = await mountLiveSession()
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Tour this session' })) })
  const dialog = await r.findByRole('dialog')
  assert.match(dialog.textContent ?? '', /Step 1 of \d+/)
  assert.ok(!/codex|sub-agent|teammate|conflict/i.test(dialog.textContent ?? ''), 'nothing about what is not there')
  assert.equal(r.queryByRole('button', { name: 'Resume live' }), null, 'the tour did not pause the scene')
  await act(async () => { fireEvent.keyDown(dialog, { key: 'Escape' }) })
  await wait(100)
  assert.equal(r.queryByRole('dialog', { name: /./ })?.querySelector('#guided-tour-title') ?? null, null)
  assert.ok(r.getByRole('button', { name: 'Tour this session' }), 'offered again once it ended')
})

test('the tour card says when the step is no longer on screen', () => {
  const steps = [{ id: 's', target: { kind: 'none' as const }, title: 'State: error', body: 'An agent is in error.', covers: ['state-error' as const] }]
  const noop = () => {}
  const view = render(<GuidedTourCard steps={steps} index={0} onNext={noop} onPrev={noop} onGoTo={noop} onExit={noop} stale />)
  const note = view.getByText(/no longer on screen/i)
  assert.ok(note.closest('[aria-live="polite"]'), 'announced politely')
  cleanup()
  const fresh = render(<GuidedTourCard steps={steps} index={0} onNext={noop} onPrev={noop} onGoTo={noop} onExit={noop} />)
  assert.equal(fresh.queryByText(/no longer on screen/i), null)
})
