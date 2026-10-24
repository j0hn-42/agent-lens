/**
 * Attaching a big session never blocks the event loop (#651). The history of the lead transcript is read in
 * slices that give the loop back (setImmediate) every PRESCAN_CHUNK_BYTES or PRESCAN_SLICE_MS, attaches are
 * queued (one session per tick), and a subagent file not written for ACTIVE_SESSION_AGE_S is read only by its
 * end, as a teammate's, without losing a tool call written after the attach. Only the attaching session's
 * events are held meanwhile; the other sessions keep flowing.
 */
import './helpers/alias-vscode'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent, WatchedSession } from '../src/protocol'
import { ClaudeSessionPipeline, type ClaudeSessionHost } from '../src/claude-session-pipeline'
import { EventReconciler } from '../src/event-source-priority'
import { readSubagentNewLines } from '../src/subagent-watcher'
import { PRESCAN_CHUNK_BYTES, PRESCAN_SLICE_MS } from '../src/fs-utils'
import { ACTIVE_SESSION_AGE_S, TEAMMATE_REPLAY_MAX_BYTES } from '../src/constants'

const S1 = '65100000-0000-4000-8000-000000000001'
const S2 = '65100000-0000-4000-8000-000000000002'
const jl = (o: unknown) => JSON.stringify(o) + '\n'
const pad = 'x'.repeat(2000)
const call = (id: string, name = 'Read') => jl({ type: 'assistant', uuid: `a-${id}`, message: { role: 'assistant', content: [{ type: 'text', text: pad }, { type: 'tool_use', id, name, input: { file_path: `/src/${id}.ts` } }] } })
const result = (id: string) => jl({ type: 'user', uuid: `u-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: pad }] } })
const prompt = (text: string) => jl({ type: 'user', uuid: `p-${text}`, message: { role: 'user', content: text } })

/** `bytes` of answered tool calls, ids `<prefix>-<n>` */
function history(bytes: number, prefix: string): string {
  const out: string[] = []
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const pair = call(`${prefix}-${i}`) + result(`${prefix}-${i}`)
    out.push(pair)
    size += pair.length
  }
  return out.join('')
}

/** Counts the turns of the event loop (one setImmediate per turn) while it runs */
function loopTurns() {
  let turns = 0
  let on = true
  const spin = () => { if (!on) return; turns++; setImmediate(spin) }
  setImmediate(spin)
  return { get turns() { return turns }, stop() { on = false } }
}

interface Rig {
  dir: string
  sessions: Map<string, WatchedSession>
  pipeline: ClaudeSessionPipeline
  reconciler: EventReconciler
  delivered: AgentEvent[]
  lifecycle: Array<{ type: string; sessionId: string; turn: number }>
  turns: ReturnType<typeof loopTurns> | null
  transcript(sessionId: string, content: string): string
  session(sessionId: string): WatchedSession
}

function rig(): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-async-attach-'))
  const sessions = new Map<string, WatchedSession>()
  const delivered: AgentEvent[] = []
  const reconciler = new EventReconciler({ deliver: e => { delivered.push(e) } })
  const r: Rig = {
    dir, sessions, reconciler, delivered, lifecycle: [], turns: null,
    pipeline: undefined as unknown as ClaudeSessionPipeline,
    transcript(sessionId, content) {
      const file = path.join(dir, `${sessionId}.jsonl`)
      fs.writeFileSync(file, content)
      return file
    },
    session(sessionId) {
      const s = r.pipeline.newSession(sessionId, path.join(dir, `${sessionId}.jsonl`))
      sessions.set(sessionId, s)
      return s
    },
  }
  const host: ClaudeSessionHost = {
    sessions,
    submit: e => reconciler.submit(e, { source: 'jsonl' }),
    fireLifecycle: (type, sessionId) => { r.lifecycle.push({ type, sessionId, turn: r.turns?.turns ?? -1 }) },
    withHistory: load => reconciler.withHistory(load),
    withSessionHistory: (sessionId, load) => reconciler.withSessionHistory(sessionId, load),
  }
  r.pipeline = new ClaudeSessionPipeline(host)
  return r
}

describe('attaching a big session gives the event loop back (#651)', () => {
  let r: Rig | null = null
  afterEach(() => {
    if (!r) return
    r.turns?.stop()
    for (const s of r.sessions.values()) r.pipeline.release(s)
    fs.rmSync(r.dir, { recursive: true, force: true })
    r = null
  })

  it('the lead history is read in slices: the loop turns at least once per PRESCAN_CHUNK_BYTES', async () => {
    r = rig()
    const size = 3 * PRESCAN_CHUNK_BYTES + 1024
    r.transcript(S1, prompt('Audit') + history(size, 'm'))
    const session = r.session(S1)
    const turns = loopTurns()
    r.turns = turns
    await r.pipeline.attach(session)
    turns.stop()
    assert.ok(turns.turns >= 3, `the loop turned ${turns.turns} times while ~${Math.round(size / 1048576)} MB were read`)
    assert.ok(session.seenToolUseIds.has('m-0'), 'the whole history is still read for dedup')
    assert.equal(session.fileSize, fs.statSync(session.filePath).size, 'the tail starts at the end of what was read')
    assert.equal(session.pendingToolCalls.size, 0, 'every call of the history is answered')
  })

  it('the longest block of the loop during an attach stays far below the 1 s the synchronous read took', async () => {
    r = rig()
    r.transcript(S1, prompt('Audit') + history(4 * PRESCAN_CHUNK_BYTES, 'm'))
    const session = r.session(S1)
    let last = performance.now()
    let longest = 0
    const probe = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now }, 1)
    last = performance.now()
    await r.pipeline.attach(session)
    clearInterval(probe)
    // The target is < 50 ms (measured in the PR); the bound here leaves room for a loaded CI machine
    assert.ok(longest < 20 * PRESCAN_SLICE_MS, `longest block ${Math.round(longest)} ms`)
  })

  it('attaches are queued: nothing is read in the caller tick, one session per turn of the loop', async () => {
    r = rig()
    r.transcript(S1, prompt('First') + history(64 * 1024, 'a'))
    r.transcript(S2, prompt('Second') + history(64 * 1024, 'b'))
    const s1 = r.session(S1)
    const s2 = r.session(S2)
    r.turns = loopTurns()
    const p1 = r.pipeline.attach(s1)
    const p2 = r.pipeline.attach(s2)
    assert.deepEqual(r.lifecycle, [], 'nothing announced synchronously')
    assert.equal(s1.seenToolUseIds.size + s2.seenToolUseIds.size, 0, 'nothing read synchronously')
    await Promise.all([p1, p2])
    const started = r.lifecycle.filter(l => l.type === 'started')
    assert.deepEqual(started.map(l => l.sessionId), [S1, S2], 'in the order asked')
    assert.ok(started[1].turn > started[0].turn, 'the second attach runs in a later turn of the loop')
  })

  it('only the attaching session is held: another session keeps flowing, the held live event follows the history', async () => {
    r = rig()
    r.transcript(S1, prompt('Audit') + history(2 * PRESCAN_CHUNK_BYTES, 'm'))
    const session = r.session(S1)
    const attached = r.pipeline.attach(session)
    // Wait until the attach is under way (the first slice was read)
    while (session.seenToolUseIds.size === 0) await new Promise(res => setImmediate(res))
    r.reconciler.submit({ time: 1, type: 'agent_idle', payload: { name: 'orchestrator' }, sessionId: S2 }, { source: 'hook' })
    r.reconciler.submit({ time: 1, type: 'agent_idle', payload: { name: 'orchestrator' }, sessionId: S1 }, { source: 'hook' })
    assert.deepEqual(r.delivered.map(e => e.sessionId), [S2], 'the other session is delivered at once')
    await attached
    const ofS1 = r.delivered.filter(e => e.sessionId === S1).map(e => e.type)
    assert.equal(ofS1[0], 'agent_spawn', 'the history of S1 comes first')
    assert.ok(ofS1.includes('agent_idle'), 'the held live event is delivered after it')
  })

  it('a session released while it attaches is dropped: never announced, no watcher, nothing delivered', async () => {
    r = rig()
    r.transcript(S1, prompt('Audit') + history(3 * PRESCAN_CHUNK_BYTES, 'm'))
    const session = r.session(S1)
    const attached = r.pipeline.attach(session)
    while (session.seenToolUseIds.size === 0) await new Promise(res => setImmediate(res))
    r.pipeline.release(session)
    r.sessions.delete(S1)
    r.reconciler.forgetSession(S1)
    await attached
    assert.deepEqual(r.lifecycle, [], 'not announced')
    assert.equal(session.fileWatcher, null)
    assert.equal(session.pollTimer, null)
    assert.deepEqual(r.delivered, [], 'nothing of a dropped session is delivered')
  })

  it('lines written while the history is read are read right after the attach, once', async () => {
    r = rig()
    r.transcript(S1, prompt('Audit') + history(2 * PRESCAN_CHUNK_BYTES, 'm'))
    const session = r.session(S1)
    const attached = r.pipeline.attach(session)
    while (session.seenToolUseIds.size === 0) await new Promise(res => setImmediate(res))
    fs.appendFileSync(session.filePath, call('late', 'Bash'))
    // A watcher or poll callback arriving mid-attach reads nothing (the history owns the position)
    r.pipeline.readNewLines(S1)
    await attached
    const starts = r.delivered.filter(e => e.type === 'tool_call_start' && e.payload.toolUseId === 'late')
    assert.equal(starts.length, 1, 'the call written during the attach is emitted once')
  })
})

describe('an idle subagent is read only by its end at attach (#651)', () => {
  let r: Rig | null = null
  afterEach(() => {
    if (!r) return
    for (const s of r.sessions.values()) r.pipeline.release(s)
    fs.rmSync(r.dir, { recursive: true, force: true })
    r = null
  })

  function subagent(dir: string, agentId: string, content: string, mtimeMs: number): string {
    const subDir = path.join(dir, S1, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const file = path.join(subDir, `agent-${agentId}.jsonl`)
    fs.writeFileSync(file, content)
    fs.writeFileSync(path.join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: `Sub ${agentId}` }))
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
    return file
  }

  it('idle: only the last TEAMMATE_REPLAY_MAX_BYTES are read; a call completed after the attach is not lost', async () => {
    r = rig()
    r.transcript(S1, prompt('Audit'))
    const old = Date.now() - (ACTIVE_SESSION_AGE_S + 60) * 1000
    const head = call('head-0') + result('head-0') + history(TEAMMATE_REPLAY_MAX_BYTES + 64 * 1024, 'h')
    const tail = call('tail-0') + result('tail-0')
    // The last line is still being written: its first half only
    const late = call('late-0', 'Bash')
    const file = subagent(r.dir, 'a0000000000000001', head + tail + late.slice(0, 40), old)
    const session = r.session(S1)
    await r.pipeline.attach(session)
    const state = session.subagentWatchers.get(file)!
    assert.ok(state, 'the idle subagent is tracked')
    assert.ok(state.seenToolUseIds.has('tail-0'), 'its end is read')
    assert.ok(!state.seenToolUseIds.has('head-0'), 'its head is not read')
    assert.equal(state.fileSize, Buffer.byteLength(head + tail), 'the position is the end of its last complete line')
    fs.appendFileSync(file, late.slice(40) + call('next-0', 'Grep'))
    readSubagentNewLines(r.pipeline.delegate, r.pipeline.parser, file, S1)
    const ids = r.delivered.filter(e => e.type === 'tool_call_start').map(e => e.payload.toolUseId)
    assert.ok(ids.includes('late-0'), 'the line unfinished at attach is emitted once complete')
    assert.ok(ids.includes('next-0'), 'a later call is emitted')
    assert.ok(!ids.includes('head-0') && !ids.includes('tail-0'), 'the history is never re-emitted')
  })

  it('active (written within ACTIVE_SESSION_AGE_S): read in full, as before', async () => {
    r = rig()
    r.transcript(S1, prompt('Audit'))
    const head = call('head-0') + result('head-0') + history(TEAMMATE_REPLAY_MAX_BYTES + 64 * 1024, 'h')
    const file = subagent(r.dir, 'a0000000000000002', head + call('tail-0') + result('tail-0'), Date.now() - 1000)
    const session = r.session(S1)
    await r.pipeline.attach(session)
    const state = session.subagentWatchers.get(file)!
    assert.ok(state.seenToolUseIds.has('head-0') && state.seenToolUseIds.has('tail-0'))
    assert.equal(state.fileSize, fs.statSync(file).size)
  })
})
