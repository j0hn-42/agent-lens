/**
 * CodexSessionWatcher (issue #143) : les sessions terminées sont libérées (watcher, timers, parser),
 * rattachées si le fichier reprend, le nombre de sessions suivies est plafonné et les watchers des
 * jours sortis de la fenêtre de scan sont fermés.
 */
import './helpers/alias-vscode'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexSessionWatcher } from '../src/codex-session-watcher'
import { ACTIVE_SESSION_AGE_S, CODEX_MAX_WATCHED_SESSIONS, INACTIVITY_TIMEOUT_MS, POLL_FALLBACK_MS } from '../src/constants'

type Internals = { sessions: Map<string, unknown>; dirWatchers: Map<string, unknown> }

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const metaLine = JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp/ws' } }) + '\n'

function dayDir(root: string, d: Date): string {
  return path.join(root, 'sessions', String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
}

describe('CodexSessionWatcher : libération des sessions terminées', () => {
  let home = ''
  let prevHome: string | undefined
  let day = ''
  const live = new Set<unknown>()
  let watcher: CodexSessionWatcher | null = null

  const rollout = (n: number) => path.join(day, `rollout-2026-10-08T09-00-00-${uuid(n)}.jsonl`)

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-codex-release-'))
    prevHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    day = dayDir(home, new Date())
    fs.mkdirSync(day, { recursive: true })
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() })
    live.clear()
    // Compte les timers encore armés
    const si = globalThis.setInterval, ci = globalThis.clearInterval
    const st = globalThis.setTimeout, ct = globalThis.clearTimeout
    mock.method(globalThis, 'setInterval', ((...a: Parameters<typeof si>) => { const h = si(...a); live.add(h); return h }) as typeof si)
    mock.method(globalThis, 'clearInterval', ((h: Parameters<typeof ci>[0]) => { live.delete(h); return ci(h) }) as typeof ci)
    // Un setTimeout qui a déclenché n'est plus armé (ex. le flush différé des stats du normaliseur, posé
    // selon l'écart réel entre deux écritures) : sinon le compte dépend de la vitesse de la machine.
    mock.method(globalThis, 'setTimeout', ((cb: (...x: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      const h: ReturnType<typeof st> = st((...x: unknown[]) => { live.delete(h); cb(...x) }, ms, ...rest)
      live.add(h)
      return h
    }) as typeof st)
    mock.method(globalThis, 'clearTimeout', ((h: Parameters<typeof ct>[0]) => { live.delete(h); return ct(h) }) as typeof ct)
  })

  afterEach(() => {
    watcher?.dispose()
    watcher = null
    mock.restoreAll()
    mock.timers.reset()
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('N sessions créées puis inactives : plus de session ni de timer de session, seul le scan reste', () => {
    for (let i = 1; i <= 5; i++) fs.writeFileSync(rollout(i), metaLine)
    watcher = new CodexSessionWatcher(null)
    watcher.start()
    const internals = watcher as unknown as Internals
    assert.equal(internals.sessions.size, 5)
    assert.ok(live.size > 1, 'chaque session arme un poll et un timer d\'inactivité')

    mock.timers.tick(INACTIVITY_TIMEOUT_MS + 1000) // terminées
    assert.equal(internals.sessions.size, 5, 'terminées mais pas encore libérées')
    mock.timers.tick(ACTIVE_SESSION_AGE_S * 1000) // au-delà de ACTIVE_SESSION_AGE_S
    assert.equal(internals.sessions.size, 0)
    assert.equal(live.size, 1, 'seul le timer de scan reste armé')
  })

  it('une session libérée est rattachée quand son fichier reprend, sans rejouer l\'historique', () => {
    fs.writeFileSync(rollout(1), metaLine)
    watcher = new CodexSessionWatcher(null)
    const lifecycle: string[] = []
    watcher.onSessionLifecycle(e => lifecycle.push(`${e.type}:${e.sessionId}`))
    watcher.start()
    mock.timers.tick(INACTIVITY_TIMEOUT_MS + ACTIVE_SESSION_AGE_S * 1000 + 1000)
    const internals = watcher as unknown as Internals
    assert.equal(internals.sessions.size, 0)

    const now = new Date(Date.now())
    fs.appendFileSync(rollout(1), JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }) + '\n')
    fs.utimesSync(rollout(1), now, now)
    mock.timers.tick(1000)
    assert.equal(internals.sessions.size, 1)
    assert.deepEqual(lifecycle.filter(l => l.startsWith('started')), [`started:${uuid(1)}`, `started:${uuid(1)}`])
  })

  // #206 : dans le relais, une exception dans le poll est un uncaughtException fatal
  it('une exception pendant la lecture du poll détache la session (ended) sans sortir du timer', () => {
    fs.writeFileSync(rollout(1), metaLine)
    watcher = new CodexSessionWatcher(null)
    const lifecycle: string[] = []
    let starts = 0
    watcher.onSessionLifecycle(e => {
      lifecycle.push(`${e.type}:${e.sessionId}`)
      if (e.type === 'started' && ++starts === 2) throw new Error('listener failed')
    })
    watcher.start()
    const internals = watcher as unknown as Internals
    mock.timers.tick(INACTIVITY_TIMEOUT_MS + 1000) // terminée : la reprise refire 'started'
    assert.equal(internals.sessions.size, 1)

    fs.appendFileSync(rollout(1), JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }) + '\n')
    assert.doesNotThrow(() => mock.timers.tick(POLL_FALLBACK_MS))
    assert.ok(lifecycle.includes(`ended:${uuid(1)}`), lifecycle.join(','))
    assert.equal(lifecycle.filter(l => l === `ended:${uuid(1)}`).length, 2, 'inactivité puis détachement')
  })

  it('plafonne le nombre de sessions suivies en gardant les plus récentes', () => {
    const total = CODEX_MAX_WATCHED_SESSIONS + 5
    const base = Date.now()
    for (let i = 1; i <= total; i++) {
      fs.writeFileSync(rollout(i), metaLine)
      const t = new Date(base - (total - i) * 1000) // i grand = plus récent
      fs.utimesSync(rollout(i), t, t)
    }
    watcher = new CodexSessionWatcher(null)
    watcher.start()
    const internals = watcher as unknown as Internals
    assert.equal(internals.sessions.size, CODEX_MAX_WATCHED_SESSIONS)
    assert.ok(internals.sessions.has(uuid(total)), 'la plus récente est suivie')
    assert.ok(!internals.sessions.has(uuid(1)), 'la plus ancienne est écartée')
  })

  it('ferme les watchers des jours sortis de la fenêtre de scan', () => {
    const stale = path.join(home, 'sessions', '2020', '01', '01')
    fs.mkdirSync(stale, { recursive: true })
    watcher = new CodexSessionWatcher(null)
    watcher.start()
    const internals = watcher as unknown as Internals
    let closed = false
    internals.dirWatchers.set(stale, { close: () => { closed = true } })
    mock.timers.tick(1000)
    assert.equal(closed, true)
    assert.ok(!internals.dirWatchers.has(stale))
    assert.ok(internals.dirWatchers.has(day), 'le jour courant reste surveillé')
  })
})
