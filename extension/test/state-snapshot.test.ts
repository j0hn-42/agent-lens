import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  validateSnapshot, deriveSnapshotFreshness, readSnapshotFile, writeFileAtomic, selectSnapshot,
  SnapshotWriter, readSnapshotDir, type Snapshot,
} from '../src/state-snapshot'
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_STALE_AFTER_MS, SNAPSHOT_FUTURE_TOLERANCE_MS } from '../src/constants'

const T0 = 1_700_000_000_000
function snap(over: Partial<Snapshot> = {}): Snapshot {
  return { schema: 1, kind: 'demo', owner: { id: 'a-1', pid: 42 }, generation: 1, writtenAt: T0, payload: { n: 1 }, ...over }
}

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('validateSnapshot (strict)', () => {
  it('accepts the documented envelope', () => assert.ok(validateSnapshot(snap())))
  it('rejects non-objects, arrays and nulls', () => {
    for (const v of [null, 1, 'x', [], undefined]) assert.equal(validateSnapshot(v), null)
  })
  it('rejects an unknown or missing top-level key', () => {
    assert.equal(validateSnapshot({ ...snap(), extra: 1 }), null)
    const { payload: _p, ...rest } = snap()
    assert.equal(validateSnapshot(rest), null)
  })
  it('rejects a wrong schema version, kind, owner, generation, timestamp', () => {
    assert.equal(validateSnapshot({ ...snap(), schema: 2 }), null)
    assert.equal(validateSnapshot(snap({ kind: 'Bad Kind' })), null)
    assert.equal(validateSnapshot(snap({ kind: 'other' }), 'demo'), null)
    assert.equal(validateSnapshot(snap({ owner: { id: '../x', pid: 1 } })), null)
    assert.equal(validateSnapshot(snap({ owner: { id: 'a', pid: 0 } })), null)
    assert.equal(validateSnapshot(snap({ generation: -1 })), null)
    assert.equal(validateSnapshot(snap({ generation: 1.5 })), null)
    assert.equal(validateSnapshot(snap({ writtenAt: NaN })), null)
  })
  it('rejects a payload that is too deep, too wide or not JSON', () => {
    let deep: Record<string, unknown> = {}
    const root = deep
    for (let i = 0; i < 12; i++) { const n = {}; deep.k = n; deep = n }
    assert.equal(validateSnapshot(snap({ payload: root })), null)
    assert.equal(validateSnapshot(snap({ payload: { list: new Array(1001).fill(0) } })), null)
    const wide: Record<string, number> = {}
    for (let i = 0; i < 201; i++) wide[`k${i}`] = i
    assert.equal(validateSnapshot(snap({ payload: wide })), null)
    assert.equal(validateSnapshot(snap({ payload: { f: () => 1 } as never })), null)
    assert.equal(validateSnapshot(snap({ payload: { n: Infinity } })), null)
  })
})

describe('deriveSnapshotFreshness', () => {
  it('is fresh up to the threshold inclusive, stale after', () => {
    assert.equal(deriveSnapshotFreshness(T0, T0), 'fresh')
    assert.equal(deriveSnapshotFreshness(T0, T0 + SNAPSHOT_STALE_AFTER_MS), 'fresh')
    assert.equal(deriveSnapshotFreshness(T0, T0 + SNAPSHOT_STALE_AFTER_MS + 1), 'stale')
  })
  it('does not trust a timestamp from the future', () => assert.equal(deriveSnapshotFreshness(T0 + 1, T0), 'stale'))
})

describe('writeFileAtomic', () => {
  it('writes the content and leaves no temp file', () => {
    const f = path.join(dir, 'sub', 'x.json')
    writeFileAtomic(f, '{"a":1}')
    assert.equal(fs.readFileSync(f, 'utf-8'), '{"a":1}')
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ['x.json'])
  })
  it('replaces the previous content whole', () => {
    const f = path.join(dir, 'x.json')
    writeFileAtomic(f, 'old'); writeFileAtomic(f, 'new')
    assert.equal(fs.readFileSync(f, 'utf-8'), 'new')
  })
  it('keeps the previous target and removes the temp file when the rename fails', () => {
    const f = path.join(dir, 'target')
    fs.mkdirSync(f) // renaming a file over a non-empty directory fails
    fs.writeFileSync(path.join(f, 'keep'), 'k')
    assert.throws(() => writeFileAtomic(f, 'x'))
    assert.deepEqual(fs.readdirSync(dir), ['target'])
    assert.equal(fs.readFileSync(path.join(f, 'keep'), 'utf-8'), 'k')
  })
})

describe('readSnapshotFile', () => {
  const put = (name: string, content: string) => { const f = path.join(dir, name); fs.writeFileSync(f, content); return f }
  it('reads a valid file with freshness and age', () => {
    const f = put('a.json', JSON.stringify(snap()))
    const r = readSnapshotFile(f, { now: T0 + 1000 })
    assert.ok(r.ok)
    if (r.ok) { assert.equal(r.freshness, 'fresh'); assert.equal(r.ageMs, 1000) }
    const late = readSnapshotFile(f, { now: T0 + SNAPSHOT_STALE_AFTER_MS + 1 })
    assert.ok(late.ok && late.freshness === 'stale')
  })
  it('reports each rejection reason', () => {
    assert.deepEqual(readSnapshotFile(path.join(dir, 'nope.json')), { ok: false, reason: 'missing' })
    assert.deepEqual(readSnapshotFile(put('c.json', '{"schema":1,')), { ok: false, reason: 'corrupt' })
    assert.deepEqual(readSnapshotFile(put('i.json', '{"a":1}')), { ok: false, reason: 'invalid' })
    assert.deepEqual(readSnapshotFile(put('big.json', ' '.repeat(SNAPSHOT_MAX_BYTES + 1))), { ok: false, reason: 'too_large' })
    assert.deepEqual(readSnapshotFile(put('f.json', JSON.stringify(snap({ writtenAt: T0 + SNAPSHOT_FUTURE_TOLERANCE_MS + 1 }))), { now: T0 }), { ok: false, reason: 'future' })
    assert.deepEqual(readSnapshotFile(put('k.json', JSON.stringify(snap())), { now: T0, expectedKind: 'other' }), { ok: false, reason: 'invalid' })
  })
  it('refuses a symlink', () => {
    const real = put('real.json', JSON.stringify(snap()))
    const link = path.join(dir, 'link.json')
    fs.symlinkSync(real, link)
    assert.equal(readSnapshotFile(link, { now: T0 }).ok, false)
  })
})

describe('selectSnapshot', () => {
  it('returns undefined for nothing', () => assert.equal(selectSnapshot([]), undefined))
  it('per owner, the highest generation wins even with an older clock', () => {
    const newer = snap({ generation: 5, writtenAt: T0 - 10_000 })
    const older = snap({ generation: 4, writtenAt: T0 })
    assert.equal(selectSnapshot([older, newer]), newer)
  })
  it('across owners the most recent write wins, ties go to the smaller owner id', () => {
    const a = snap({ owner: { id: 'a', pid: 1 }, writtenAt: T0 })
    const b = snap({ owner: { id: 'b', pid: 2 }, writtenAt: T0 + 1 })
    assert.equal(selectSnapshot([a, b]), b)
    const b2 = snap({ owner: { id: 'b', pid: 2 }, writtenAt: T0 })
    assert.equal(selectSnapshot([b2, a]), a)
  })
})

describe('SnapshotWriter', () => {
  it('publishes increasing generations that read back valid', () => {
    let t = T0
    const w = new SnapshotWriter({ dir, kind: 'demo', ownerId: 'w1', now: () => t })
    w.write({ n: 1 }); t += 10
    const s2 = w.write({ n: 2 })
    assert.equal(s2.generation, 2)
    const r = readSnapshotFile(w.filePath, { now: t, expectedKind: 'demo' })
    assert.ok(r.ok && r.snapshot.generation === 2 && r.snapshot.payload.n === 2)
  })
  it('rejects an invalid or oversized payload and writes nothing', () => {
    const w = new SnapshotWriter({ dir, kind: 'demo', ownerId: 'w1' })
    assert.throws(() => w.write({ f: () => 1 } as never))
    assert.throws(() => w.write({ s: 'x'.repeat(SNAPSHOT_MAX_BYTES) }))
    assert.deepEqual(fs.readdirSync(dir), [])
  })
  it('refuses a bad kind or owner id', () => {
    assert.throws(() => new SnapshotWriter({ dir, kind: '../x' }))
    assert.throws(() => new SnapshotWriter({ dir, kind: 'demo', ownerId: 'a/b' }))
  })
  it('remove is idempotent and ends writing', () => {
    const w = new SnapshotWriter({ dir, kind: 'demo', ownerId: 'w1' })
    w.write({}); w.remove(); w.remove()
    assert.deepEqual(fs.readdirSync(dir), [])
    assert.throws(() => w.write({}))
  })
  it('concurrent producers: readSnapshotDir skips junk and selectSnapshot picks one winner', () => {
    const w1 = new SnapshotWriter({ dir, kind: 'demo', ownerId: 'w1', now: () => T0 })
    const w2 = new SnapshotWriter({ dir, kind: 'demo', ownerId: 'w2', now: () => T0 + 5 })
    w1.write({ who: 1 }); w2.write({ who: 2 })
    fs.writeFileSync(path.join(dir, 'demo.junk.json'), 'not json')
    fs.writeFileSync(path.join(dir, 'other.w3.json'), JSON.stringify(snap({ kind: 'other' })))
    const found = readSnapshotDir(dir, 'demo', { now: T0 + 10 })
    assert.equal(found.length, 2)
    assert.equal(selectSnapshot(found.map(f => f.snapshot))?.payload.who, 2)
  })
})
