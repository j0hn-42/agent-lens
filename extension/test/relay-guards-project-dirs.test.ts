/**
 * Cost of the ranking of project folders past RELAY_MAX_PROJECT_DIRS (#654, #613). Between two recomputes
 * (COLD_RESCAN_CYCLES scans) a scan costs one readdir of the root and one fs.statSync per folder, nothing per
 * transcript. Measured on 3000 folders (tmpfs, warm cache, median of 10 scans): 4.2 ms; 1000 folders: 1.4 ms;
 * 201 folders: 0.5 ms (the first scan, which measures every folder, costs 15.8 ms / 6.1 ms / 2.3 ms).
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import fsModule from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listProjectDirs, createColdScan } from '../src/relay-guards'
import { COLD_RESCAN_CYCLES } from '../src/constants'

describe('ranking of project folders between two recomputes (#613)', () => {
  let root = ''
  const FOLDERS = 12
  const CAP = 3
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-project-dirs-'))
    for (let i = 0; i < FOLDERS; i++) {
      const d = path.join(root, `p${String(i).padStart(2, '0')}`)
      fs.mkdirSync(d)
      const file = path.join(d, 's.jsonl')
      fs.writeFileSync(file, '{}\n')
      fs.utimesSync(file, 1000 + i, 1000 + i)
      // The folder mtime is far in the past: a file created later moves it whatever the clock granularity
      fs.utimesSync(d, 1000, 1000)
    }
  })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  const top = (cold: ReturnType<typeof createColdScan>) => listProjectDirs(root, null, CAP, undefined, cold).map(d => path.basename(d))

  it('a scan between recomputes costs one statSync per folder and no lstat nor readdir of the transcripts', () => {
    const cold = createColdScan()
    cold.cycle = 1
    top(cold)
    cold.cycle = 2
    const stat = mock.method(fsModule, 'statSync')
    const lstat = mock.method(fsModule, 'lstatSync')
    const readdir = mock.method(fsModule, 'readdirSync')
    try { top(cold) } finally { for (const m of [stat, lstat, readdir]) m.mock.restore() }
    assert.equal(stat.mock.callCount(), FOLDERS, 'one statSync per folder')
    assert.equal(lstat.mock.callCount(), 0)
    assert.equal(readdir.mock.callCount(), 1, 'the root only')
  })

  it('a write into an existing transcript moves its folder only at the next recompute (known limit), a new file at once', () => {
    const cold = createColdScan()
    cold.cycle = 1
    assert.deepEqual(top(cold), ['p11', 'p10', 'p09'])
    const old = path.join(root, 'p00', 's.jsonl')
    fs.utimesSync(old, 5000, 5000) // an existing transcript written: the folder mtime does not move
    cold.cycle = 2
    assert.deepEqual(top(cold), ['p11', 'p10', 'p09'], 'not seen before the recompute')
    fs.writeFileSync(path.join(root, 'p01', 'new.jsonl'), '{}\n')
    fs.utimesSync(path.join(root, 'p01', 'new.jsonl'), 6000, 6000)
    cold.cycle = 3
    assert.equal(top(cold)[0], 'p01', 'a new session file is ranked at once')
    cold.cycle = 1 + COLD_RESCAN_CYCLES
    assert.ok(top(cold).includes('p00'), 'the recompute sees the write')
  })
})
