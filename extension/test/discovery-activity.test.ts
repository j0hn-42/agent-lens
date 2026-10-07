import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { newestTranscriptMtime, DISCOVERY_MAX_TRANSCRIPT_STATS, type StatLike } from '../src/discovery-activity'

const file = (mtimeMs: number): StatLike => ({ isFile: () => true, mtimeMs })

function fake(map: Record<string, StatLike>, calls: string[] = []) {
  return (p: string) => { calls.push(p); const s = map[p]; if (!s) throw new Error('gone'); return s }
}

describe('newestTranscriptMtime (#79: sessions kept alive by workflow agents)', () => {
  it('finds a fresh file listed AFTER more than 100 old ones (the old cap dropped it)', () => {
    const paths = Array.from({ length: 301 }, (_, i) => `a${i}`)
    const map: Record<string, StatLike> = {}
    for (const p of paths) map[p] = file(1_000)
    map[paths[300]] = file(9_000_000)
    assert.equal(newestTranscriptMtime(paths, 500, 5_000_000, undefined, fake(map)), 9_000_000)
  })

  it('stops at the first fresh file: later files are not examined', () => {
    const calls: string[] = []
    const map = { a: file(10), b: file(9_000_000), c: file(9_500_000) }
    const out = newestTranscriptMtime(['a', 'b', 'c'], 0, 5_000_000, undefined, fake(map, calls))
    assert.equal(out, 9_000_000)
    assert.deepEqual(calls, ['a', 'b'])
  })

  it('examines at most maxStats files: exactly at the bound counts, one past does not', () => {
    const paths = Array.from({ length: 11 }, (_, i) => `f${i}`)
    const map: Record<string, StatLike> = {}
    for (const p of paths) map[p] = file(1)
    map.f9 = file(7)   // 10th file: inside a bound of 10
    map.f10 = file(8)  // 11th file: beyond it
    assert.equal(newestTranscriptMtime(paths, 0, 1e12, 10, fake(map)), 7)
    assert.equal(newestTranscriptMtime(paths, 0, 1e12, 11, fake(map)), 8)
  })

  it('has a documented safety bound large enough for 20 workflows of 200 agents', () => {
    assert.ok(DISCOVERY_MAX_TRANSCRIPT_STATS >= 4000)
  })

  it('never counts a symlink (even to a fresh file) or a vanished file as activity', () => {
    const map: Record<string, StatLike> = { link: { isFile: () => false, mtimeMs: 9_000_000 }, real: file(100) }
    assert.equal(newestTranscriptMtime(['link', 'gone', 'real'], 0, 5_000_000, undefined, fake(map)), 100)
  })

  it('uses lstat on the real filesystem: a symlink to a fresh file does not keep a session alive', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-disc-'))
    try {
      const target = path.join(dir, 'fresh.jsonl')
      fs.writeFileSync(target, '{}\n')
      const link = path.join(dir, 'agent-link.jsonl')
      fs.symlinkSync(target, link)
      assert.equal(newestTranscriptMtime([link], 0, Date.now() + 1e9), 0)
      assert.ok(newestTranscriptMtime([target], 0, Date.now() + 1e9) > 0)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
