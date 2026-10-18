/**
 * CodexSessionWatcher (#420): a session is announced with its runtime and, when the rollout records a
 * usable one, its working directory (session_meta.cwd), so the page can show its badge as soon as it
 * starts. A cwd that is not an absolute, clean path is left out, never guessed.
 */
import './helpers/alias-vscode'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexSessionWatcher } from '../src/codex-session-watcher'
import type { SessionLifecycleEvent } from '../src/session-runtime'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const meta = (cwd: unknown) => JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n'

function dayDir(root: string, d: Date): string {
  return path.join(root, 'sessions', String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
}

describe('CodexSessionWatcher: runtime and cwd on the session lifecycle (#420)', () => {
  let home = ''
  let day = ''
  let prevHome: string | undefined
  let watcher: CodexSessionWatcher | null = null
  const rollout = (n: number) => path.join(day, `rollout-2026-10-08T09-00-00-${uuid(n)}.jsonl`)

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-codex-tags-'))
    prevHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    day = dayDir(home, new Date())
    fs.mkdirSync(day, { recursive: true })
  })

  afterEach(() => {
    try { watcher?.dispose() } finally {
      watcher = null
      if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  function start(): SessionLifecycleEvent[] {
    const lifecycle: SessionLifecycleEvent[] = []
    watcher = new CodexSessionWatcher(null)
    watcher.onSessionLifecycle(l => lifecycle.push(l))
    watcher.start()
    return lifecycle
  }

  it('announces runtime codex and the recorded cwd, also in the session list and on a replay', () => {
    fs.writeFileSync(rollout(1), meta('/home/me/code/alpha'))
    const lifecycle = start()
    assert.deepEqual(lifecycle.map(l => [l.type, l.sessionId, l.runtime, l.cwd]), [['started', uuid(1), 'codex', '/home/me/code/alpha']])
    const [listed] = watcher!.getActiveSessions()
    assert.equal(listed.runtime, 'codex')
    assert.equal(listed.cwd, '/home/me/code/alpha')
    watcher!.replaySessionStart()
    assert.deepEqual(lifecycle.slice(1).map(l => [l.type, l.runtime, l.cwd]), [['started', 'codex', '/home/me/code/alpha']])
  })

  it('leaves the cwd out when the rollout gives none, or one that is not an absolute clean path', () => {
    fs.writeFileSync(rollout(1), JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }) + '\n')
    fs.writeFileSync(rollout(2), meta('relative/dir'))
    fs.writeFileSync(rollout(3), meta('/home/me/\u001b[2Jx'))
    fs.writeFileSync(rollout(4), meta('/home/me/‮evil'))
    fs.writeFileSync(rollout(5), meta(42))
    const lifecycle = start()
    const started = lifecycle.filter(l => l.type === 'started')
    assert.equal(started.length, 5)
    for (const l of started) {
      assert.equal(l.runtime, 'codex')
      assert.equal('cwd' in l, false, `no cwd for ${l.sessionId}`)
    }
    for (const s of watcher!.getActiveSessions()) assert.equal(s.cwd, undefined)
  })
  it('reads the cwd again while the first line is still being written, then announces it once (#420)', () => {
    const file = rollout(1)
    const full = meta('/home/me/code/alpha')
    fs.writeFileSync(file, full.slice(0, 20))
    const lifecycle = start()
    assert.deepEqual(lifecycle.map(l => [l.type, l.cwd]), [['started', undefined]])
    fs.appendFileSync(file, full.slice(20) + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }) + '\n')
    const read = (watcher as unknown as { readNewLines(id: string): void })
    read.readNewLines(uuid(1))
    assert.equal(watcher!.getActiveSessions()[0].cwd, '/home/me/code/alpha')
    assert.deepEqual(lifecycle.slice(1).map(l => [l.type, l.sessionId, l.runtime, l.cwd]), [['updated', uuid(1), 'codex', '/home/me/code/alpha']])
    fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'again' } }) + '\n')
    read.readNewLines(uuid(1))
    assert.equal(lifecycle.length, 2, 'announced once')
  })
})
