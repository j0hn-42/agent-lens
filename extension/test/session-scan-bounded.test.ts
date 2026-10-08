/**
 * Scan des sessions (issue #142) : sur un projet de 1 000 transcripts, le plus récent (dernier dans
 * l'ordre de readdir) est détecté, et les cycles suivants ne re-stat pas les transcripts anciens.
 */
import './helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-scan-bounded-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

const OLD_COUNT = 1000
const NEWEST = 'zzz-newest'

type Internals = { sessions: Map<string, unknown>; scanForActiveSessions: () => void }

describe('scan des sessions borné', () => {
  let projectDir = ''
  let SessionWatcher: typeof import('../src/session-watcher').SessionWatcher
  before(async () => {
    const vscodeShim = require('vscode') as { window: Record<string, unknown> }
    vscodeShim.window.setStatusBarMessage = () => ({ dispose() {} })
    ;({ SessionWatcher } = await import('../src/session-watcher'))
    const cwd = fs.realpathSync(process.cwd())
    projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    const old = new Date(Date.now() - 24 * 3_600_000)
    for (let i = 0; i < OLD_COUNT; i++) {
      const f = path.join(projectDir, `old-${String(i).padStart(4, '0')}.jsonl`)
      fs.writeFileSync(f, '{}\n')
      fs.utimesSync(f, old, old)
    }
    fs.writeFileSync(path.join(projectDir, `${NEWEST}.jsonl`),
      JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n')
  })
  after(() => fs.rmSync(fakeHome, { recursive: true, force: true }))

  it('détecte le transcript le plus récent parmi 1 000 et ne re-stat pas les anciens au cycle suivant', () => {
    const watcher = new SessionWatcher()
    const internals = watcher as unknown as Internals
    const rawFs = require('node:fs') as { statSync: unknown }
    const realStat = rawFs.statSync as typeof fs.statSync
    let statCount = 0
    ;rawFs.statSync = ((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).startsWith(projectDir) && String(p).endsWith('.jsonl')) statCount++
      return (realStat as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.statSync
    try {
      watcher.start()
      assert.ok(internals.sessions.has(NEWEST), 'le transcript récent est suivi')
      assert.equal(internals.sessions.size, 1, 'aucun transcript ancien n’est suivi')
      const firstCycle = statCount
      assert.ok(firstCycle >= OLD_COUNT, `premier scan : ${firstCycle} stat`)

      statCount = 0
      internals.scanForActiveSessions()
      assert.equal(statCount, 0, `cycle suivant : ${statCount} stat (anciens écartés, session suivie ignorée)`)
    } finally {
      ;rawFs.statSync = realStat
      watcher.dispose()
    }
  })
})
