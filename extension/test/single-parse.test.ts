/**
 * A live transcript line is parsed once (#655). The pipeline used to JSON.parse each line again to
 * decide whether it was a conversation turn, and re-serialized `progress` lines to parse their inner
 * entry. The events emitted stay the same.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent, WatchedSession } from '../src/protocol'
import { ClaudeSessionPipeline } from '../src/claude-session-pipeline'

const SESSION = '65565565-5655-4655-8655-655655655655'
const MARK = 'single-parse-marker-655'
const jl = (o: unknown) => JSON.stringify(o) + '\n'

const user = { type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: `Hello ${MARK}` } }
const assistant = {
  type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_main', name: 'Read', input: { file_path: `/x/${MARK}` } }] },
}
const progress = {
  type: 'progress', parentToolUseID: 'toolu_parent', uuid: 'p1', timestamp: new Date().toISOString(),
  data: {
    type: 'agent_progress',
    message: {
      type: 'assistant', uuid: 'a2', timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Grep', input: { pattern: MARK } }] },
    },
  },
}
const metadata = { type: 'summary', summary: `meta ${MARK}` }

describe('live transcript lines are parsed once (#655)', () => {
  let dir = ''
  let file = ''
  let events: AgentEvent[] = []
  let sessions: Map<string, WatchedSession>
  let pipeline: ClaudeSessionPipeline
  let reopened: boolean[] = []
  const realParse = JSON.parse

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-single-parse-'))
    file = path.join(dir, `${SESSION}.jsonl`)
    fs.writeFileSync(file, '')
    events = []
    reopened = []
    sessions = new Map()
    pipeline = new ClaudeSessionPipeline({
      sessions,
      submit: e => { events.push(e) },
      fireLifecycle: () => {},
      withHistory: load => load(),
    })
    const session = pipeline.newSession(SESSION, file)
    sessions.set(SESSION, session)
    pipeline.attach(session)
    const orig = pipeline.resetInactivityTimer.bind(pipeline)
    pipeline.resetInactivityTimer = (id, reopen) => { reopened.push(reopen ?? true); orig(id, reopen) }
  })

  afterEach(() => {
    JSON.parse = realParse
    const session = sessions.get(SESSION)
    if (session) pipeline.release(session)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Number of JSON.parse calls whose text carries the marker, while reading the new lines. */
  function parsesWhileReading(entries: unknown[]): number {
    fs.appendFileSync(file, entries.map(jl).join(''))
    let count = 0
    JSON.parse = ((text: string, reviver?: (k: string, v: unknown) => unknown) => {
      if (typeof text === 'string' && text.includes(MARK)) count++
      return realParse(text, reviver)
    }) as typeof JSON.parse
    try { pipeline.readNewLines(SESSION) } finally { JSON.parse = realParse }
    return count
  }

  it('a user line, an assistant line and a metadata line each cost one parse', () => {
    assert.equal(parsesWhileReading([user]), 1)
    assert.equal(parsesWhileReading([assistant]), 1)
    assert.equal(parsesWhileReading([metadata]), 1)
  })

  it('a progress line costs one parse and still emits the inner tool call', () => {
    assert.equal(parsesWhileReading([progress]), 1)
    const inner = events.filter(e => e.type === 'tool_call_start' && e.payload.toolUseId === 'toolu_inner')
    assert.equal(inner.length, 1)
  })

  it('a conversation turn still reopens the session, metadata and progress do not', () => {
    parsesWhileReading([metadata, progress])
    assert.deepEqual(reopened, [false])
    parsesWhileReading([user])
    assert.deepEqual(reopened, [false, true])
  })
})
