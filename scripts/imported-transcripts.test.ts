/**
 * Imported transcripts (#294, track 1): which JSONL files an --import path (or AGENT_LENS_IMPORT) designates,
 * and the time range a transcript records. Pure file-system helpers, no relay.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  parseImportPaths, resolveImportedTranscripts, transcriptTimeRange,
} from '../extension/src/imported-transcripts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-imported-'))
const line = (o: unknown) => JSON.stringify(o) + '\n'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

describe('parseImportPaths', () => {
  it('splits the env list on the platform delimiter and drops blanks', () => {
    assert.deepEqual(parseImportPaths(undefined), [])
    assert.deepEqual(parseImportPaths(''), [])
    assert.deepEqual(parseImportPaths(` /a/x.jsonl ${path.delimiter}${path.delimiter} /b `), ['/a/x.jsonl', '/b'])
  })
})

describe('resolveImportedTranscripts', () => {
  const dir = path.join(tmp, 'cloud')
  const opts = { maxFileBytes: 10_000, maxSessions: 3 }

  before(() => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${A}.jsonl`), line({ type: 'user', message: { role: 'user', content: 'hi' } }))
    fs.writeFileSync(path.join(dir, `${B}.jsonl`), line({ type: 'user', message: { role: 'user', content: 'yo' } }))
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a transcript')
    fs.writeFileSync(path.join(dir, 'bad id!.jsonl'), line({}))
    fs.mkdirSync(path.join(dir, A, 'subagents'), { recursive: true })
    fs.writeFileSync(path.join(tmp, `${C}.jsonl`), 'x'.repeat(20_000))
  })

  it('takes every *.jsonl directly inside a folder, named by their session id', () => {
    const r = resolveImportedTranscripts([dir], opts)
    assert.deepEqual(r.transcripts.map(t => t.sessionId).sort(), [A, B])
    assert.equal(r.transcripts.find(t => t.sessionId === A)?.filePath, path.join(dir, `${A}.jsonl`))
    assert.ok(r.problems.some(p => p.includes('bad id!.jsonl')), 'a file name that is not a session id is reported, not imported')
  })

  it('takes a single file, and reports a missing path or a non-JSONL file', () => {
    const r = resolveImportedTranscripts([path.join(dir, `${B}.jsonl`), path.join(tmp, 'missing'), path.join(dir, 'notes.txt')], opts)
    assert.deepEqual(r.transcripts.map(t => t.sessionId), [B])
    assert.equal(r.problems.length, 2)
  })

  it('refuses a transcript past the size cap', () => {
    const r = resolveImportedTranscripts([path.join(tmp, `${C}.jsonl`)], opts)
    assert.equal(r.transcripts.length, 0)
    assert.match(r.problems[0], /size/i)
  })

  it('imports a session id once and stops at the session cap', () => {
    const r = resolveImportedTranscripts([dir, path.join(dir, `${A}.jsonl`)], { ...opts, maxSessions: 1 })
    assert.equal(r.transcripts.length, 1)
    assert.ok(r.problems.some(p => /limit/i.test(p)), 'what the cap leaves out is reported')
  })

  it('does not follow a symbolic link inside an imported folder', { skip: process.platform === 'win32' }, () => {
    const linked = path.join(tmp, 'linked')
    fs.mkdirSync(linked, { recursive: true })
    fs.symlinkSync(path.join(dir, `${A}.jsonl`), path.join(linked, `${C}.jsonl`))
    const r = resolveImportedTranscripts([linked], opts)
    assert.equal(r.transcripts.length, 0)
  })
})

describe('transcriptTimeRange', () => {
  it('returns the first and last recorded timestamps', () => {
    const f = path.join(tmp, 'range.jsonl')
    fs.writeFileSync(f, [
      line({ type: 'file-history-snapshot' }),
      line({ type: 'user', timestamp: '2026-10-01T10:00:00.000Z' }),
      'not json\n',
      line({ type: 'assistant', timestamp: '2026-10-01T10:05:00.000Z' }),
      line({ type: 'assistant', timestamp: 'garbage' }),
    ].join(''))
    assert.deepEqual(transcriptTimeRange(f), { first: Date.parse('2026-10-01T10:00:00.000Z'), last: Date.parse('2026-10-01T10:05:00.000Z') })
  })

  it('says nothing when no timestamp is recorded', () => {
    const f = path.join(tmp, 'none.jsonl')
    fs.writeFileSync(f, line({ type: 'user' }))
    assert.deepEqual(transcriptTimeRange(f), {})
  })
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))
