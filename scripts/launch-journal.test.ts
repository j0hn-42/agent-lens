/**
 * #229 PR 2: the launch journal. JSONL, append only, 0600, bounded with one rotation, and a fixed set of fields:
 * nothing else (token, issue text, environment) can reach the file even if a caller passes it.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createFileJournal } from './launch-journal'

let dir = ''
let file = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-journal-')); file = path.join(dir, 'sub', 'launch-journal.jsonl') })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const lines = (p: string) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))

describe('createFileJournal', () => {
  it('creates the folder (0700) and the file (0600) and appends one JSON object per line', () => {
    const j = createFileJournal({ file })
    assert.equal(j.append({ ts: 'T1', event: 'requested', repo: 'o/n', issue: 1, role: 'qa-engineer', argv: ['-p', 'x'] }), true)
    assert.equal(j.append({ ts: 'T2', event: 'ended', state: 'exited', exitCode: 0, durationMs: 12 }), true)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
    assert.deepEqual(lines(file).map(e => e.event), ['requested', 'ended'])
    assert.deepEqual(lines(file)[0].argv, ['-p', 'x'])
  })

  it('appends to an existing file and tightens a looser mode', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"event":"old"}\n', { mode: 0o644 })
    fs.chmodSync(file, 0o644)
    const j = createFileJournal({ file })
    assert.equal(j.append({ event: 'requested' }), true)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(lines(file).map(e => e.event), ['old', 'requested'])
  })

  it('writes only the known fields: an extra key (a token, an issue body) is dropped', () => {
    const j = createFileJournal({ file })
    j.append({ event: 'requested', token: 'secret-token', body: 'issue body', env: { A: 'b' }, repo: 'o/n' } as never)
    const [e] = lines(file)
    assert.deepEqual(Object.keys(e).sort(), ['event', 'repo'])
    assert.equal(fs.readFileSync(file, 'utf8').includes('secret'), false)
  })

  it('bounds every value: long strings, long argv, newlines stay inside one JSON line', () => {
    const j = createFileJournal({ file })
    j.append({ event: 'refused', reason: 'x'.repeat(5000), argv: Array.from({ length: 500 }, () => 'a'.repeat(5000)), role: 'a\nb' })
    const text = fs.readFileSync(file, 'utf8')
    assert.equal(text.split('\n').filter(Boolean).length, 1)
    assert.ok(text.length < 32 * 1024)
    assert.equal(lines(file)[0].role, 'a\nb')
  })

  it('rotates once past the cap: the old file becomes .1 (replacing the previous .1), the new one is 0600', () => {
    const j = createFileJournal({ file, maxBytes: 300 })
    for (let i = 0; i < 12; i++) j.append({ event: 'requested', issue: i, repo: 'owner/name', role: 'qa-engineer' })
    assert.ok(fs.existsSync(`${file}.1`))
    assert.equal(fs.existsSync(`${file}.2`), false)
    assert.ok(fs.statSync(file).size <= 300)
    assert.ok(fs.statSync(`${file}.1`).size <= 300)
    assert.equal(fs.statSync(`${file}.1`).mode & 0o777, 0o600)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    // The total on disk stays under twice the cap; the newest entry is in the live file
    const last = lines(file).at(-1)
    assert.equal(last.issue, 11)
  })

  it('does not follow a symbolic link at the journal path (returns false)', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const target = path.join(dir, 'target.txt')
    fs.writeFileSync(target, 'keep\n')
    fs.symlinkSync(target, file)
    const j = createFileJournal({ file })
    assert.equal(j.append({ event: 'requested' }), false)
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n')
  })

  it('returns false instead of throwing when the folder cannot be created', () => {
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, '')
    const j = createFileJournal({ file: path.join(blocker, 'x', 'j.jsonl') })
    assert.equal(j.append({ event: 'requested' }), false)
  })
})
