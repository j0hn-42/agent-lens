/**
 * Imported transcripts on the web side (#294, track 1): the provenance travels from the relay to the
 * session list, an imported session has its own status and group, and its agents never read as current.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  isSessionInfo, sanitizeSessionInfo, toSimulationEvent, IMPORTED_PROJECT_ID, IMPORTED_PROJECT_NAME, type SessionInfo,
} from '../web/lib/bridge-types'
import { sessionStatusKind, SESSION_STATUS_TEXT } from '../web/lib/chrome-utils'
import { SESSION_IMPORTED_TEXT, SESSION_IMPORTED_HELP } from '../web/lib/session-model'
import { deriveFreshness } from '../web/hooks/simulation/freshness'
import { processEventBatch, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, agentKeyOf } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'

const base: SessionInfo = { id: 'cloud-1', label: 'Cloud', status: 'completed', startTime: 1, lastActivityTime: 2 }

test('the bridge accepts the imported provenance and rejects a malformed one', () => {
  assert.ok(isSessionInfo({ ...base, imported: true, importedAt: 1_700_000_000_000 }))
  assert.ok(!isSessionInfo({ ...base, imported: 'yes' }))
  assert.ok(!isSessionInfo({ ...base, imported: true, importedAt: 'now' }))
})

test('an imported session is grouped under its own heading, never under a local project', () => {
  const s = sanitizeSessionInfo({ ...base, imported: true, projectId: 'abc123', projectName: 'local-repo' })
  assert.equal(s.projectId, IMPORTED_PROJECT_ID)
  assert.equal(s.projectName, IMPORTED_PROJECT_NAME)
  const live = sanitizeSessionInfo({ ...base, projectId: 'abc123', projectName: 'local-repo' })
  assert.equal(live.projectId, 'abc123')
  // The pseudo project cannot be claimed by a session that is not imported
  const forged = sanitizeSessionInfo({ ...base, projectId: IMPORTED_PROJECT_ID, projectName: 'x' })
  assert.equal(forged.projectId, undefined)
})

test('the status of an imported session says it is imported, whatever its events', () => {
  const imported = { ...base, imported: true }
  assert.equal(sessionStatusKind(imported, false, true, () => true), 'imported')
  assert.equal(sessionStatusKind(imported, true, false, () => true), 'imported', 'its history replay is not new activity')
  assert.equal(sessionStatusKind({ ...imported, status: 'active' }, false, true, () => true), 'imported', 'never active')
  assert.equal(SESSION_STATUS_TEXT.imported, SESSION_IMPORTED_TEXT)
  assert.match(SESSION_IMPORTED_TEXT, /imported/)
  assert.match(SESSION_IMPORTED_HELP, /not live|still running/i)
})

test('a relay event carrying the imported provenance becomes an imported, replayed simulation event', () => {
  const e = toSimulationEvent({ time: 1, type: 'agent_spawn', payload: { name: 'orchestrator' }, sessionId: 's', imported: true })
  assert.equal(e.imported, true)
  assert.equal(e.replayed, true, 'an imported event carries no wall-clock proof of work')
  const live = toSimulationEvent({ time: 1, type: 'agent_spawn', payload: { name: 'orchestrator' }, sessionId: 's' })
  assert.equal(live.imported, undefined)
  assert.equal(live.replayed, undefined)
})

test('an imported status is never fresh: it is at best the last known state', () => {
  const now = 1_000_000
  assert.equal(deriveFreshness({ state: 'tool_calling', lastEventAt: now, freshnessSource: 'imported' }, now), 'stale')
  assert.equal(deriveFreshness({ state: 'idle', lastEventAt: now, freshnessSource: 'imported' }, now), 'stale')
  assert.equal(deriveFreshness({ state: 'complete', lastEventAt: now, freshnessSource: 'imported' }, now), 'closed')
  assert.equal(deriveFreshness({ state: 'error', lastEventAt: now, freshnessSource: 'imported' }, now), 'error')
})

test('agents touched by an imported event are stamped with the imported source', () => {
  const ctx: ProcessEventContext = {
    syncForceSimulation: () => {}, findToolSlot: () => ({ x: 0, y: 0 }), getContextWindowSize: () => 200_000,
    blockIdCounter: { current: 0 }, skipForceSync: true,
  }
  const events: SimulationEvent[] = [
    { time: 1, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true }, sessionId: 'cloud', replayed: true, imported: true },
    { time: 2, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Bash', args: 'pnpm test' }, sessionId: 'cloud', replayed: true, imported: true },
  ]
  const { state } = processEventBatch(events, createEmptyState(), ctx, { advanceClock: true, receivedAt: 5000 })
  const agent = state.agents.get(agentKeyOf('cloud', 'orchestrator'))!
  assert.equal(agent.freshnessSource, 'imported')
  assert.equal(deriveFreshness(agent, 5000), 'stale', 'the recorded tool call is not shown as running now')
})
