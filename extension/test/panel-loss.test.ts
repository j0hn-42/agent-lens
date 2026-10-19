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

  it('stays bounded in sessions: the least recent ones are dropped from the figure, never added up (#605 review)', () => {
    const l = new PanelLossLedger(3)
    for (const sid of ['s1', 's2', 's3', 's4', 's5']) l.note(ev(sid))
    l.note(ev('s5'))
    const loss = l.snapshotAfterReplay(() => {})
    assert.deepEqual(loss, { evicted: { s3: 1, s4: 1, s5: 2 } }, 'no otherEvents: s1 and s2 are no longer counted')
  })

  it('the replay of a dropped session claims nothing', () => {
    const l = new PanelLossLedger(1)
    l.note(ev('old'))
    l.note(ev('new'))
    const loss = l.snapshotAfterReplay(() => { l.note(ev('old', 'agent_spawn')); l.note(ev('gone', 'agent_spawn')) })
    assert.deepEqual(loss, { evicted: { new: 1 } })
  })
})

const sum = (loss: { evicted: Record<string, number>; otherEvents?: number } | null): number =>
  loss ? Object.values(loss.evicted).reduce((a, b) => a + b, 0) + (loss.otherEvents ?? 0) : 0

describe('PanelLossLedger past 200 sessions never claims more than it can prove (#605 review, round 2)', () => {
  it('watcher: x emits 30, is released, 200 other sessions emit, x is found again with its 30 read again: at most 230', () => {
    const l = new PanelLossLedger(200)
    for (let i = 0; i < 30; i++) l.note(ev('x'))
    l.release('x')
    for (let i = 0; i < 200; i++) l.note(ev(`s${i}`))
    for (let i = 0; i < 30; i++) l.note(ev('x', 'message', true))
    const shown = sum(l.snapshotAfterReplay(() => {}))
    assert.ok(shown <= 230, `shown ${shown}, proven 230`)
    assert.ok(shown > 0)
  })

  it('a session that comes back after it was dropped: its history read again is counted at most once', () => {
    const l = new PanelLossLedger(2)
    for (let i = 0; i < 10; i++) l.note(ev('x'))
    l.note(ev('a'))
    l.note(ev('b')) // x dropped
    l.release('x') // not named: nothing of x is in the figure, nothing to release
    for (let i = 0; i < 10; i++) l.note(ev('x', 'message', true))
    assert.deepEqual(l.snapshotAfterReplay(() => {}), { evicted: { b: 1, x: 10 } })
  })

  it('releasing a session that is not named neither names it nor drops another one (no cascade, #605 review M1)', () => {
    const l = new PanelLossLedger(2)
    l.note(ev('a'))
    l.note(ev('b'))
    l.release('never-seen')
    l.release('a')
    assert.deepEqual(l.snapshotAfterReplay(() => {}), { evicted: { a: 1, b: 1 } })
  })

  it('a dropped session whose history comes again while a page is open lowers that page\'s figure', () => {
    const queued: (() => void)[] = []
    const l = new PanelLossLedger(2, fn => queued.push(fn))
    for (let i = 0; i < 5; i++) l.note(ev('x'))
    const sent: unknown[] = []
    assert.deepEqual(l.snapshotAfterReplay(() => {}, loss => sent.push(loss)), { evicted: { x: 5 } })
    l.release('x')
    l.note(ev('a'))
    l.note(ev('b')) // x dropped from the ledger, still on the page
    for (let i = 0; i < 5; i++) l.note(ev('x', 'message', true))
    for (const fn of queued.splice(0)) fn()
    assert.deepEqual(sent, [{ evicted: {} }], 'the page received x\'s 5 events again: it lacks none of them')
  })
})

/** Deterministic PRNG (mulberry32): a fixed seed replays the same run */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('PanelLossLedger property: the figure never exceeds the truth (#605 review, round 2)', () => {
  // Model of the sources: a session's distinct events are numbered 0..n-1. A watcher that forgot a session (release)
  // emits its whole history again before anything else of it (replayed, or reread for the JSONL log), possibly with
  // lines added meanwhile. A page that opens gets the panel's replay (copies of the first events of some sessions);
  // while it is open, every event emitted reaches it. Truth for a page: per session, the distinct events it did not get.
  for (const seed of [1, 2, 3, 7, 42, 592, 605, 1234, 9001, 31337]) {
    it(`seed ${seed}, maxSessions 200, 300 sessions (some dropped and coming back)`, () => {
      const r = rng(seed)
      const pick = (n: number) => Math.floor(r() * n)
      const queued: (() => void)[] = []
      const l = new PanelLossLedger(200, fn => queued.push(fn))
      const n = new Map<string, number>()
      const forgot = new Set<string>()
      let page: { delivered: Map<string, Set<number>>; figure: Record<string, number>; send: (x: { evicted: Record<string, number> }) => void } | null = null
      const deliver = (sid: string, i: number) => {
        if (!page) return
        const d = page.delivered.get(sid) ?? new Set<number>()
        d.add(i)
        page.delivered.set(sid, d)
      }
      const replayHistory = (sid: string) => {
        const added = pick(3)
        n.set(sid, (n.get(sid) ?? 0) + added)
        const reread = r() < 0.5
        for (let i = 0; i < (n.get(sid) ?? 0); i++) {
          l.note(ev(sid, 'message', !reread), { reread })
          deliver(sid, i)
        }
        forgot.delete(sid)
      }
      const checkPage = () => {
        if (!page) return
        for (const [sid, shown] of Object.entries(page.figure)) {
          const truth = (n.get(sid) ?? 0) - (page.delivered.get(sid)?.size ?? 0)
          assert.ok(shown <= truth, `seed ${seed}: page shows ${shown} for ${sid}, truth ${truth}`)
        }
      }
      for (let step = 0; step < 4000; step++) {
        const sid = `s${pick(300)}`
        const op = r()
        if (op < 0.5) {
          if (forgot.has(sid)) replayHistory(sid)
          const i = n.get(sid) ?? 0
          n.set(sid, i + 1)
          l.note(ev(sid, 'message', (n.get(sid) ?? 0) === 1 && r() < 0.5)) // a first attach may mark its history replayed
          deliver(sid, i)
        } else if (op < 0.62) {
          l.release(sid)
          forgot.add(sid)
        } else if (op < 0.72) {
          if (forgot.has(sid)) replayHistory(sid)
        } else if (op < 0.76) {
          // A JSONL log disconnected: many sessions released in a row
          for (let k = 0; k < 50; k++) { const s = `s${pick(300)}`; l.release(s); forgot.add(s) }
        } else if (op < 0.82) {
          if (page) l.endPage(page.send)
          const resent = new Map<string, number>()
          const send = (x: { evicted: Record<string, number> }) => { if (page && page.send === send) page.figure = x.evicted }
          const snap = l.snapshotAfterReplay(() => {
            for (let k = 0; k < 5; k++) {
              const s = `s${pick(300)}`
              const have = n.get(s) ?? 0
              if (have === 0 || forgot.has(s)) continue
              const c = Math.min(have, 1 + pick(2))
              resent.set(s, Math.max(resent.get(s) ?? 0, c))
              for (let j = 0; j < c; j++) l.note(ev(s, 'agent_spawn'))
            }
          }, send)
          page = { delivered: new Map(), figure: snap?.evicted ?? {}, send }
          for (const [s, c] of resent) for (let j = 0; j < c; j++) deliver(s, j)
          assert.ok(!snap || !('otherEvents' in snap), 'no running total of dropped sessions')
          let truthAll = 0
          for (const [s, have] of n) truthAll += have - (page.delivered.get(s)?.size ?? 0)
          assert.ok(sum(snap) <= truthAll, `seed ${seed}: figure ${sum(snap)}, truth ${truthAll}`)
        } else if (op < 0.84) {
          if (page) { l.endPage(page.send); page = null }
        }
        for (const fn of queued.splice(0)) fn()
        checkPage()
      }
    })
  }
})

describe('PanelLossLedger: a history read again is counted once, not twice (#592, #601 review)', () => {
  const history = (l: PanelLossLedger, sid: string, n: number) => { for (let i = 0; i < n; i++) l.note(ev(sid, 'message', true)) }

  it('a released session whose history comes again counts max(before, read again) plus what is new, never the sum', () => {
    const l = new PanelLossLedger()
    history(l, 'a', 5)
    l.note(ev('a'))
    l.release('a')
    history(l, 'a', 4)
    assert.deepEqual(l.snapshotAfterReplay(() => {}), { evicted: { a: 6 } }, '6 counted before, 4 read again: still 6')
    history(l, 'a', 3)
    assert.deepEqual(l.snapshotAfterReplay(() => {}), { evicted: { a: 7 } }, '7 read again (it grew): 7, not 13')
    l.note(ev('a'))
    l.note(ev('a'))
    assert.deepEqual(l.snapshotAfterReplay(() => {}), { evicted: { a: 9 } }, 'live events after the history are new')
    l.release('a')
    history(l, 'a', 2)
    assert.deepEqual(l.snapshotAfterReplay(() => {}), { evicted: { a: 9 } }, 'a second release keeps the floor')
  })

  it('without a release, history events are new events (first attach) and add up', () => {
    const l = new PanelLossLedger()
    history(l, 'a', 3)
    history(l, 'a', 3)
    assert.deepEqual(l.snapshotAfterReplay(() => {}), { evicted: { a: 6 } })
  })

  it('a history read again while a page is open lowers that page\'s figure, once per burst, and empty clears it', () => {
    const queued: (() => void)[] = []
    const l = new PanelLossLedger(200, fn => queued.push(fn))
    history(l, 'a', 3)
    l.note(ev('b'))
    const sent: unknown[] = []
    assert.deepEqual(l.snapshotAfterReplay(() => {}, loss => sent.push(loss)), { evicted: { a: 3, b: 1 } })
    l.release('a')
    l.note(ev('a')) // live after the release: the page receives it live, it lacked nothing more and nothing less
    history(l, 'a', 2)
    assert.equal(queued.length, 1, 'one update for the burst')
    queued.shift()!()
    assert.deepEqual(sent, [{ evicted: { a: 1, b: 1 } }])
    history(l, 'a', 5)
    queued.shift()!()
    assert.deepEqual(sent[1], { evicted: { b: 1 } }, 'never below zero')
    l.release('b')
    history(l, 'b', 1)
    queued.shift()!()
    assert.deepEqual(sent[2], { evicted: {} }, 'sent empty: the page drops its figure')
  })

  it('an update for a page that was replaced is not sent', () => {
    const queued: (() => void)[] = []
    const l = new PanelLossLedger(200, fn => queued.push(fn))
    history(l, 'a', 3)
    const first: unknown[] = []
    l.snapshotAfterReplay(() => {}, loss => first.push(loss))
    l.release('a')
    history(l, 'a', 1)
    l.snapshotAfterReplay(() => {}, () => {})
    for (const fn of queued) fn()
    assert.deepEqual(first, [])
  })

  it('a closed page is let go: nothing queued or sent for it, and ending another page changes nothing (#605 review)', () => {
    const queued: (() => void)[] = []
    const l = new PanelLossLedger(200, fn => queued.push(fn))
    history(l, 'a', 3)
    const sent: unknown[] = []
    const send = (loss: unknown) => sent.push(loss)
    l.snapshotAfterReplay(() => {}, send)
    l.endPage(() => {})
    l.release('a')
    history(l, 'a', 1)
    assert.equal(queued.length, 1, 'ending another page left this one open')
    queued.shift()!()
    l.endPage(send)
    history(l, 'a', 1)
    assert.equal(queued.length, 0, 'nothing is lowered for a closed page')
    assert.equal(sent.length, 1)
  })

  it('releasing a dropped session changes nothing; its history read again counts once: a lower bound kept', () => {
    const l = new PanelLossLedger(1)
    history(l, 'old', 4)
    history(l, 'new', 1) // old (4) is dropped
    l.release('old') // nothing of old is in the figure
    history(l, 'old', 4) // counted anew, which drops new (1)
    assert.deepEqual(l.snapshotAfterReplay(() => {}), { evicted: { old: 4 } }, 'old: 4, never 4 + 4')
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
