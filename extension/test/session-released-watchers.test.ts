/**
 * onSessionReleased of the Codex, Copilot, Gemini CLI and Pi watchers (#592, #605 review round 3, M3). A retired
 * session keeps its read position, so reattaching it reads only what follows; past 4 times the watched-session cap the
 * oldest retired one is forgotten for good, and if it comes back its history is read again from the start (marked
 * `replayed`). Without the release signal, the panel-loss ledger would count that history on top of what it already
 * counted: twice.
 */
import './helpers/alias-vscode'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import { CodexSessionWatcher } from '../src/codex-session-watcher'
import { CopilotSessionWatcher } from '../src/copilot-session-watcher'
import { GeminiSessionWatcher } from '../src/gemini-session-watcher'
import { PiSessionWatcher } from '../src/pi-session-watcher'
import {
  CODEX_MAX_WATCHED_SESSIONS, COPILOT_MAX_WATCHED_SESSIONS, GEMINI_MAX_WATCHED_SESSIONS, PI_MAX_WATCHED_SESSIONS,
} from '../src/constants'
import { wireWatcherToPanel } from '../src/session-runtime'
import { panelLoss } from '../src/panel-loss'

type Watcher = CodexSessionWatcher | CopilotSessionWatcher | GeminiSessionWatcher | PiSessionWatcher
type Internals = { sessions: Map<string, unknown>; retired: Map<string, unknown>; releaseEndedSessions(): void }

const cases: Array<{ name: string; make: () => Watcher; cap: number }> = [
  { name: 'Codex', make: () => new CodexSessionWatcher('/tmp/ws'), cap: CODEX_MAX_WATCHED_SESSIONS },
  { name: 'Copilot', make: () => new CopilotSessionWatcher('/tmp/ws'), cap: COPILOT_MAX_WATCHED_SESSIONS },
  { name: 'Gemini CLI', make: () => new GeminiSessionWatcher('/tmp/ws'), cap: GEMINI_MAX_WATCHED_SESSIONS },
  { name: 'Pi', make: () => new PiSessionWatcher('/tmp/ws'), cap: PI_MAX_WATCHED_SESSIONS },
]

/** A watched session ended long ago: what retire() reads of it, no watcher or timer to close */
const ended = (id: string) => ({
  sessionId: id, filePath: `/tmp/ws/${id}.jsonl`, fileSize: 10, fileTail: '', ino: 1, label: id,
  sessionStartTime: 0, lastActivityTime: 0, fileWatcher: null, pollTimer: null,
  eventState: {}, rolloutState: {},
})
const event = (sessionId: string, replayed = false) =>
  ({ time: 1, type: 'message', payload: { agent: 'a', content: 'x' }, sessionId, ...(replayed ? { replayed: true } : {}) }) as unknown as AgentEvent

for (const { name, make, cap } of cases) {
  describe(`${name} watcher: a retired session forgotten for good is released (#605 review round 3)`, () => {
    beforeEach(() => panelLoss.clear())

    it(`past ${cap} * 4 retired sessions, the oldest is released, once`, () => {
      const watcher = make()
      const internals = watcher as unknown as Internals
      const released: string[] = []
      const sub = watcher.onSessionReleased!((id) => released.push(id))
      try {
        for (let i = 0; i <= cap * 4; i++) internals.sessions.set(`s${i}`, ended(`s${i}`))
        internals.releaseEndedSessions()
        assert.deepEqual(released, ['s0'])
        assert.equal(internals.retired.size, cap * 4)
        assert.equal(internals.retired.has('s0'), false)
      } finally { sub.dispose(); watcher.dispose() }
    })

    it('wired to the panel: the history read again after the release is not counted twice', () => {
      const watcher = make()
      const internals = watcher as unknown as Internals
      const wiring = wireWatcherToPanel(watcher, { sessionLabelPrefix: name })
      try {
        // 3 events of s0 emitted live, then s0 retired with cap * 4 others: forgotten for good
        for (let i = 0; i < 3; i++) panelLoss.note(event('s0'))
        for (let i = 0; i <= cap * 4; i++) internals.sessions.set(`s${i}`, ended(`s${i}`))
        internals.releaseEndedSessions()
        // s0 comes back: its whole history is read again, marked replayed
        for (let i = 0; i < 3; i++) panelLoss.note(event('s0', true))
        const figure = panelLoss.snapshotAfterReplay(() => {})?.evicted ?? {}
        assert.equal(figure.s0, 3, `3 distinct events, shown ${figure.s0}`)
      } finally { wiring.dispose(); watcher.dispose() }
    })
  })
}
