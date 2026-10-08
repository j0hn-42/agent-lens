import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildObservations, AgentStateTracker, parseObservationsInput, safeAgentName, createObservationsAction, OBSERVATIONS_ACTION,
} from '../src/observations'
import type { AgentEvent, SessionInfo } from '../src/protocol'
import {
  OBSERVATIONS_MAX_SESSIONS, OBSERVATIONS_MAX_AGENTS_PER_SESSION, OBSERVATIONS_NAME_MAX, SNAPSHOT_STALE_AFTER_MS,
} from '../src/constants'

const NOW = 1_700_000_000_000
function session(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return { id, label: 'SECRET PROMPT TEXT', status: 'active', startTime: NOW - 60_000, lastActivityTime: NOW - 1000,
    runtime: 'claude', workspace: '/home/me/secret-project', cwd: '/home/me/secret-project/sub', teamName: 'team-x', memberName: 'm', ...over }
}
function ev(type: AgentEvent['type'], payload: Record<string, unknown>, sessionId = 's1'): AgentEvent {
  return { time: 1, type, payload, sessionId }
}

function tracker(events: ReadonlyMap<string, readonly AgentEvent[]> = new Map()): AgentStateTracker {
  const t = new AgentStateTracker()
  for (const list of events.values()) for (const e of list) t.ingest(e)
  return t
}
const obs = (t: AgentStateTracker, id = 's1') => buildObservations({ sessions: [session(id)], agents: t }, {}, NOW).sessions[0]

describe('buildObservations whitelist', () => {
  it('never carries prompts, labels, paths, cwd, workspace or team tags', () => {
    const events = new Map([['s1', [
      ev('agent_spawn', { name: 'explorer', prompt: 'SECRET PROMPT TEXT', task: '/home/me/x' }),
      ev('message', { content: 'SECRET MESSAGE', role: 'user' }),
      ev('tool_call_start', { tool: 'Read', args: '/home/me/secret-project/.env' }),
    ]]])
    const out = buildObservations({ sessions: [session('s1')], agents: tracker(events) }, {}, NOW)
    const text = JSON.stringify(out)
    for (const leak of ['SECRET', '/home/me', 'secret-project', 'team-x', 'label', 'cwd', 'workspace']) {
      assert.ok(!text.includes(leak), `leaked ${leak}`)
    }
    assert.deepEqual(Object.keys(out.sessions[0]).sort(), ['agentCount', 'agents', 'ageMs', 'freshness', 'id', 'lastActivityAt', 'runtime', 'startedAt', 'status'].sort())
  })

  it('derives freshness from the last activity, closed for completed sessions', () => {
    const mk = (age: number, status: SessionInfo['status'] = 'active') =>
      buildObservations({ sessions: [session('a', { lastActivityTime: NOW - age, status })], agents: tracker() }, {}, NOW).sessions[0]
    assert.equal(mk(SNAPSHOT_STALE_AFTER_MS).freshness, 'fresh')
    assert.equal(mk(SNAPSHOT_STALE_AFTER_MS + 1).freshness, 'stale')
    assert.equal(mk(0, 'completed').freshness, 'closed')
    assert.equal(mk(-5000).ageMs, 0)
  })

  it('derives agent states from spawn / idle / complete and ignores unknown agents', () => {
    const events = new Map([['s1', [
      ev('agent_spawn', { name: 'main' }), ev('agent_spawn', { name: 'sub' }),
      ev('agent_idle', { agent: 'main' }), ev('agent_complete', { agent: 'sub' }), ev('agent_complete', { agent: 'ghost' }),
    ]]])
    const s = buildObservations({ sessions: [session('s1')], agents: tracker(events) }, {}, NOW).sessions[0]
    assert.deepEqual(s.agents, [{ name: 'main', state: 'idle' }, { name: 'sub', state: 'complete' }])
    assert.equal(s.agentCount, 2)
  })

  it('omits agents on request but keeps the count', () => {
    const events = new Map([['s1', [ev('agent_spawn', { name: 'main' })]]])
    const s = buildObservations({ sessions: [session('s1')], agents: tracker(events) }, { includeAgents: false }, NOW).sessions[0]
    assert.equal(s.agents, undefined)
    assert.equal(s.agentCount, 1)
  })

  it('caps sessions and agents and says so; keeps the most recent sessions', () => {
    const sessions = Array.from({ length: OBSERVATIONS_MAX_SESSIONS + 3 }, (_, i) => session(`s${i}`, { lastActivityTime: NOW - i * 10 }))
    const agentsEv = Array.from({ length: OBSERVATIONS_MAX_AGENTS_PER_SESSION + 5 }, (_, i) => ev('agent_spawn', { name: `a${i}` }, 's0'))
    const out = buildObservations({ sessions, agents: tracker(new Map([['s0', agentsEv]])) }, {}, NOW)
    assert.equal(out.sessions.length, OBSERVATIONS_MAX_SESSIONS)
    assert.equal(out.truncated, true)
    assert.equal(out.sessions[0].id, 's0')
    assert.equal(out.sessions[0].agents?.length, OBSERVATIONS_MAX_AGENTS_PER_SESSION)
    assert.equal(out.sessions[0].agentsTruncated, true)
    assert.equal(out.sessions[0].agentCount, OBSERVATIONS_MAX_AGENTS_PER_SESSION + 5)
  })

  it('skips sessions with a non-identifier id and counts them', () => {
    const out = buildObservations({ sessions: [session('ok'), session('../etc/passwd'), session('has space')], agents: tracker() }, {}, NOW)
    assert.deepEqual(out.sessions.map(s => s.id), ['ok'])
    assert.equal(out.omittedSessions, 2)
  })

  it('filters on one session and maps an unknown runtime', () => {
    const out = buildObservations({ sessions: [session('a', { runtime: 'weird' }), session('b')], agents: tracker() }, { session: 'a' }, NOW)
    assert.deepEqual(out.sessions.map(s => [s.id, s.runtime]), [['a', 'unknown']])
  })

  it('an empty relay yields an empty, valid answer', () => {
    assert.deepEqual(buildObservations({ sessions: [], agents: tracker() }, {}, NOW),
      { schema: 1, generatedAt: NOW, sessions: [], truncated: false, omittedSessions: 0 })
  })
})

describe('safeAgentName', () => {
  it('drops paths, controls and overlong names', () => {
    assert.equal(safeAgentName('/home/me/x'), 'agent')
    assert.equal(safeAgentName('C:\\Users\\me'), 'agent')
    assert.equal(safeAgentName('~/secret'), 'agent')
    assert.equal(safeAgentName(undefined), 'agent')
    assert.equal(safeAgentName('  \u0007 '), 'agent')
    assert.equal(safeAgentName('a\nb'), 'a b')
    assert.equal(safeAgentName('x'.repeat(500)).length, OBSERVATIONS_NAME_MAX)
  })
})

describe('parseObservationsInput (strict)', () => {
  it('accepts nothing, empty and valid input', () => {
    assert.deepEqual(parseObservationsInput(undefined), { ok: true, input: {} })
    assert.deepEqual(parseObservationsInput({ session: 'abc-1', includeAgents: false }), { ok: true, input: { session: 'abc-1', includeAgents: false } })
  })
  it('rejects unknown keys, wrong types and hostile ids', () => {
    for (const bad of [[], 'x', { other: 1 }, { session: 5 }, { session: '../x' }, { includeAgents: 'yes' }]) {
      assert.equal(parseObservationsInput(bad).ok, false, JSON.stringify(bad))
    }
  })
})

describe('createObservationsAction', () => {
  it('exposes a typed definition with JSON schemas', () => {
    const a = createObservationsAction(() => ({ sessions: [], agents: tracker() }))
    assert.equal(a.definition, OBSERVATIONS_ACTION)
    assert.equal(a.definition.name, 'observations')
    assert.equal(a.definition.inputSchema.type, 'object')
    assert.equal(a.definition.outputSchema.type, 'object')
  })
  it('answers, rejects bad input and survives a failing source', () => {
    const ok = createObservationsAction(() => ({ sessions: [session('s1')], agents: tracker() }), () => NOW)
    const r = ok.run({})
    assert.ok(r.ok && r.result.sessions.length === 1)
    assert.equal(ok.run({ nope: 1 }).ok, false)
    const boom = createObservationsAction(() => { throw new Error('boom /home/me') })
    assert.deepEqual(boom.run(), { ok: false, error: 'observations unavailable' })
  })
  it('dispose is idempotent and ends answers', () => {
    const a = createObservationsAction(() => ({ sessions: [], agents: tracker() }))
    a.dispose(); a.dispose()
    assert.equal(a.disposed, true)
    assert.equal(a.run().ok, false)
  })
})

describe('AgentStateTracker', () => {
  it('follows the explicit activity of agent_activity (teammates never get agent_complete)', () => {
    const spawn = ev('agent_spawn', { name: 'alice', kind: 'teammate' })
    const state = (...rest: ReturnType<typeof ev>[]) => obs(tracker(new Map([['s1', [spawn, ...rest]]]))).agents
    assert.deepEqual(state(ev('agent_activity', { name: 'alice', activity: 'idle' })), [{ name: 'alice', state: 'idle' }])
    assert.deepEqual(state(ev('agent_activity', { name: 'alice', activity: 'done' })), [{ name: 'alice', state: 'complete' }])
    assert.deepEqual(state(ev('agent_activity', { name: 'alice', activity: 'idle' }), ev('agent_activity', { name: 'alice', activity: 'working' })), [{ name: 'alice', state: 'active' }])
    // idle on an already idle agent stays idle (no revival), unknown activity or agent changes nothing
    assert.deepEqual(state(ev('agent_activity', { name: 'alice', activity: 'idle' }), ev('agent_activity', { name: 'alice', activity: 'idle' })), [{ name: 'alice', state: 'idle' }])
    assert.deepEqual(state(ev('agent_activity', { name: 'alice', activity: 'weird' }), ev('agent_activity', { name: 'bob', activity: 'done' })), [{ name: 'alice', state: 'active' }])
  })

  it('an idle agent that works again is active again', () => {
    for (const type of ['tool_call_start', 'tool_call_end', 'message'] as const) {
      const t = tracker(new Map([['s1', [ev('agent_spawn', { name: 'main' }), ev('agent_idle', { name: 'main' }), ev(type, { agent: 'main' })]]]))
      assert.deepEqual(obs(t).agents, [{ name: 'main', state: 'active' }], type)
    }
    const stillIdle = tracker(new Map([['s1', [ev('agent_spawn', { name: 'main' }), ev('agent_idle', { name: 'main' }), ev('message', { agent: 'other' })]]]))
    assert.deepEqual(obs(stillIdle).agents, [{ name: 'main', state: 'idle' }])
  })

  it('a completed agent stays complete on late activity', () => {
    const t = tracker(new Map([['s1', [ev('agent_spawn', { name: 'sub' }), ev('agent_complete', { name: 'sub' }), ev('tool_call_end', { agent: 'sub' })]]]))
    assert.deepEqual(obs(t).agents, [{ name: 'sub', state: 'complete' }])
  })

  it('keeps path-like names apart: one entry per real agent, unique display names', () => {
    const t = tracker(new Map([['s1', [
      ev('agent_spawn', { name: 'Update src/a.ts' }), ev('agent_spawn', { name: 'Update src/b.ts' }),
      ev('agent_complete', { name: 'Update src/a.ts' }),
    ]]]))
    const s = obs(t)
    assert.equal(s.agentCount, 2)
    assert.deepEqual(s.agents, [{ name: 'agent', state: 'complete' }, { name: 'agent#2', state: 'active' }])
    assert.ok(!JSON.stringify(s).includes('src/'))
  })

  it('keeps names that only differ after the display cap apart', () => {
    const long = 'x'.repeat(OBSERVATIONS_NAME_MAX + 10)
    const t = tracker(new Map([['s1', [ev('agent_spawn', { name: long + 'A' }), ev('agent_spawn', { name: long + 'B' })]]]))
    const s = obs(t)
    assert.equal(s.agentCount, 2)
    assert.equal(new Set(s.agents?.map(a => a.name)).size, 2)
    assert.ok(s.agents?.every(a => a.name.length <= OBSERVATIONS_NAME_MAX))
  })

  it('does not depend on a replay buffer: states survive a flood of other events', () => {
    const t = new AgentStateTracker()
    t.ingest(ev('agent_spawn', { name: 'early' }))
    t.ingest(ev('agent_complete', { name: 'early' }))
    for (let i = 0; i < 20_000; i++) t.ingest(ev('tool_call_start', { agent: 'main' }))
    assert.deepEqual(obs(t).agents, [{ name: 'early', state: 'complete' }])
    assert.equal(obs(t).agentsIncomplete, undefined)
  })

  it('flags the list as incomplete when the tracker drops agents or whole sessions', () => {
    const many = new AgentStateTracker()
    for (let i = 0; i < 600; i++) many.ingest(ev('agent_spawn', { name: `a${i}` }))
    assert.equal(obs(many).agentsIncomplete, true)

    const sessions = new AgentStateTracker()
    for (let i = 0; i < 250; i++) sessions.ingest(ev('agent_spawn', { name: 'main' }, `x${i}`))
    const old = obs(sessions, 'x0')
    assert.equal(old.agentCount, 0)
    assert.equal(old.agentsIncomplete, true)
    assert.equal(obs(sessions, 'x249').agentsIncomplete, undefined)
  })
})
