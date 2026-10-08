import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import { ORCHESTRATOR_NAME } from '../src/constants'
import { filterOrchestratorCompletion } from '../src/orchestrator-completion'

const ev = (type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent => ({ time: 1, type, payload, sessionId: 's1' })

describe('filterOrchestratorCompletion (#107)', () => {
  it('turns the orchestrator Stop into an idle flagged as the end of a turn', () => {
    const out = filterOrchestratorCompletion(ev('agent_complete', { name: ORCHESTRATOR_NAME }))!
    assert.equal(out.type, 'agent_idle')
    assert.equal(out.payload.turnEnd, true)
    assert.equal(out.payload.name, ORCHESTRATOR_NAME)
  })
  it('keeps a session end and a subagent completion as they are', () => {
    const end = ev('agent_complete', { name: ORCHESTRATOR_NAME, sessionEnd: true })
    assert.equal(filterOrchestratorCompletion(end), end)
    const sub = ev('agent_complete', { name: 'worker' })
    assert.equal(filterOrchestratorCompletion(sub), sub)
  })
  it('leaves other events untouched', () => {
    const e = ev('agent_idle', { name: ORCHESTRATOR_NAME })
    assert.equal(filterOrchestratorCompletion(e), e)
  })
})
