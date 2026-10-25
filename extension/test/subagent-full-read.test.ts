/**
 * The full-read fallback of an idle subagent file (a last window without a line break) must not keep an unbounded
 * unfinished line in memory: its carry is capped at the size the old path read (TEAMMATE_REPLAY_MAX_BYTES), and
 * Buffer.concat is no longer repeated over a growing carry (#613).
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import './helpers/alias-vscode'
import { readLineBatches } from '../src/fs-utils'
import { ClaudeSessionPipeline } from '../src/claude-session-pipeline'
import { ACTIVE_SESSION_AGE_S, NORM_MAX_LINE_CHARS } from '../src/constants'
import type { WatchedSession } from '../src/protocol'

describe('readLineBatches caps the unfinished line it carries (#613)', () => {
  let dir = ''
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  function file(content: string): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-full-read-'))
    const f = path.join(dir, 'agent-x.jsonl')
    fs.writeFileSync(f, content)
    return f
  }
  async function read(f: string, chunk: number, cap?: number) {
    const tracked = { fileSize: 0, fileTail: '' }
    const lines: string[] = []
    const concat = (await import('node:buffer')).Buffer
    const orig = concat.concat
    let maxConcat = 0
    concat.concat = ((list: Uint8Array[], total?: number) => {
      const out = orig.call(concat, list, total)
      maxConcat = Math.max(maxConcat, out.length)
      return out
    }) as typeof Buffer.concat
    try {
      for await (const batch of readLineBatches(f, fs.statSync(f).size, chunk, tracked, cap)) lines.push(...batch)
    } finally { concat.concat = orig }
    return { lines, tracked, maxConcat }
  }

  it('a line over the cap is dropped, the lines around it are kept, nothing grows past the cap plus one chunk', async () => {
    const f = file('{"a":1}\n' + 'y'.repeat(100_000) + '\n{"b":2}\n')
    const { lines, maxConcat } = await read(f, 1024, 4096)
    assert.deepEqual(lines.filter(l => l.length > 0), ['{"a":1}', '{"b":2}'])
    assert.ok(maxConcat <= 4096 + 1024, `largest concatenation ${maxConcat}`)
  })

  it('an unfinished line over the cap at the end of the file leaves no tail and no memory', async () => {
    const f = file('{"a":1}\n' + 'y'.repeat(100_000))
    const { lines, tracked, maxConcat } = await read(f, 1024, 4096)
    assert.deepEqual(lines.filter(l => l.length > 0), ['{"a":1}'])
    assert.equal(tracked.fileTail, '')
    assert.equal(tracked.fileSize, fs.statSync(f).size, 'the offset is still the end of the file')
    assert.ok(maxConcat <= 4096 + 1024, `largest concatenation ${maxConcat}`)
  })

  it('a line under the cap that spans chunks is still read whole, and an unfinished short tail is kept', async () => {
    const long = JSON.stringify({ k: 'z'.repeat(3000) })
    const f = file(long + '\n{"tail":')
    const { lines, tracked } = await read(f, 1024, 4096)
    assert.deepEqual(lines.filter(l => l.length > 0), [long])
    assert.equal(tracked.fileTail, '{"tail":')
  })

  it('without a cap the behaviour is unchanged (the lead transcript keeps long lines)', async () => {
    const f = file('y'.repeat(50_000) + '\n')
    const { lines } = await read(f, 1024)
    assert.equal(lines[0].length, 50_000)
  })
})

describe('the full read of an idle subagent file keeps no line longer than the normalizer accepts (#613)', () => {
  let dir = ''
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('an unfinished line of 5 x NORM_MAX_LINE_CHARS bytes is not held in the tail; the offset is the end of the file', async () => {
    const S = '61300000-0000-4000-8000-000000000001'
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-full-read-att-'))
    const lead = path.join(dir, `${S}.jsonl`)
    fs.writeFileSync(lead, JSON.stringify({ type: 'user', uuid: 'p', message: { role: 'user', content: 'Audit' } }) + '\n')
    const subDir = path.join(dir, S, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const file = path.join(subDir, 'agent-a0000000000000009.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u', message: { role: 'user', content: 'x' } }) + '\n' + 'y'.repeat(5 * NORM_MAX_LINE_CHARS))
    fs.writeFileSync(path.join(subDir, 'agent-a0000000000000009.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Sub' }))
    const old = (Date.now() - (ACTIVE_SESSION_AGE_S + 60) * 1000) / 1000
    fs.utimesSync(file, old, old)
    const sessions = new Map<string, WatchedSession>()
    const pipeline = new ClaudeSessionPipeline({ sessions, submit: () => {}, fireLifecycle: () => {}, withHistory: load => load() })
    const session = pipeline.newSession(S, lead)
    sessions.set(S, session)
    try {
      await pipeline.attach(session)
      const state = session.subagentWatchers.get(file)!
      assert.equal(state.fileTail, '', 'the over-long line is not kept')
      assert.equal(state.fileSize, fs.statSync(file).size)
    } finally { pipeline.release(session) }
  })
})
