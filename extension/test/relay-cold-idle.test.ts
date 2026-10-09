import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createColdScan, findActiveSessions, wakeColdSession } from '../src/relay-guards'

// #211 : un transcript examiné et jugé inactif (principal + sous-agents) est mis au froid
const AGE_S = 600
const OLD = new Date(Date.now() - 3_600_000)

describe('findActiveSessions : mise au froid des transcripts inactifs (#211)', () => {
  let dir: string
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-idle-'))
    for (let i = 0; i < 1000; i++) {
      const f = path.join(dir, `idle-${i}.jsonl`)
      fs.writeFileSync(f, '{}\n')
      fs.utimesSync(f, OLD, OLD)
    }
  })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('le second cycle ne fait aucun lstat ni readdir sur 1000 transcripts inactifs', () => {
    const cold = createColdScan()
    const opts = { dirs: [dir], maxFilesPerDir: 2000, maxFileBytes: 1_000_000, cold, activeAgeS: AGE_S }
    const f = require('node:fs')
    const lstat = mock.method(f, 'lstatSync')
    const readdir = mock.method(f, 'readdirSync')
    const stat = mock.method(f, 'statSync')
    try {
      cold.cycle++
      assert.deepEqual(findActiveSessions(opts), [])
      assert.ok(lstat.mock.callCount() >= 1000, 'premier cycle : tout est examiné')
      assert.ok(readdir.mock.callCount() >= 1000, 'premier cycle : sous-agents listés')
      lstat.mock.resetCalls(); readdir.mock.resetCalls(); stat.mock.resetCalls()
      cold.cycle++
      assert.deepEqual(findActiveSessions(opts), [])
      assert.equal(lstat.mock.callCount(), 0, 'aucun lstat')
      assert.equal(stat.mock.callCount(), 0, 'aucun stat')
      assert.equal(readdir.mock.callCount(), 1, 'seulement le readdir du dossier de projet')
    } finally { lstat.mock.restore(); readdir.mock.restore(); stat.mock.restore() }
  })

  it('une session froide qui reçoit une écriture est détectée au cycle suivant après le réveil par le watcher', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-wake-'))
    try {
      const f = path.join(d, 'wake.jsonl')
      fs.writeFileSync(f, '{}\n')
      fs.utimesSync(f, OLD, OLD)
      const cold = createColdScan()
      const opts = { dirs: [d], maxFileBytes: 1_000_000, cold, activeAgeS: AGE_S }
      cold.cycle++
      assert.deepEqual(findActiveSessions(opts), [])
      assert.ok((cold.until.get(f) ?? 0) > cold.cycle, 'mise au froid')
      fs.appendFileSync(f, '{}\n')
      cold.cycle++
      assert.deepEqual(findActiveSessions(opts), [], 'encore froid sans événement de watch')
      assert.equal(wakeColdSession(cold, d, 'wake'), true)
      cold.cycle++
      assert.deepEqual(findActiveSessions(opts).map(x => x.sessionId), ['wake'])
      assert.equal(wakeColdSession(cold, d, 'wake'), false, 'n\'est plus froid')
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('un sous-agent récent garde la session active ; un sous-agent ancien la laisse froide', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-sub-'))
    try {
      const f = path.join(d, 'sess.jsonl')
      fs.writeFileSync(f, '{}\n')
      fs.utimesSync(f, OLD, OLD)
      const sub = path.join(d, 'sess', 'subagents', 'agent-a.jsonl')
      fs.mkdirSync(path.dirname(sub), { recursive: true })
      fs.writeFileSync(sub, '{}\n')
      const cold = createColdScan()
      const opts = { dirs: [d], maxFileBytes: 1_000_000, cold, activeAgeS: AGE_S }
      cold.cycle++
      assert.equal(findActiveSessions(opts).length, 1)
      assert.equal(cold.until.has(f), false, 'active : pas froide')
      fs.utimesSync(sub, OLD, OLD)
      cold.cycle++
      assert.equal(findActiveSessions(opts).length, 0)
      assert.ok((cold.until.get(f) ?? 0) > cold.cycle, 'inactive : froide')
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('onIdle est appelé une fois par session mise au froid', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-cb-'))
    try {
      const f = path.join(d, 'x.jsonl')
      fs.writeFileSync(f, '{}\n')
      fs.utimesSync(f, OLD, OLD)
      const cold = createColdScan()
      const idle: string[] = []
      const opts = { dirs: [d], maxFileBytes: 1_000_000, cold, activeAgeS: AGE_S, onIdle: (s: { sessionId: string }) => idle.push(s.sessionId) }
      cold.cycle++; findActiveSessions(opts)
      cold.cycle++; findActiveSessions(opts)
      assert.deepEqual(idle, ['x'])
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })
})
