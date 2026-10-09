/**
 * CodexSessionWatcher (issue #215) : les événements fs.watch du dossier du jour sont coalescés en un scan,
 * et le cwd d'un rollout est lu une seule fois (cache par chemin, positif comme négatif).
 */
import './helpers/alias-vscode'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexSessionWatcher } from '../src/codex-session-watcher'
import { SCAN_INTERVAL_MS } from '../src/constants'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const meta = (cwd: string) => JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n'

function dayDir(root: string, d: Date): string {
  return path.join(root, 'sessions', String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
}

describe('CodexSessionWatcher : scans à froid (#215)', () => {
  let home = ''
  let ws = ''
  let prevHome: string | undefined
  let day = ''
  let watcher: CodexSessionWatcher | null = null
  let listeners: Array<() => void> = []

  const rollout = (n: number) => path.join(day, `rollout-2026-10-08T09-00-00-${uuid(n)}.jsonl`)

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-codex-cold-'))
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'af-codex-ws-'))
    prevHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    day = dayDir(home, new Date())
    fs.mkdirSync(day, { recursive: true })
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() })
    listeners = []
    const realWatch = fs.watch as unknown as (...a: unknown[]) => fs.FSWatcher
    mock.method(fs, 'watch', ((target: fs.PathLike, ...rest: unknown[]) => {
      const w = realWatch(target, ...rest.filter(a => typeof a !== 'function'))
      const cb = rest.find(a => typeof a === 'function') as (() => void) | undefined
      if (cb && String(target) === day) listeners.push(cb)
      return w
    }) as unknown as typeof fs.watch)
  })

  afterEach(() => {
    watcher?.dispose()
    watcher = null
    mock.restoreAll()
    mock.timers.reset()
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('100 événements de watch en 100 ms produisent au plus 2 scans', () => {
    watcher = new CodexSessionWatcher(null)
    watcher.start()
    assert.ok(listeners.length > 0, 'le dossier du jour est surveillé')
    const scan = mock.method(watcher as unknown as { scanForSessions(): void }, 'scanForSessions')
    for (let i = 0; i < 100; i++) {
      listeners.forEach(l => l())
      mock.timers.tick(1)
    }
    mock.timers.tick(SCAN_INTERVAL_MS - 200) // laisse le debounce partir, avant le prochain scan à 1 s
    assert.ok(scan.mock.callCount() >= 1 && scan.mock.callCount() <= 2, `scans : ${scan.mock.callCount()}`)
  })

  it('un rollout hors workspace n\'est lu qu\'une fois sur plusieurs scans', () => {
    fs.writeFileSync(rollout(1), meta('/ailleurs/autre-depot'))
    watcher = new CodexSessionWatcher(ws)
    const read = mock.method(fs, 'readSync')
    watcher.start()
    const first = read.mock.callCount()
    assert.ok(first >= 1, 'le cwd est lu au premier scan')
    mock.timers.tick(SCAN_INTERVAL_MS * 5)
    assert.equal(read.mock.callCount(), first, 'aucune relecture aux scans suivants')
  })

  it('un cwd négatif (première ligne qui n\'est pas une session_meta) est aussi mis en cache', () => {
    fs.writeFileSync(rollout(1), JSON.stringify({ type: 'event_msg', payload: {} }) + '\n')
    watcher = new CodexSessionWatcher(ws)
    const read = mock.method(fs, 'readSync')
    watcher.start()
    const first = read.mock.callCount()
    assert.ok(first >= 1)
    mock.timers.tick(SCAN_INTERVAL_MS * 5)
    assert.equal(read.mock.callCount(), first)
  })

  it('une première ligne encore incomplète n\'est pas mise en cache : le cwd est lu une fois complète', () => {
    fs.writeFileSync(rollout(1), meta(ws).slice(0, 20)) // pas de saut de ligne
    watcher = new CodexSessionWatcher(ws)
    watcher.start()
    const internals = watcher as unknown as { sessions: Map<string, unknown> }
    assert.equal(internals.sessions.size, 0)
    fs.writeFileSync(rollout(1), meta(ws))
    mock.timers.tick(SCAN_INTERVAL_MS)
    assert.equal(internals.sessions.size, 1)
  })
})
