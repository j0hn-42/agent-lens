// Events the VS Code panel never receives (#592). Without the SSE relay there is no cursor and no `event-loss.gap`:
// the extension posts each event straight to the open panel, drops it while no panel is ready, and a panel that opens
// (or reopens) is only re-sent the agents (spawns, links, models) from memory. Every other event emitted before that
// page's `ready` is missing from its graph. The ledger counts them per session, minus what the panel's replay re-sends,
// and the extension sends the result as `event-loss` once per page: a lower bound, never an invented figure.
import './helpers/alias-vscode'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import { PanelLossLedger, panelLoss } from '../src/panel-loss'
import { wireWatcherToPanel } from '../src/session-runtime'
import { VisualizerPanel } from '../src/webview-provider'

const ev = (sessionId: string | undefined, type = 'message', replayed = false): AgentEvent =>
  ({ time: 1, type, payload: {}, ...(sessionId ? { sessionId } : {}), ...(replayed ? { replayed: true } : {}) }) as unknown as AgentEvent

describe('PanelLossLedger (#592)', () => {
  it('nothing emitted yet: no figure at all (null, not a zero)', () => {
    const l = new PanelLossLedger()
    assert.equal(l.snapshotAfterReplay(() => {}), null)
  })

  it('counts per session every event emitted before the page is ready; an event without session claims nothing', () => {
    const l = new PanelLossLedger()
    for (let i = 0; i < 5; i++) l.note(ev('a'))
    l.note(ev('b'))
    l.note(ev(undefined))
    l.note(null)
    assert.deepEqual(l.snapshotAfterReplay(() => {}), { evicted: { a: 5, b: 1 } })
  })

  it('history read from a transcript (marked replayed by the reader) is still an event the page lacks', () => {
    const l = new PanelLossLedger()
    l.note(ev('a', 'tool_call_start', true))
    assert.deepEqual(l.snapshotAfterReplay(() => {}), { evicted: { a: 1 } })
  })

  it('what the panel replay re-sends is subtracted (it does reach the page), never below zero, and is not counted for the next page', () => {
    const l = new PanelLossLedger()
    l.note(ev('a', 'agent_spawn'))
    l.note(ev('a', 'message'))
    l.note(ev('a', 'message'))
    l.note(ev('b', 'agent_spawn'))
    const loss = l.snapshotAfterReplay(() => {
      // The replay re-emits through the same path: noted while replaying, they are what the page receives
      l.note(ev('a', 'agent_spawn'))
      l.note(ev('b', 'agent_spawn'))
      l.note(ev('b', 'model_detected'))
    })
    assert.deepEqual(loss, { evicted: { a: 2 } }, 'b: 1 emitted, 2 re-sent -> nothing claimed')
    // A page that opens later lacks the same events, and the replays never add up
    assert.deepEqual(l.snapshotAfterReplay(() => { l.note(ev('a', 'agent_spawn')); l.note(ev('b', 'agent_spawn')) }), { evicted: { a: 2 } })
    // A replay that no longer re-sends b (session gone): its spawn is lacking now
    assert.deepEqual(l.snapshotAfterReplay(() => { l.note(ev('a', 'agent_spawn')) }), { evicted: { a: 2, b: 1 } })
  })

  it('live events delivered to the open page are counted for a page that opens later (it gets reset, not the history)', () => {
    const l = new PanelLossLedger()
    assert.equal(l.snapshotAfterReplay(() => {}), null)
    l.note(ev('a'))
    l.note(ev('a'))
    assert.deepEqual(l.snapshotAfterReplay(() => {}), { evicted: { a: 2 } })
  })

  it('stays bounded in sessions: the least recent ones are folded into otherEvents', () => {
    const l = new PanelLossLedger(3)
    for (const sid of ['s1', 's2', 's3', 's4', 's5']) l.note(ev(sid))
    l.note(ev('s5'))
    const loss = l.snapshotAfterReplay(() => {})
    assert.deepEqual(loss, { evicted: { s3: 1, s4: 1, s5: 2 }, otherEvents: 2 })
  })

  it('the replay of a session folded into otherEvents lowers otherEvents, never below zero', () => {
    const l = new PanelLossLedger(1)
    l.note(ev('old'))
    l.note(ev('new'))
    const loss = l.snapshotAfterReplay(() => { l.note(ev('old', 'agent_spawn')); l.note(ev('gone', 'agent_spawn')) })
    assert.deepEqual(loss, { evicted: { new: 1 } })
  })
})

describe('wireWatcherToPanel notes what no ready panel receives (#592)', () => {
  beforeEach(() => panelLoss.clear())

  it('without a panel, the events are dropped and counted; a transform that discards an event discards it from the count too', () => {
    assert.equal(VisualizerPanel.getCurrent(), undefined)
    let fire: ((e: AgentEvent) => void) | undefined
    const noop = () => ({ dispose() {} })
    const watcher = {
      onEvent: (cb: (e: AgentEvent) => void) => { fire = cb; return { dispose() {} } },
      onSessionDetected: noop, onSessionLifecycle: noop,
      getActiveSessions: () => [],
    }
    const wiring = wireWatcherToPanel(watcher as never, {
      sessionLabelPrefix: 'Test',
      transformEvent: e => ((e.type as string) === 'drop-me' ? null : e),
    })
    fire!(ev('a'))
    fire!(ev('a', 'drop-me'))
    fire!(ev('b'))
    wiring.dispose()
    assert.deepEqual(panelLoss.snapshotAfterReplay(() => {}), { evicted: { a: 1, b: 1 } })
  })
})
