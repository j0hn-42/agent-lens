/**
 * Discovery helpers report what they leave out (#291): project folders past the cap, transcripts past the
 * per-folder cap, transcripts past the size cap. Pure file-system tests in a throw-away directory.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listProjectDirs, discoverSessionFiles } from '../extension/src/relay-guards'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-scope-discovery-'))
after(() => fs.rmSync(root, { recursive: true, force: true }))

describe('listProjectDirs report', () => {
  before(() => { for (const n of ['a', 'b', 'c']) fs.mkdirSync(path.join(root, 'projects', n), { recursive: true }) })
  const projects = () => path.join(root, 'projects')

  it('says it truncated when a further folder exists past the cap', () => {
    const report = { truncated: false }
    assert.equal(listProjectDirs(projects(), null, 2, report).length, 2)
    assert.equal(report.truncated, true)
  })

  it('keeps the first folders by name, whatever the order the file system lists them in', () => {
    assert.deepEqual(listProjectDirs(projects(), null, 2).map(p => path.basename(p)), ['a', 'b'])
  })

  it('does not claim truncation when the cap is exactly reached or not reached', () => {
    for (const max of [3, 10]) {
      const report = { truncated: true }
      assert.equal(listProjectDirs(projects(), null, max, report).length, 3)
      assert.equal(report.truncated, false, `cap ${max}`)
    }
  })

  it('a folder the matcher refuses is not "left out by the cap"', () => {
    const report = { truncated: false }
    assert.deepEqual(listProjectDirs(projects(), n => n === 'a', 1, report).map(p => path.basename(p)), ['a'])
    assert.equal(report.truncated, false)
  })
})

describe('discoverSessionFiles onSkipped', () => {
  const dir = () => path.join(root, 'sessions')
  before(() => {
    fs.mkdirSync(dir(), { recursive: true })
    const t = Date.now() / 1000
    for (const [i, name] of ['new', 'mid', 'old'].entries()) {
      fs.writeFileSync(path.join(dir(), `${name}.jsonl`), 'x\n')
      fs.utimesSync(path.join(dir(), `${name}.jsonl`), t - i * 10, t - i * 10)
    }
    fs.writeFileSync(path.join(dir(), 'huge.jsonl'), 'x'.repeat(100))
  })

  it('reports the transcripts past the per-folder cap (oldest first dropped) and the oversized ones', () => {
    const skipped: Array<[string, string]> = []
    const found = discoverSessionFiles({
      dirs: [dir()], maxFilesPerDir: 2, maxFileBytes: 50,
      onSkipped: (reason, f) => skipped.push([reason, f.sessionId]),
    })
    assert.deepEqual(found.map(f => f.sessionId).sort(), ['mid', 'new'])
    assert.deepEqual(skipped.sort(), [['fileLimit', 'old'], ['sizeLimit', 'huge']])
  })

  it('stays silent when nothing is left out', () => {
    const skipped: unknown[] = []
    discoverSessionFiles({ dirs: [dir()], maxFilesPerDir: 10, maxFileBytes: 1000, onSkipped: (r, f) => skipped.push([r, f]) })
    assert.deepEqual(skipped, [])
  })
})
