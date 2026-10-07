/** agent_spawn carries the requested model and the subagent role, never as a runtime fact (#60, #63). */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { emitSubagentSpawn, type AgentEvent } from '../src/protocol'

function spawnPayload(extra?: Parameters<typeof emitSubagentSpawn>[5], spawnExtras?: Record<string, unknown>) {
  const events: AgentEvent[] = []
  emitSubagentSpawn({ emit: e => events.push(e), elapsed: () => 0 }, 'orchestrator', 'child', 'task', 's1', extra, spawnExtras)
  return events.find(e => e.type === 'agent_spawn')!.payload as Record<string, unknown>
}

describe('emitSubagentSpawn model provenance', () => {
  it('forwards the dispatch model as requestedModel, not as model', () => {
    const p = spawnPayload({ model: 'opus', subagentType: 'frontend-engineer' })
    assert.equal(p.requestedModel, 'opus')
    assert.equal(p.subagentType, 'frontend-engineer')
    assert.equal('model' in p, false)
    assert.equal('modelSource' in p, false)
  })

  it('adds nothing when the dispatch names no model or role', () => {
    const p = spawnPayload({ label: 'x' })
    assert.equal('requestedModel' in p, false)
    assert.equal('subagentType' in p, false)
  })

  it('lets the caller mark a team-config model as configured', () => {
    const p = spawnPayload({ model: 'opus' }, { model: 'claude-sonnet-4-6', modelSource: 'configured' })
    assert.equal(p.model, 'claude-sonnet-4-6')
    assert.equal(p.modelSource, 'configured')
    assert.equal(p.requestedModel, 'opus')
  })
})
