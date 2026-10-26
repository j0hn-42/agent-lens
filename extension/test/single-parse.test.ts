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
import { completeSessionHeader } from '../src/team-watcher'
import { NORM_MAX_LINE_CHARS } from '../src/constants'

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

  beforeEach(async () => {
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
    // The attach runs over several ticks (#651): the live lines are read once it has ended
    await pipeline.attach(session)
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

  it('a user or assistant line over NORM_MAX_LINE_CHARS is dropped unparsed and does not reopen the session (#613)', () => {
    const huge = { ...user, message: { role: 'user', content: `${MARK} ${'x'.repeat(NORM_MAX_LINE_CHARS)}` } }
    assert.equal(parsesWhileReading([huge]), 0, 'not parsed at all')
    assert.deepEqual(reopened, [false], 'its type is unknown, so it is no conversation turn')
    assert.equal(events.filter(e => JSON.stringify(e).includes(MARK)).length, 0, 'and nothing is emitted from it')
  })
})

/**
 * The hosts read the same lines through onTranscriptLines: completeSessionHeader parses again, as long as the cwd of
 * the session is unknown, the lines that name a cwd. "One parse per line" holds once the cwd is learnt (#613).
 */
describe('the host hook onTranscriptLines and the parse count (#655, #613)', () => {
  let dir = ''
  const realParse = JSON.parse
  afterEach(() => { JSON.parse = realParse; fs.rmSync(dir, { recursive: true, force: true }) })

  it('a line without cwd costs one parse; the line that teaches the cwd costs two; once learnt, one again', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-single-parse-host-'))
    const file = path.join(dir, `${SESSION}.jsonl`)
    fs.writeFileSync(file, '')
    const sessions = new Map<string, WatchedSession>()
    const cwd = new Map<string, string>()
    const branch = new Map<string, string>()
    const pipeline = new ClaudeSessionPipeline({
      sessions,
      submit: () => {},
      fireLifecycle: () => {},
      withHistory: load => load(),
      onTranscriptLines: (id, lines) => { completeSessionHeader(id, lines, cwd, branch) },
    })
    const session = pipeline.newSession(SESSION, file)
    sessions.set(SESSION, session)
    await pipeline.attach(session)
    const parses = (entries: unknown[]): number => {
      fs.appendFileSync(file, entries.map(jl).join(''))
      let count = 0
      JSON.parse = ((text: string, reviver?: (k: string, v: unknown) => unknown) => {
        if (typeof text === 'string' && text.includes(MARK)) count++
        return realParse(text, reviver)
      }) as typeof JSON.parse
      try { pipeline.readNewLines(SESSION) } finally { JSON.parse = realParse }
      return count
    }
    try {
      assert.equal(parses([metadata]), 1, 'no cwd in the line: one parse')
      assert.equal(parses([{ ...user, cwd: `/work/${MARK}` }]), 2, 'the line naming the cwd is parsed again by the host')
      assert.equal(cwd.get(SESSION), `/work/${MARK}`)
      assert.equal(parses([{ ...assistant, cwd: `/work/${MARK}` }]), 1, 'cwd known: one parse per line again')
    } finally { pipeline.release(session) }
  })
})
