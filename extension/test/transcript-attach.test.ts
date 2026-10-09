/**
 * Attaching to a transcript that is being written (#204, #212, #223): the initial read stops at the
 * stat size, keeps an unfinished last line for the next read, and never adds tool_use ids it has not
 * accounted for. A tool_use whose input is not an object is read the same way live and at catch-up.
 */
import './helpers/alias-vscode'
import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { readTrackedLines, PRESCAN_CHUNK_BYTES } from '../src/fs-utils'
import { scanSubagentsDir, readSubagentNewLines } from '../src/subagent-watcher'
import { JsonlEventSource } from '../src/event-source'
import { POLL_FALLBACK_MS } from '../src/constants'
import type { AgentEvent } from '../src/protocol'
import {
  tmpDir, makeSession, makeHarness, ofType, userText, assistantText, assistantToolUse, toolResult, writeTeammate,
} from './helpers/teams-fixtures'

const jl = (o: unknown) => JSON.stringify(o) + '\n'

/** Split a JSON line in two: the head written before attaching, the rest written after. */
function split(entry: unknown): [string, string] {
  const full = jl(entry)
  const cut = Math.floor(full.length / 2)
  return [full.slice(0, cut), full.slice(cut)]
}

const toolStarts = (events: AgentEvent[], id: string) =>
  ofType(events, 'tool_call_start').filter(e => e.payload.toolUseId === id)
const toolEnds = (events: AgentEvent[], id: string) =>
  ofType(events, 'tool_call_end').filter(e => e.payload.toolUseId === id)

describe('attaching while the last line is still being written (#204)', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('main session: the unfinished line is emitted exactly once after it is completed', () => {
    dir = tmpDir()
    const file = path.join(dir, 'lead.jsonl')
    const [head, rest] = split(assistantToolUse('lead-t1', 'Bash', { command: 'make' }))
    fs.writeFileSync(file, jl(userText('go')) + head)
    const session = makeSession({ sessionId: 's1', filePath: file })
    const h = makeHarness(session)

    h.parser.prescanExistingContent(file, fs.statSync(file).size, session)
    assert.equal(session.seenToolUseIds.has('lead-t1'), false, 'the fragment is not parsed')

    fs.appendFileSync(file, rest + jl(toolResult('lead-t1')))
    const lines = readTrackedLines(file, session) ?? []
    for (const line of lines) {
      h.parser.processTranscriptLine(line, 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1', session.seenMessageHashes)
    }
    assert.equal(toolStarts(h.events, 'lead-t1').length, 1)
    assert.equal(toolEnds(h.events, 'lead-t1').length, 1)
    assert.equal(h.parser.getNormalizer('s1').stats.malformed, 0)
  })

  it('subagent: the unfinished line is emitted exactly once after it is completed', () => {
    dir = tmpDir()
    const [head, rest] = split(assistantToolUse('sub-t1', 'Bash', { command: 'ls' }))
    const file = writeTeammate(dir, { agentId: 'part0001', meta: null, entries: [userText('go')] })
    fs.appendFileSync(file, head)
    const session = makeSession({ subagentsDir: dir })
    const h = makeHarness(session)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    h.closeWatchers()

    fs.appendFileSync(file, rest + jl(toolResult('sub-t1')))
    readSubagentNewLines(h.delegate, h.parser, file, 's1')
    assert.equal(toolStarts(h.events, 'sub-t1').length, 1)
    assert.equal(toolEnds(h.events, 'sub-t1').length, 1)
    assert.equal(h.parser.getNormalizer('s1').stats.malformed, 0)
  })

  it('JsonlEventSource: the unfinished event is emitted exactly once after it is completed', () => {
    dir = tmpDir()
    const file = path.join(dir, 'events.jsonl')
    const ev = (n: number) => ({ type: 'message', time: n, payload: {} })
    const [head, rest] = split(ev(2))
    fs.writeFileSync(file, jl(ev(1)) + head)
    const watch = mock.method(require('node:fs'), 'watch', () => { throw Object.assign(new Error('limit'), { code: 'ENOSPC' }) })
    mock.timers.enable({ apis: ['setInterval'] })
    const src = new JsonlEventSource(file)
    try {
      const got: AgentEvent[] = []
      src.onEvent(e => got.push(e))
      src.start()
      fs.appendFileSync(file, rest + jl(ev(3)))
      mock.timers.tick(POLL_FALLBACK_MS)
      assert.deepEqual(got.map(e => e.time), [1, 2, 3])
    } finally {
      src.dispose()
      mock.timers.reset()
      watch.mock.restore()
    }
  })

  it('JsonlEventSource: lines written after the stat are read once, by the tail', () => {
    dir = tmpDir()
    const file = path.join(dir, 'events.jsonl')
    const ev = (n: number) => ({ type: 'message', time: n, payload: {} })
    fs.writeFileSync(file, jl(ev(1)))
    const statSize = fs.statSync(file).size
    fs.appendFileSync(file, jl(ev(2)))
    const realStat = fs.statSync
    let growing = true
    const stat = mock.method(require('node:fs'), 'statSync', (p: fs.PathLike, ...a: unknown[]) => {
      const s = (realStat as (p: fs.PathLike, ...a: unknown[]) => fs.Stats)(p, ...a)
      return growing && p === file ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: statSize }) : s
    })
    const watch = mock.method(require('node:fs'), 'watch', () => { throw Object.assign(new Error('limit'), { code: 'ENOSPC' }) })
    mock.timers.enable({ apis: ['setInterval'] })
    const src = new JsonlEventSource(file)
    try {
      const got: AgentEvent[] = []
      src.onEvent(e => got.push(e))
      src.start()
      growing = false
      mock.timers.tick(POLL_FALLBACK_MS)
      assert.deepEqual(got.map(e => e.time), [1, 2])
    } finally {
      src.dispose()
      mock.timers.reset()
      watch.mock.restore()
      stat.mock.restore()
    }
  })
})

describe('subagent pre-scan bounded by the stat size and streamed (#212)', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('a tool_use written between the stat and the read is emitted by the tail', () => {
    dir = tmpDir()
    const file = writeTeammate(dir, { agentId: 'grow0001', meta: null, entries: [userText('go'), assistantToolUse('early-1')] })
    const statSize = fs.statSync(file).size
    fs.appendFileSync(file, jl(assistantToolUse('late-1', 'Bash', { command: 'make' })))
    const realStat = fs.statSync
    let growing = true
    const stat = mock.method(require('node:fs'), 'statSync', (p: fs.PathLike, ...a: unknown[]) => {
      const s = (realStat as (p: fs.PathLike, ...a: unknown[]) => fs.Stats)(p, ...a)
      return growing && p === file ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: statSize }) : s
    })
    const session = makeSession({ subagentsDir: dir })
    const h = makeHarness(session)
    try {
      scanSubagentsDir(h.delegate, h.parser, 's1')
      h.closeWatchers()
    } finally { growing = false; stat.mock.restore() }

    readSubagentNewLines(h.delegate, h.parser, file, 's1')
    assert.equal(toolStarts(h.events, 'late-1').length, 1, 'the late tool call is not swallowed by the dedup set')
    assert.equal(toolStarts(h.events, 'early-1').length, 0, 'the pre-scanned one is not replayed')
  })

  it('a 50 MB subagent transcript is never read in one block', () => {
    dir = tmpDir()
    const file = writeTeammate(dir, { agentId: 'big00001', meta: null, entries: [userText('go')] })
    const one = jl(assistantText('x'.repeat(4000)))
    const block = one.repeat(Math.ceil((1024 * 1024) / one.length))
    const fd = fs.openSync(file, 'a')
    try { for (let i = 0; i < 50; i++) fs.writeSync(fd, block) } finally { fs.closeSync(fd) }
    fs.appendFileSync(file, jl(assistantToolUse('big-1')))
    assert.ok(fs.statSync(file).size >= 50 * 1024 * 1024)

    const nodeFs: typeof fs = require('node:fs')
    const readFile = mock.method(nodeFs, 'readFileSync')
    const readSync = mock.method(nodeFs, 'readSync')
    const session = makeSession({ subagentsDir: dir })
    const h = makeHarness(session)
    try {
      scanSubagentsDir(h.delegate, h.parser, 's1')
      h.closeWatchers()
      assert.equal(readFile.mock.calls.filter(c => c.arguments[0] === file).length, 0, 'no whole-file read')
      // readSync(fd, buffer, offset, length, position): the length of every read
      const lengths = readSync.mock.calls.map(c => Number((c.arguments as unknown[])[3]))
      assert.ok(lengths.length > 1)
      assert.ok(Math.max(...lengths) <= PRESCAN_CHUNK_BYTES, `largest read ${Math.max(...lengths)}`)
      const state = session.subagentWatchers.get(file)
      assert.ok(state?.seenToolUseIds.has('big-1'), 'the whole transcript was scanned')
    } finally {
      readFile.mock.restore()
      readSync.mock.restore()
    }
  })
})

describe('pre-scan coerces tool blocks like the live path (#223)', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  const nullInputUse = {
    type: 'assistant', uuid: 'a1',
    message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'mcp__x__ping', input: null },
      { type: 'text', text: 'pinging' },
    ] },
  }

  it('a tool_use with input null is pre-scanned without malformed and its result is paired after reconnect', () => {
    dir = tmpDir()
    const file = path.join(dir, 'lead.jsonl')
    fs.writeFileSync(file, jl(userText('go')) + jl(nullInputUse))
    const session = makeSession({ sessionId: 's1', filePath: file })
    const h = makeHarness(session)
    h.parser.prescanExistingContent(file, fs.statSync(file).size, session)
    assert.equal(h.parser.getNormalizer('s1').stats.malformed, 0)
    assert.ok(session.pendingToolCalls.has('t1'))
    assert.ok(session.seenMessageHashes.has('assistant:a1'), 'the text block after it is deduplicated')

    fs.appendFileSync(file, jl(toolResult('t1', 'pong')))
    for (const line of readTrackedLines(file, session) ?? []) {
      h.parser.processTranscriptLine(line, 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1', session.seenMessageHashes)
    }
    assert.equal(toolEnds(h.events, 't1').length, 1)
    assert.equal(h.parser.getNormalizer('s1').stats.malformed, 0)

    // Same result as reading the whole transcript live
    const live = makeSession({ sessionId: 's1', filePath: file })
    const hl = makeHarness(live)
    for (const line of fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)) {
      hl.parser.processTranscriptLine(line, 'orchestrator', live.pendingToolCalls, live.seenToolUseIds, 's1', live.seenMessageHashes)
    }
    const strip = (e: AgentEvent) => ({ ...e, time: 0 })
    assert.deepEqual(toolEnds(h.events, 't1').map(strip), toolEnds(hl.events, 't1').map(strip))
    assert.deepEqual(h.parser.getNormalizer('s1').stats, hl.parser.getNormalizer('s1').stats)
    assert.deepEqual(session.contextBreakdown, live.contextBreakdown)
  })
})
