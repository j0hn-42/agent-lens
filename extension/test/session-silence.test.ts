/**
 * A silence is not an end (#360). Five minutes without a transcript write used to emit agent_complete
 * (`inactivity: true`) and the 'ended' lifecycle: the orchestrator and its subagents read "Done", the session
 * "completed", and "Session finished" was sent while `pnpm test` was still running or a permission was waiting.
 *
 * The session now stays in its last known state, open, however long it is silent: the clients tell the
 * silence apart from the event times (SILENT_AFTER_MS). Only an observed end (SessionEnd hook) closes it.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent, WatchedSession } from '../src/protocol'
import { ClaudeSessionPipeline } from '../src/claude-session-pipeline'
import { INACTIVITY_TIMEOUT_MS, ORCHESTRATOR_NAME } from '../src/constants'

const SESSION = '36036036-0360-4360-8360-360360360360'
const line = (o: unknown) => JSON.stringify(o) + '\n'

describe('ClaudeSessionPipeline: a silent session stays open (#360)', () => {
  let dir = ''
  let file = ''
  let events: AgentEvent[] = []
  let lifecycle: string[] = []
  let sessions: Map<string, WatchedSession>
  let pipeline: ClaudeSessionPipeline

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-silence-'))
    file = path.join(dir, `${SESSION}.jsonl`)
    fs.writeFileSync(file, line({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run the tests' } }))
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() })
    events = []
    lifecycle = []
    sessions = new Map()
    pipeline = new ClaudeSessionPipeline({
      sessions,
      submit: e => { events.push(e) },
      fireLifecycle: (type, sessionId) => { lifecycle.push(`${type}:${sessionId}`) },
      withHistory: load => load(),
    })
    const session = pipeline.newSession(SESSION, file)
    sessions.set(SESSION, session)
    pipeline.attach(session)
  })

  afterEach(() => {
    const session = sessions.get(SESSION)
    if (session) pipeline.release(session)
    mock.timers.reset()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const completions = () => events.filter(e => e.type === 'agent_complete')

  it('emits no agent_complete and no end after a long silence', () => {
    mock.timers.tick(INACTIVITY_TIMEOUT_MS * 3)
    assert.deepEqual(completions(), [], 'a silence never completes the orchestrator')
    assert.deepEqual(lifecycle.filter(l => l.startsWith('ended')), [], 'a silence never ends the session')
    assert.equal(sessions.get(SESSION)?.sessionCompleted, false)
  })

  it('an observed end (SessionEnd) closes the session once', () => {
    pipeline.observeSessionEnd(SESSION)
    pipeline.observeSessionEnd(SESSION)
    assert.deepEqual(lifecycle.filter(l => l.startsWith('ended')), [`ended:${SESSION}`])
    assert.equal(sessions.get(SESSION)?.sessionCompleted, true)
  })

  it('new transcript content after an observed end re-announces the orchestrator', () => {
    pipeline.observeSessionEnd(SESSION)
    events = []
    fs.appendFileSync(file, line({ type: 'user', uuid: 'u2', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Again' } }))
    pipeline.readNewLines(SESSION)
    assert.ok(events.some(e => e.type === 'agent_spawn' && e.payload.name === ORCHESTRATOR_NAME))
    assert.deepEqual(lifecycle.filter(l => l.startsWith('started')), [`started:${SESSION}`, `started:${SESSION}`])
    assert.equal(sessions.get(SESSION)?.sessionCompleted, false)
  })

  it('a hook event is activity: it refreshes the last activity time of an open session', () => {
    const before = sessions.get(SESSION)!.lastActivityTime
    mock.timers.tick(INACTIVITY_TIMEOUT_MS)
    pipeline.noteHookActivity(SESSION)
    assert.equal(sessions.get(SESSION)!.lastActivityTime, before + INACTIVITY_TIMEOUT_MS)
    assert.deepEqual(completions(), [])
  })

  it('a hook event after an observed end does not reopen the session', () => {
    pipeline.observeSessionEnd(SESSION)
    pipeline.noteHookActivity(SESSION)
    assert.equal(sessions.get(SESSION)?.sessionCompleted, true)
    assert.deepEqual(lifecycle.filter(l => l.startsWith('started')), [`started:${SESSION}`])
  })
})
