// #613: coming back to a cached view whose events the page freed from its own memory in between (a session freed by
// the session cap, the 'All' buffer trimmed) says how many it skips, with the exact number from the buffer counters.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { useSessionViewSwap } from '@/hooks/use-session-view-swap'
import { TruncationBanner } from '@/components/agent-visualizer/truncation-banner'
import { createStats } from '@/lib/event-normalize'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { SESSION_BUFFER_MAX_SESSIONS } from '@/lib/session-buffers'
import { setLocaleChoice } from '@/lib/locale'

afterEach(() => { cleanup(); document.body.replaceChildren(); setLocaleChoice('auto') })

const post = (data: unknown) => vscodeBridge!.dispatch(data)
const ev = (sessionId: string, time: number, type = 'agent_activity') => ({
  type: 'agent-event', event: { time, type, payload: { name: `main-${sessionId}`, isMain: true }, sessionId },
})
const info = (id: string) => ({ id, label: id, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now() })

// The simulation is not under test: stable no-ops, so the swap effects run only on a selection change
const sim = { restart: () => {}, saveSnapshot: () => ({}) as never, restoreSnapshot: () => {} }
const isReviewingRef = { current: false }
const noop = () => {}

type Bridge = ReturnType<typeof useVSCodeBridge>
function mount() {
  const box: { bridge: Bridge | null } = { bridge: null }
  function Harness() {
    const bridge = useVSCodeBridge()
    box.bridge = bridge
    const { memoryDropped } = useSessionViewSwap({ bridge, ...sim, isReviewingRef, onReviewEnded: noop })
    return <TruncationBanner stats={createStats()} memoryDropped={memoryDropped} onDismiss={noop} />
  }
  const r = render(<Harness />)
  const b = () => box.bridge!
  // Select a view (the session list may have auto-selected it already) and let the simulation take what was flushed
  // to it (the layout effect flushes)
  const show = (id: string) => {
    if (b().selectedSessionId !== id) act(() => { b().selectSession(id) })
    act(() => { b().consumeEvents() })
  }
  const text = () => r.container.querySelector('[data-truncation-banner]')?.textContent ?? ''
  return { b, show, text }
}

test('a session freed while another is shown: back on it, the notice gives the exact number of events skipped', () => {
  const t = mount()
  act(() => {
    post({ type: 'session-list', sessions: [info('a'), info('b')] })
    post(ev('a', 0, 'agent_spawn'))
    for (let i = 1; i < 5; i++) post(ev('a', i))
    post(ev('b', 0, 'agent_spawn'))
    post(ev('b', 1))
  })
  t.show('a')
  assert.equal(t.text(), '', 'nothing freed: no notice')
  t.show('b')
  // 7 more events of 'a' while 'b' is shown, then enough other sessions written to free 'a' (least recently written)
  act(() => { for (let i = 5; i < 12; i++) post(ev('a', i)) })
  act(() => { for (let i = 0; i < SESSION_BUFFER_MAX_SESSIONS; i++) post(ev(`o${i}`, i)) })
  assert.equal(t.b().getBufferedEventCount('a'), 0, "'a' was freed")
  assert.equal(t.text(), '', "'b' lost nothing: no notice")
  t.show('a')
  assert.match(t.text(), /7 older events freed from the page's memory/)
  // Leaving and coming back again: the canvas still lacks them, the number stays
  t.show('b')
  t.show('a')
  assert.match(t.text(), /7 older events freed from the page's memory/)
})

test("the 'All' view: events trimmed from its buffer after the snapshot are counted exactly", () => {
  const t = mount()
  act(() => {
    post({ type: 'session-list', sessions: [info('a'), info('b')] })
    post(ev('a', 0, 'agent_spawn'))
    post(ev('b', 0, 'agent_spawn'))
  })
  t.show(ALL_SESSIONS_ID)
  t.show('a')
  // The 'All' buffer holds 50 000 events and trims back to them past 55 000: 55 001 events in all make it drop
  // positions 0..5000, the 2 the snapshot drew and 4999 after them
  act(() => { for (let i = 2; i < 55_003; i++) post(ev(i % 2 === 0 ? 'a' : 'b', i)) })
  assert.equal(t.text(), '', "'a' is shown and lost nothing it draws")
  t.show(ALL_SESSIONS_ID)
  assert.match(t.text(), /4999 older events freed from the page's memory/)
})

test('the notice reads in French too', () => {
  setLocaleChoice('fr')
  const r = render(<TruncationBanner stats={createStats()} memoryDropped={7} onDismiss={noop} />)
  assert.match(r.container.textContent ?? '', /7 événements plus anciens retirés de la mémoire de la page/)
})
