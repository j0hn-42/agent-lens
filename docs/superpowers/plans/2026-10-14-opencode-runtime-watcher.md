# Runtime OpenCode : watcher, câblage et web (plan)

> **Pour les agents d'exécution :** sous-skill requise : `superpowers:subagent-driven-development` (recommandé) ou `superpowers:executing-plans`. Les étapes utilisent des cases `- [ ]`.

**Objectif :** afficher les sessions OpenCode dans Agent Lens en reliant le lecteur SQLite et le parseur déjà livrés à un watcher, au runtime de l'extension, au relais et au web.

**Architecture :** `OpenCodeSessionWatcher` sonde `opencode.db` (lecture seule, `OpenCodeDb.poll`) et passe les lignes au `OpenCodeEventParser`, un parseur par session racine. Il implémente `AgentSessionWatcher` comme `PiSessionWatcher`. Le runtime et le relais l'instancient ; le web ajoute `'opencode'` à chaque union de runtimes.

**Stack :** TypeScript, `node:sqlite` (Node 22.13+), `node --test` via `tsx`, Next.js 16 / React 19 pour le web.

**Spec :** [docs/superpowers/specs/2026-10-12-opencode-runtime-design.md](../specs/2026-10-12-opencode-runtime-design.md). Issue : #346.

## Déjà livré (ne pas refaire)

- #347 : la spec.
- #392 : `extension/src/opencode-event-parser.ts` (`OpenCodeEventParser`, `createOpenCodeEventState`, lignes `OpenCodeSessionRow|MessageRow|PartRow`).
- #408 : `extension/src/opencode-db.ts` (`resolveOpenCodeDbPath`, `openOpenCodeDb`, `OpenCodeDb.poll`, `EMPTY_OPENCODE_CURSORS`).

## Contraintes globales

- Lecture seule de la base, aucun réseau, aucun hook. La base est une entrée non fiable.
- Rien n'est affiché qui ne soit prouvé : permissions en attente, fin de session et texte en streaming ne sont jamais déduits.
- Un test échoue d'abord (rouge), puis le code minimal (vert). Un commit par étape logique, message en français, référence `(#346)`, terminé par `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Pas de modification à la main de `pnpm-lock.yaml`, `web/app/themes.css`, `extension/README.md`, `scripts/.dev-relay.js`.
- Accessibilité WCAG 2.1 AA : ne pas élargir `web/tests-a11y/lint-baseline.json` ni `known-violations.json`.
- Les tests ouvrent les ports 3000 et 3001 : jamais deux suites en parallèle ; si un serveur de dev tourne, préfixer par `unshare -rn sh -c 'ip link set lo up; <cmd>'`.
- Branche depuis `develop`, PR vers `develop`, `Refs #346` (la dernière : `Closes #346`), label `agent:backend-engineer` (les tâches 1 à 3) puis `agent:frontend-engineer` (tâche 4). Jamais de force-push ni de merge soi-même. `gh ... --repo j0hn-42/agent-lens`.

## Points de revue

Entrées que la spec ne teste pas explicitement et qui peuvent casser le watcher ; chacune a son test dans la tâche indiquée.

1. Base absente au démarrage puis créée plus tard : le watcher doit l'attendre et s'attacher, sans exception (tâche 1).
2. `session.time_updated` non mis à jour par l'activité (non vérifié dans OpenCode) : une session racine ancienne mais active doit s'attacher dès qu'un message ou une part arrive (tâche 1).
3. `directory` hostile (caractère de contrôle, chemin relatif, très long) : jamais exposé comme `cwd` ni utilisé pour un rattachement au workspace (tâche 1).
4. Part `tool` `completed` dont la ligne `pending` est antérieure à la fenêtre de démarrage : lire `OpenCodeEventParser.endTool` (`opencode-event-parser.ts:469`) et figer son comportement réel par un test, sans événement de fin orphelin non voulu (tâche 1).
5. Lecture en erreur (base verrouillée) : statut explicite, aucune exception, reprise au tour suivant (tâche 1).
6. `OPENCODE_DB` absolu est accepté tel quel par le lecteur livré (question ouverte 1 de la spec) : à faire relire par `relay-hardening-reviewer` avant la PR du relais (tâche 3).

---

## Tâche 1 : `OpenCodeSessionWatcher`

**Fichiers :**
- Créer : `extension/src/opencode-session-watcher.ts`
- Créer : `extension/test/helpers/opencode-fixture.ts`
- Créer : `extension/test/opencode-session-watcher.test.ts`
- Modifier : `extension/src/constants.ts` (après `PI_MAX_WATCHED_SESSIONS`, ligne 24)

**Interfaces :**
- Consomme : `openOpenCodeDb(file): { status: 'ok'; db } | { status: 'unavailable'; message }`, `OpenCodeDb.poll(cursors): OpenCodePoll`, `EMPTY_OPENCODE_CURSORS`, `resolveOpenCodeDbPath({env, homedir, platform})`, `OpenCodeEventParser`, `createOpenCodeEventState(rootSessionId)`, `AgentSessionWatcher`, `runGuarded`, `isPathInside`, `foldPathCase`.
- Produit : `class OpenCodeSessionWatcher implements AgentSessionWatcher` avec `constructor(workspace?: string | null, options?: OpenCodeWatcherOptions)`, `scanNow(): void`, `status(): string` ; `interface OpenCodeWatcherOptions { dbFile?: string; now?: () => number }` ; `function openCodeDbLocation(): OpenCodeDbPath`.

- [ ] **Étape 1 : constante**

Dans `extension/src/constants.ts`, sous `PI_MAX_WATCHED_SESSIONS = 25` :

```ts
/** Sessions racines OpenCode suivies en même temps ; les plus anciennes sont ignorées au-delà. */
export const OPENCODE_MAX_WATCHED_SESSIONS = 25
```

- [ ] **Étape 2 : helper de base de test**

`extension/test/helpers/opencode-fixture.ts` (même schéma réduit que `opencode-db.test.ts:71`, qui reste inchangé) :

```ts
/** Real node:sqlite database with the OpenCode tables reduced to the columns the reader uses (#346). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

type Db = { exec(sql: string): void; close(): void }
type DbCtor = new (p: string) => Db

export function sqliteAvailable(): boolean {
  try { require('node:sqlite'); return true } catch { return false }
}

export function tmpDir(prefix = 'opencode-watch-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`

export class OpenCodeFixture {
  private readonly db: Db
  constructor(readonly file: string) {
    const Ctor = (require('node:sqlite') as { DatabaseSync: DbCtor }).DatabaseSync
    this.db = new Ctor(file)
    this.db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)')
    this.db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
    this.db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
  }
  session(id: string, o: { parent?: string; dir?: string | null; title?: string; created: number; updated: number; archived?: number }): void {
    this.db.exec(`INSERT OR REPLACE INTO session VALUES (${q(id)}, ${o.parent ? q(o.parent) : 'NULL'}, ${o.dir === null ? 'NULL' : q(o.dir ?? '/w')}, ${q(o.title ?? 'T')}, 'build', ${o.created}, ${o.updated}, ${o.archived ?? 'NULL'})`)
  }
  message(id: string, sessionId: string, t: number, data: object): void {
    this.db.exec(`INSERT OR REPLACE INTO message VALUES (${q(id)}, ${q(sessionId)}, ${t}, ${t}, ${q(JSON.stringify(data))})`)
  }
  part(id: string, messageId: string, sessionId: string, created: number, updated: number, data: object): void {
    this.db.exec(`INSERT OR REPLACE INTO part VALUES (${q(id)}, ${q(messageId)}, ${q(sessionId)}, ${created}, ${updated}, ${q(JSON.stringify(data))})`)
  }
  close(): void { this.db.close() }
}
```

- [ ] **Étape 3 : écrire les tests (rouges)**

`extension/test/opencode-session-watcher.test.ts` :

```ts
/**
 * OpenCodeSessionWatcher (#346): attaches the root sessions of the workspace found in the database,
 * stamps every event with the root session id, releases idle sessions and survives a missing,
 * locked or hostile database. Real node:sqlite databases; skipped where this Node has none.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { OpenCodeSessionWatcher } from '../src/opencode-session-watcher'
import { ACTIVE_SESSION_AGE_S, OPENCODE_MAX_WATCHED_SESSIONS } from '../src/constants'
import type { AgentEvent } from '../src/protocol'
import type { SessionLifecycleEvent } from '../src/session-runtime'
import { OpenCodeFixture, sqliteAvailable, tmpDir } from './helpers/opencode-fixture'

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0)
const userMsg = { role: 'user', time: { created: T0 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } }

let watchers: OpenCodeSessionWatcher[] = []
afterEach(() => { for (const w of watchers) w.dispose(); watchers = [] })

function setup(workspace: string | null = '/w', clock = { t: T0 }) {
  const dir = tmpDir()
  const fx = new OpenCodeFixture(path.join(dir, 'opencode.db'))
  const events: AgentEvent[] = []
  const lifecycle: SessionLifecycleEvent[] = []
  const w = new OpenCodeSessionWatcher(workspace, { dbFile: fx.file, now: () => clock.t })
  watchers.push(w)
  w.onEvent(e => events.push(e))
  w.onSessionLifecycle(l => lifecycle.push(l))
  return { dir, fx, w, events, lifecycle, clock }
}

describe('OpenCodeSessionWatcher', { skip: !sqliteAvailable() }, () => {
  it('attaches a recent root session of the workspace and stamps events with its id', () => {
    const { fx, w, events, lifecycle } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    fx.message('msg_1', 'ses_a', T0 - 900, userMsg)
    fx.part('prt_1', 'msg_1', 'ses_a', T0 - 900, T0 - 900, { type: 'text', text: 'hello' })
    w.start()
    assert.deepEqual(lifecycle.map(l => l.type), ['started'])
    assert.equal(lifecycle[0].sessionId, 'ses_a')
    assert.equal(lifecycle[0].runtime, 'opencode')
    assert.ok(events.some(e => e.type === 'agent_spawn'))
    assert.ok(events.length > 0 && events.every(e => e.sessionId === 'ses_a'))
    assert.deepEqual(w.getActiveSessions().map(s => [s.id, s.runtime, s.status]), [['ses_a', 'opencode', 'active']])
    assert.equal(w.isSessionActive('ses_a'), true)
  })

  it('ignores a session whose directory is outside the workspace', () => {
    const { fx, w, lifecycle } = setup('/w')
    fx.session('ses_x', { dir: '/other', created: T0 - 5000, updated: T0 - 1000 })
    w.start()
    assert.equal(lifecycle.length, 0)
    assert.equal(w.isActive(), false)
  })

  it('attaches an old root session as soon as a message arrives (activity does not bump session.time_updated)', () => {
    const { fx, w, lifecycle, clock } = setup()
    const old = T0 - (ACTIVE_SESSION_AGE_S + 3600) * 1000
    fx.session('ses_old', { created: old, updated: old })
    w.start()
    assert.equal(lifecycle.length, 0)
    clock.t = T0 + 1000
    fx.message('msg_n', 'ses_old', clock.t, userMsg)
    w.scanNow()
    assert.deepEqual(lifecycle.map(l => l.type), ['started'])
  })

  it('does not replay messages older than the activity window', () => {
    const { fx, w, events } = setup()
    fx.session('ses_a', { created: T0 - 9e6, updated: T0 - 1000 })
    fx.message('msg_old', 'ses_a', T0 - (ACTIVE_SESSION_AGE_S + 60) * 1000, { ...userMsg })
    fx.part('prt_old', 'msg_old', 'ses_a', 1, T0 - (ACTIVE_SESSION_AGE_S + 60) * 1000, { type: 'text', text: 'ancien' })
    w.start()
    assert.equal(events.some(e => e.type === 'message' && JSON.stringify(e.payload).includes('ancien')), false)
  })

  it('routes a sub-agent session to the root session and emits no duplicate on a second scan', () => {
    const { fx, w, events } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    fx.session('ses_child', { parent: 'ses_a', created: T0 - 800, updated: T0 - 500, title: 'sub' })
    fx.message('msg_1', 'ses_a', T0 - 900, userMsg)
    w.start()
    const first = events.length
    assert.ok(events.every(e => e.sessionId === 'ses_a'))
    w.scanNow()
    assert.equal(events.length, first)
  })

  it('releases an idle session, then reattaches it on new activity without a second spawn', () => {
    const { fx, w, events, lifecycle, clock } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    fx.message('msg_1', 'ses_a', T0 - 900, userMsg)
    w.start()
    const spawns = () => events.filter(e => e.type === 'agent_spawn' && (e.payload as { isMain?: boolean }).isMain).length
    assert.equal(spawns(), 1)
    clock.t = T0 + (ACTIVE_SESSION_AGE_S + 5) * 1000
    w.scanNow()
    assert.deepEqual(lifecycle.map(l => l.type), ['started', 'ended'])
    assert.equal(w.isActive(), false)
    fx.message('msg_2', 'ses_a', clock.t, { ...userMsg, time: { created: clock.t } })
    w.scanNow()
    assert.deepEqual(lifecycle.map(l => l.type), ['started', 'ended', 'started'])
    assert.equal(spawns(), 1)
  })

  it('ends an archived root session and does not reattach it', () => {
    const { fx, w, lifecycle, clock } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    w.start()
    assert.deepEqual(lifecycle.map(l => l.type), ['started'])
    clock.t = T0 + 1000
    fx.session('ses_a', { created: T0 - 5000, updated: clock.t, archived: clock.t })
    w.scanNow()
    fx.message('msg_1', 'ses_a', clock.t + 1, userMsg)
    w.scanNow()
    assert.deepEqual(lifecycle.map(l => l.type), ['started', 'ended'])
  })

  it('waits for a missing database, reports why, then attaches when it appears', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'opencode.db')
    const lifecycle: SessionLifecycleEvent[] = []
    const w = new OpenCodeSessionWatcher('/w', { dbFile: file, now: () => T0 })
    watchers.push(w)
    w.onSessionLifecycle(l => lifecycle.push(l))
    w.start()
    assert.match(w.status(), /not found/)
    const fx = new OpenCodeFixture(file)
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    w.scanNow()
    assert.deepEqual(lifecycle.map(l => l.type), ['started'])
    assert.doesNotMatch(w.status(), /not found/)
  })

  it('never exposes a hostile directory as cwd, and does not attach it to a workspace', () => {
    const { fx, w } = setup(null)
    fx.session('ses_ctl', { dir: '/w/\u001b[2Jx', created: T0 - 5000, updated: T0 - 1000 })
    fx.session('ses_rel', { dir: '../etc', created: T0 - 5000, updated: T0 - 1000 })
    w.start()
    for (const s of w.getActiveSessions()) assert.equal(s.cwd, undefined)
    const strict = setup('/w')
    strict.fx.session('ses_rel', { dir: '../w', created: T0 - 5000, updated: T0 - 1000 })
    strict.w.start()
    assert.equal(strict.w.isActive(), false)
  })

  it(`follows at most ${OPENCODE_MAX_WATCHED_SESSIONS} root sessions`, () => {
    const { fx, w } = setup()
    for (let i = 0; i < OPENCODE_MAX_WATCHED_SESSIONS + 3; i++) fx.session(`ses_${i}`, { created: T0 - 5000 - i, updated: T0 - 1000 - i })
    w.start()
    assert.equal(w.getActiveSessions().length, OPENCODE_MAX_WATCHED_SESSIONS)
  })

  it('survives a failing poll and recovers on the next one', () => {
    const { fx, w, lifecycle } = setup()
    fx.session('ses_a', { created: T0 - 5000, updated: T0 - 1000 })
    w.start()
    const internal = w as unknown as { db: { poll: (...a: unknown[]) => unknown } }
    const real = internal.db.poll.bind(internal.db)
    internal.db.poll = () => ({ sessions: [], messages: [], parts: [], skippedRows: 0, truncated: false, cursors: undefined, error: 'database is locked' })
    assert.doesNotThrow(() => w.scanNow())
    assert.match(w.status(), /locked/)
    internal.db.poll = real
    fx.message('msg_1', 'ses_a', T0 - 500, userMsg)
    w.scanNow()
    assert.doesNotMatch(w.status(), /locked/)
    assert.equal(lifecycle.length, 1)
  })
})
```

Ajouter ensuite le test du point de revue 4 : lire `opencode-event-parser.ts:469-520`, puis ajouter dans le même `describe` un cas qui insère une part `tool` `completed` (`{ type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'x', time: { start: 1, end: 2 } } }`) dont `time_created` précède la fenêtre et dont `time_updated` est récent, et qui affirme exactement ce que le parseur fait (soit aucun `tool_call_end`, soit un `tool_call_end` sans `tool_call_start`) : le test fige le comportement réel et la décision est notée dans le message de commit.

- [ ] **Étape 4 : vérifier qu'ils échouent**

Run : `pnpm --dir extension exec tsx --test test/opencode-session-watcher.test.ts`
Attendu : échec, `Cannot find module '../src/opencode-session-watcher'`.

- [ ] **Étape 5 : implémenter le watcher**

`extension/src/opencode-session-watcher.ts` :

```ts
/**
 * Watches the local OpenCode database (#346).
 *
 * OpenCode keeps every session in one SQLite file (see opencode-db.ts). This watcher polls it
 * read-only, groups rows by root session (a sub-agent is a child session, `parent_id`) and gives
 * each root one OpenCodeEventParser. Events carry the root session id.
 *
 * A root session is attached when its row is recent, or as soon as a message or part of it arrives
 * (activity is proved by the rows, not by `session.time_updated`). It is released after
 * ACTIVE_SESSION_AGE_S without rows, or when archived. No end is observed for this runtime: silence
 * never completes a session. The first poll reads every session row (cheap, one per session) but
 * only messages and parts newer than the activity window: history is not replayed.
 *
 * Every timer callback runs through runGuarded: in the relay an uncaught exception ends the process.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentEvent, SessionInfo } from './protocol'
import { ACTIVE_SESSION_AGE_S, OPENCODE_MAX_WATCHED_SESSIONS, PREVIEW_MAX, SCAN_INTERVAL_MS, SESSION_ID_DISPLAY } from './constants'
import { foldPathCase, isPathInside, runGuarded } from './fs-utils'
import { createLogger } from './logger'
import { ostr } from './event-normalize'
import {
  openOpenCodeDb, resolveOpenCodeDbPath,
  type OpenCodeCursors, type OpenCodeDb, type OpenCodeDbPath, type OpenCodePoll, type OpenCodeSessionRead,
} from './opencode-db'
import { OpenCodeEventParser, createOpenCodeEventState, type OpenCodeEventState } from './opencode-event-parser'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'
import { TypedEventEmitter } from './typed-event-emitter'

const log = createLogger('OpenCodeSessionWatcher')

const OPENCODE_LABEL_PREFIX = 'OpenCode '
/** Session rows remembered (id → row) to find the root of a message or a child. */
const KNOWN_MAX = 5000
/** Polls chained while the reader reports more rows waiting. */
const CATCHUP_POLLS_MAX = 20
/** Longest parent chain followed to find a root (a longer or cyclic chain has no root). */
const ROOT_HOPS_MAX = 16
const CWD_MAX = 4096
/** Control characters (C0, DEL, C1) and bidi overrides: never part of a path shown to the user. */
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/

export interface OpenCodeWatcherOptions {
  /** Database file to read; default: resolved from the process environment (opencode-db.ts). */
  dbFile?: string
  /** Clock, for tests. */
  now?: () => number
}

/** Where the database is expected on this machine. */
export function openCodeDbLocation(): OpenCodeDbPath {
  return resolveOpenCodeDbPath({ env: process.env, homedir: os.homedir(), platform: process.platform })
}

interface WatchedOpenCodeSession {
  sessionId: string
  cwd?: string
  sessionStartTime: number
  lastActivityTime: number
  detected: boolean
  label: string
  state: OpenCodeEventState
  parser: OpenCodeEventParser
}

type RetiredOpenCodeSession = Pick<WatchedOpenCodeSession, 'state' | 'parser' | 'sessionStartTime' | 'label'>

const isArchived = (row: OpenCodeSessionRead): boolean => typeof row.time_archived === 'number'

export class OpenCodeSessionWatcher implements AgentSessionWatcher {
  private db: OpenCodeDb | null = null
  private cursors: OpenCodeCursors = { session: { time: 0, seen: [] }, message: { time: 0, seen: [] }, part: { time: 0, seen: [] } }
  private sessions = new Map<string, WatchedOpenCodeSession>()
  private retired = new Map<string, RetiredOpenCodeSession>()
  private known = new Map<string, OpenCodeSessionRead>()
  private workspacePath: string | null = null
  private scanInterval: NodeJS.Timeout | null = null
  private statusText = 'OpenCode: not started'
  /** Status shown while the database reads fine (set when it is opened). */
  private okText = ''
  private lastLogged = ''
  private capWarned = false

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new TypedEventEmitter<string>()
  private readonly _onSessionLifecycle = new TypedEventEmitter<SessionLifecycleEvent>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  /** Workspace path used as a filter: a root session is attached only if its directory is this path
   *  or inside it. Pass null/undefined to attach to any OpenCode session. */
  constructor(private readonly workspace?: string | null, private readonly options: OpenCodeWatcherOptions = {}) {}

  private now(): number { return this.options.now ? this.options.now() : Date.now() }

  /** Human-readable state of the database connection, for the connection status. */
  status(): string { return this.statusText }

  isActive(): boolean {
    for (const s of this.sessions.values()) if (s.detected) return true
    return false
  }

  isSessionActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.detected === true
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.sessionId,
      label: s.label,
      // No end is observed for this runtime: a silence never completes a session
      status: 'active',
      startTime: s.sessionStartTime,
      lastActivityTime: s.lastActivityTime,
      runtime: 'opencode',
      ...(s.cwd ? { cwd: s.cwd } : {}),
    }))
  }

  replaySessionStart(sessionIds?: string[]): void {
    for (const [id, session] of this.sessions) {
      if (!session.detected) continue
      if (sessionIds && !sessionIds.includes(id)) continue
      this._onSessionLifecycle.fire(this.lifecycle('started', session))
    }
  }

  start(): void {
    if (this.workspace) {
      try { this.workspacePath = fs.realpathSync(this.workspace) }
      catch { this.workspacePath = this.workspace }
    }
    const since = this.now() - ACTIVE_SESSION_AGE_S * 1000
    this.cursors = {
      session: { time: 0, seen: [] },
      message: { time: since, seen: [] },
      part: { time: since, seen: [] },
    }
    this.scanNow()
    this.scanInterval = setInterval(() => this.scanNow(), SCAN_INTERVAL_MS)
  }

  /** One poll of the database and one release pass; also the timer callback. Never throws. */
  scanNow(): void {
    runGuarded(() => {
      if (!this.ensureDb()) return
      this.pollDb()
      this.releaseEndedSessions()
    }, err => log.warn('Scan OpenCode en échec :', err))
  }

  private setStatus(text: string): void {
    this.statusText = text
    if (text !== this.lastLogged) { this.lastLogged = text; log.info(text) }
  }

  private ensureDb(): boolean {
    if (this.db) return true
    let file: string
    if (this.options.dbFile) file = this.options.dbFile
    else {
      const location = openCodeDbLocation()
      if (location.kind === 'unavailable') { this.setStatus(location.message); return false }
      file = location.path
    }
    const opened = openOpenCodeDb(file)
    if (opened.status === 'unavailable') { this.setStatus(opened.message); return false }
    this.db = opened.db
    this.okText = `OpenCode database (${file.replace(os.homedir(), '~')})`
    this.setStatus(this.okText)
    return true
  }

  private pollDb(): void {
    const db = this.db
    if (!db) return
    for (let i = 0; i < CATCHUP_POLLS_MAX; i++) {
      const poll = db.poll(this.cursors)
      if (poll.error) { this.setStatus(`OpenCode: ${poll.error}`); return }
      this.cursors = poll.cursors
      this.deliver(poll)
      if (!poll.truncated) { this.setStatus(this.okText); return }
    }
  }

  private deliver(poll: OpenCodePoll): void {
    const rows = [...poll.sessions].sort((a, b) => a.time_created - b.time_created)
    for (const row of rows) this.remember(row)
    for (const row of rows) this.onSessionRow(row)
    for (const m of poll.messages) {
      const s = this.sessionFor(m.session_id)
      if (!s) continue
      s.lastActivityTime = this.now()
      try { s.parser.processMessage(m, s.state) } catch (err) { log.debug('Parser threw on message:', err) }
    }
    for (const p of poll.parts) {
      const s = this.sessionFor(p.session_id)
      if (!s) continue
      s.lastActivityTime = this.now()
      try { s.parser.processPart(p, s.state) } catch (err) { log.debug('Parser threw on part:', err) }
    }
  }

  private remember(row: OpenCodeSessionRead): void {
    this.known.delete(row.id)
    this.known.set(row.id, row)
    if (this.known.size > KNOWN_MAX) {
      const oldest = this.known.keys().next().value
      if (oldest !== undefined) this.known.delete(oldest)
    }
  }

  private rootOf(id: string): string | undefined {
    let cur = id
    for (let i = 0; i < ROOT_HOPS_MAX; i++) {
      const row = this.known.get(cur)
      if (!row) return undefined
      if (!row.parent_id) return cur
      cur = row.parent_id
    }
    return undefined
  }

  private isRecent(row: OpenCodeSessionRead): boolean {
    return (this.now() - row.time_updated) / 1000 <= ACTIVE_SESSION_AGE_S
  }

  private onSessionRow(row: OpenCodeSessionRead): void {
    const rootId = this.rootOf(row.id)
    if (!rootId) return
    const attached = this.sessions.get(rootId)
    if (rootId !== row.id) {
      if (attached) this.processSession(attached, row)
      return
    }
    if (isArchived(row)) {
      if (attached) this.release(rootId, attached)
      return
    }
    if (attached) {
      attached.lastActivityTime = this.now()
      this.processSession(attached, row)
    } else if (this.isRecent(row)) {
      this.attach(row)
    }
  }

  private processSession(s: WatchedOpenCodeSession, row: OpenCodeSessionRead): void {
    try { s.parser.processSession(row, s.state) } catch (err) { log.debug('Parser threw on session:', err) }
  }

  /** The attached root session of a message or part, attaching it on first activity. */
  private sessionFor(sessionId: string): WatchedOpenCodeSession | undefined {
    const rootId = this.rootOf(sessionId)
    if (!rootId) return undefined
    const attached = this.sessions.get(rootId)
    if (attached) return attached
    const row = this.known.get(rootId)
    if (!row || isArchived(row)) return undefined
    return this.attach(row)
  }

  private safeDirectory(directory: string | null): string | undefined {
    if (!directory || directory.length > CWD_MAX || UNSAFE_PATH_CHARS.test(directory)) return undefined
    return path.isAbsolute(directory) ? directory : undefined
  }

  private matchesWorkspace(directory: string | undefined): boolean {
    if (!this.workspacePath) return true
    if (!directory) return false
    let resolved = directory
    try { resolved = fs.realpathSync(directory) } catch { /* a directory that no longer exists keeps its path */ }
    return isPathInside(foldPathCase(resolved), foldPathCase(this.workspacePath))
  }

  private attach(row: OpenCodeSessionRead): WatchedOpenCodeSession | undefined {
    const sessionId = row.id
    const cwd = this.safeDirectory(row.directory)
    if (!this.matchesWorkspace(cwd)) return undefined
    if (this.sessions.size >= OPENCODE_MAX_WATCHED_SESSIONS) {
      if (!this.capWarned) {
        this.capWarned = true
        log.warn(`Plafond de ${OPENCODE_MAX_WATCHED_SESSIONS} sessions OpenCode suivies atteint : les suivantes sont ignorées.`)
      }
      return undefined
    }

    const retired = this.retired.get(sessionId)
    const state = retired?.state ?? createOpenCodeEventState(sessionId)
    const parser = retired?.parser ?? this.newParser(sessionId)
    const session: WatchedOpenCodeSession = {
      sessionId,
      ...(cwd ? { cwd } : {}),
      sessionStartTime: retired?.sessionStartTime ?? row.time_created,
      lastActivityTime: this.now(),
      detected: false,
      label: retired?.label ?? `${OPENCODE_LABEL_PREFIX}${sessionId.slice(0, SESSION_ID_DISPLAY)}`,
      state,
      parser,
    }
    this.retired.delete(sessionId)
    this.sessions.set(sessionId, session)

    if (!retired) {
      this.processSession(session, row)
      // Children already seen while the root was not attached
      const children = [...this.known.values()]
        .filter(r => r.id !== sessionId && this.rootOf(r.id) === sessionId)
        .sort((a, b) => a.time_created - b.time_created)
      for (const child of children) this.processSession(session, child)
    }

    session.detected = true
    this._onSessionDetected.fire(sessionId)
    this._onSessionLifecycle.fire(this.lifecycle('started', session))
    log.info(`Attached to OpenCode session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`)
    return session
  }

  private newParser(sessionId: string): OpenCodeEventParser {
    return new OpenCodeEventParser({
      emit: event => this._onEvent.fire({ ...event, sessionId }),
      elapsed: () => {
        const s = this.sessions.get(sessionId)
        return s ? (this.now() - s.sessionStartTime) / 1000 : 0
      },
      setLabel: raw => {
        const s = this.sessions.get(sessionId)
        const label = ostr(raw, PREVIEW_MAX)?.trim()
        if (!s || !label) return
        s.label = label
        if (s.detected) this._onSessionLifecycle.fire({ type: 'updated', sessionId, label })
      },
    })
  }

  private lifecycle(type: SessionLifecycleEvent['type'], s: WatchedOpenCodeSession): SessionLifecycleEvent {
    return { type, sessionId: s.sessionId, label: s.label, runtime: 'opencode', ...(s.cwd ? { cwd: s.cwd } : {}) }
  }

  /** Stop following a session and keep its parser state for a later reattach. */
  private release(id: string, s: WatchedOpenCodeSession): void {
    this.sessions.delete(id)
    this.retired.delete(id)
    this.retired.set(id, { state: s.state, parser: s.parser, sessionStartTime: s.sessionStartTime, label: s.label })
    if (this.retired.size > OPENCODE_MAX_WATCHED_SESSIONS * 4) {
      const oldest = this.retired.keys().next().value
      if (oldest !== undefined) this.retired.delete(oldest)
    }
    if (s.detected) this._onSessionLifecycle.fire({ type: 'ended', sessionId: id, label: s.label })
  }

  /** Release sessions silent for more than ACTIVE_SESSION_AGE_S. New rows reattach them. */
  private releaseEndedSessions(): void {
    const now = this.now()
    for (const [id, s] of this.sessions) {
      if ((now - s.lastActivityTime) / 1000 <= ACTIVE_SESSION_AGE_S) continue
      this.release(id, s)
      log.debug(`Session ${id.slice(0, SESSION_ID_DISPLAY)} libérée`)
    }
  }

  dispose(): void {
    if (this.scanInterval) { clearInterval(this.scanInterval); this.scanInterval = null }
    this.db?.close()
    this.db = null
    this.sessions.clear()
    this.retired.clear()
    this.known.clear()
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
```

- [ ] **Étape 6 : vérifier qu'ils passent**

Run : `pnpm --dir extension exec tsx --test test/opencode-session-watcher.test.ts`
Attendu : tous verts. Si un cas échoue parce que la fixture ne correspond pas à ce que le parseur attend (forme de `data` d'un message ou d'une part), corriger la fixture d'après `opencode-event-parser.ts`, pas le watcher.

- [ ] **Étape 7 : typecheck et suite de l'extension**

Run : `pnpm --filter agent-lens run lint && pnpm --filter agent-lens run lint:test && pnpm --dir extension test`
Attendu : sans erreur.

- [ ] **Étape 8 : commit**

```bash
git add extension/src/constants.ts extension/src/opencode-session-watcher.ts extension/test/helpers/opencode-fixture.ts extension/test/opencode-session-watcher.test.ts
git commit -m "feat(opencode): watcher des sessions OpenCode (#346)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

PR : `Refs #346`, label `agent:backend-engineer`.

---

## Tâche 2 : runtime de l'extension

**Fichiers :**
- Créer : `extension/src/opencode-runtime.ts`
- Créer : `scripts/runtime-union.test.ts`
- Modifier : `extension/src/session-runtime.ts:18`, `extension/src/extension.ts:26,60-63,89,188`, `extension/src/observations.ts:26,93,267`, `extension/package.json:4,17,67-74`, `scripts/mcp/server.ts:127`

**Interfaces :**
- Consomme : `OpenCodeSessionWatcher`, `openCodeDbLocation` (tâche 1), `wireWatcherToPanel`.
- Produit : `startOpenCodeRuntime(context: vscode.ExtensionContext): AgentRuntime` (`mode: 'opencode'`).

- [ ] **Étape 1 : test de garde (rouge)**

`scripts/runtime-union.test.ts` : tout fichier de la liste qui nomme `gemini` doit nommer `opencode` (une union recopiée sans le nouveau runtime est un bug silencieux). La liste grandit aux tâches 3 et 4.

```ts
// #346: every closed list of runtimes names OpenCode too (a copy that forgets it hides the runtime silently).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..')

/** Files that copy the closed list of runtimes; each one that names gemini must name opencode. */
const RUNTIME_LIST_FILES = [
  'extension/src/session-runtime.ts',
  'extension/src/extension.ts',
  'extension/src/observations.ts',
  'extension/package.json',
  'scripts/mcp/server.ts',
]

for (const file of RUNTIME_LIST_FILES) {
  test(`${file}: names opencode wherever it names gemini`, () => {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    assert.ok(/gemini/i.test(text), `${file} no longer names gemini: update RUNTIME_LIST_FILES`)
    assert.match(text, /opencode/i, `${file} lists runtimes but not opencode`)
  })
}
```

Run : `pnpm exec tsx --test scripts/runtime-union.test.ts` (depuis la racine). Attendu : 5 échecs.

- [ ] **Étape 2 : unions et modes**

- `session-runtime.ts:18` : `export type AgentRuntimeMode = 'claude' | 'codex' | 'copilot' | 'pi' | 'gemini' | 'opencode'`.
- `observations.ts:26` : ajouter `| 'opencode'` à l'union ; `:93` : ajouter `'opencode'` à l'`enum` ; `:267` : ajouter `|| s.runtime === 'opencode'`.
- `scripts/mcp/server.ts:127` : ajouter `'opencode'` au tableau.
- `extension/package.json` : `description` (ligne 4) et `keywords` (ligne 17) citent OpenCode ; l'enum `agentVisualizer.runtime` (ligne 67) gagne `"opencode"`, avec son libellé « Watch only OpenCode sessions » dans `enumDescriptions` et OpenCode ajouté à la description de `auto`.

- [ ] **Étape 3 : runtime**

`extension/src/opencode-runtime.ts` :

```ts
/**
 * OpenCode runtime (#346).
 *
 * OpenCode has no hook mechanism this extension uses: its only event source is its SQLite database,
 * read-only. This runtime wires OpenCodeSessionWatcher to the visualizer panel and reports a
 * connection status that says whether the database was found.
 */

import * as vscode from 'vscode'
import { OpenCodeSessionWatcher } from './opencode-session-watcher'
import { createLogger } from './logger'
import { wireWatcherToPanel } from './session-runtime'
import type { AgentRuntime } from './session-runtime'

const log = createLogger('OpenCodeRuntime')

export function startOpenCodeRuntime(context: vscode.ExtensionContext): AgentRuntime {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
  const watcher = new OpenCodeSessionWatcher(workspace)
  context.subscriptions.push(watcher)

  const wiring = wireWatcherToPanel(watcher, {
    sessionLabelPrefix: 'OpenCode',
  })

  watcher.start()

  const connectionStatus = (): string => watcher.status()

  const dispose = (): void => { wiring.dispose(); watcher.dispose() }

  log.info(`OpenCode runtime started (${watcher.status()})`)

  return { mode: 'opencode', watcher, connectionStatus, dispose }
}
```

- [ ] **Étape 4 : extension.ts**

- Ligne 9 : `import { startOpenCodeRuntime } from './opencode-runtime'`.
- Ligne 26 : ajouter `|| raw === 'opencode'`.
- Après le bloc Gemini (lignes 60-63), même forme :

```ts
  if (mode === 'opencode' || mode === 'auto') {
    log.info('Starting OpenCode runtime...')
    try { runtimes.push(startOpenCodeRuntime(context)) }
    catch (err) { log.error('OpenCode runtime failed to start:', err); failures.push('opencode') }
  }
```

- Lignes 89 et 188 : ajouter OpenCode à la liste des commentaires (« Claude, Codex, Copilot, Pi, Gemini CLI or OpenCode »).

- [ ] **Étape 5 : vérifier**

Run : `pnpm exec tsx --test scripts/runtime-union.test.ts && pnpm --filter agent-lens run lint && pnpm --dir extension test`
Attendu : tout vert.

- [ ] **Étape 6 : commit**

```bash
git add extension/src scripts/mcp/server.ts scripts/runtime-union.test.ts extension/package.json
git commit -m "feat(opencode): runtime OpenCode dans l'extension (#346)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

PR : `Refs #346`, `agent:backend-engineer`.

---

## Tâche 3 : relais

**Fichiers :**
- Modifier : `scripts/relay.ts:22,688,778,780,866-867,1013-1023,1069,1073,1138,1285,1373,1399`
- Créer : `scripts/relay-opencode-fixture.ts`, `scripts/relay-opencode.test.ts`
- Modifier : `scripts/runtime-union.test.ts` (ajouter `scripts/relay.ts` à `RUNTIME_LIST_FILES`)

**Interfaces :**
- Consomme : `OpenCodeSessionWatcher`, `RelayRuntimeMode`, `createRelay`.
- Produit : mode `'opencode'` accepté par `resolveRuntimeMode` et `AGENT_LENS_RUNTIME=opencode`, drapeau `wantOpenCode`, `/status` qui liste `opencode`.

- [ ] **Étape 1 : lire les modèles**

Lire `scripts/relay-gemini.test.ts` en entier et `scripts/relay-gemini-fixture.ts` : le nouveau test en reprend la structure (un fichier par test, `createRelay` n'étant appelé qu'une fois par processus), avec une base SQLite temporaire et `dbFile` remplacé par `OPENCODE_DB` (chemin absolu, lu par `openCodeDbLocation`).

- [ ] **Étape 2 : test (rouge)**

`scripts/relay-opencode.test.ts` : démarrer le relais avec `runtime: 'opencode'` et `OPENCODE_DB=<base temporaire contenant une session racine récente du workspace>`, puis vérifier, comme le test Gemini, que `/status` ne liste que `opencode`, compte la session et que `dispose` libère le watcher (`OpenCodeSessionWatcher.prototype.dispose` observé par `mock.method`). Réutiliser `OpenCodeFixture` de `extension/test/helpers/opencode-fixture.ts`. Ajouter un second test dans `scripts/relay-opencode-env.test.ts` : `AGENT_LENS_RUNTIME=opencode` est résolu par `resolveRuntimeMode`, et une base absente donne un `/status` valide avec la session à zéro (pas de crash).

Run : `pnpm exec tsx --test scripts/relay-opencode.test.ts` ; attendu : échec (mode inconnu).

- [ ] **Étape 3 : câblage**

Dans `scripts/relay.ts`, pour chaque occurrence listée de `gemini`, ajouter `opencode` de la même manière :
- ligne 22 : `import { OpenCodeSessionWatcher } from '../extension/src/opencode-session-watcher'` ;
- 688, 778, 780 : union `RelayRuntimeMode` et `resolveRuntimeMode` ;
- 866-867 : `const wantOpenCode = mode === 'opencode' || mode === 'auto'` et le journal ;
- après 1013-1023, bloc identique à Gemini :

```ts
  // ─── OpenCode runtime ─────────────────────────────────────────────────────
  // Watch OpenCode sessions (SQLite database, read-only, #346), matched to the workspace directory.
  let openCodeWatcher: OpenCodeSessionWatcher | null = null
  if (wantOpenCode) {
    openCodeWatcher = new OpenCodeSessionWatcher(workspace)
    openCodeWatcher.onEvent((event) => broadcastEvent(event))
    openCodeWatcher.onSessionLifecycle((lifecycle) => {
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label)
    })
    openCodeWatcher.start()
  }
```

- 1069, 1138, 1285 : `if (openCodeWatcher) list.push(...openCodeWatcher.getActiveSessions())` (et le compte, et la liste de sessions) ;
- 1073, 1373 : `wantOpenCode && 'opencode'` dans les listes de runtimes ;
- 1399 : `openCodeWatcher?.dispose()`.

Ajouter `scripts/relay.ts` à `RUNTIME_LIST_FILES`.

- [ ] **Étape 4 : vérifier**

Run : `pnpm exec tsx --test scripts/relay-opencode.test.ts scripts/relay-opencode-env.test.ts scripts/runtime-union.test.ts`, puis `pnpm run lint:scripts`, puis `pnpm test` (suite complète, seule, sans autre suite en parallèle).
Attendu : tout vert.

- [ ] **Étape 5 : revue sécurité avant la PR**

Lancer l'agent `relay-hardening-reviewer` sur le diff (`git diff develop...HEAD`), avec la consigne : valider ou durcir l'acceptation d'un `OPENCODE_DB` absolu tel quel par le lecteur livré (#408) : fichier ordinaire, aucun chemin renvoyé au client web, `/status` et SSE ne contiennent ni le chemin ni le message d'erreur brut de SQLite. Corriger ce qu'il relève avant la PR, avec un test par correction.

- [ ] **Étape 6 : commit**

```bash
git add scripts extension
git commit -m "feat(opencode): runtime OpenCode dans le relais (#346)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

PR : `Refs #346`, `agent:backend-engineer`.

---

## Tâche 4 : web et documentation

**Fichiers :**
- Modifier (union `'opencode'`) : `web/lib/agent-types.ts:92`, `web/lib/bridge-types.ts:40,206`, `web/lib/chrome-utils.ts:111,199,453`, `web/lib/session-filter.ts:8,47`, `web/lib/ui-preferences.ts:51,85`, `web/lib/legend-presence.ts:84`, `web/hooks/simulation/handle-agent-events.ts:61`, `web/components/agent-visualizer/conversation-panel.tsx:667`, `canvas/draw-bubbles.ts:48`, `canvas/draw-agents.ts:135`, `canvas/cluster-model.ts:26,287`, `canvas/a11y-model.ts:350`
- Créer : `scripts/opencode-web.test.ts`
- Modifier : `scripts/runtime-union.test.ts` (ajouter les fichiers web ci-dessus), `web/lib/theme-tokens.json` (si une couleur de runtime est nécessaire) puis `pnpm run gen:themes`
- Docs : `README.md`, `docs/reading-the-ui.md`, `docs/relay-sources.md`

**Interfaces :**
- Consomme : `SessionInfo['runtime']` étendu côté `bridge-types.ts`.
- Produit : badge `{ short: 'OC', label: 'OpenCode' }`, option de filtre `'opencode'`, clé de légende `rt-opencode`, marque canvas `drawOpenCodeMark`.

- [ ] **Étape 1 : tests (rouges)**

`scripts/opencode-web.test.ts` :

```ts
// #346: the web side knows the OpenCode runtime (badge, session filter, session validation).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { runtimeBadge } from '../web/lib/chrome-utils'
import { runtimeOptions } from '../web/lib/session-filter'
import { isSessionInfo } from '../web/lib/bridge-types'

const base = { id: 's', label: 'l', status: 'active', startTime: 1, lastActivityTime: 2 }

test('runtimeBadge: OpenCode has a visible short tag and a full name', () => {
  assert.deepEqual(runtimeBadge('opencode'), { short: 'OC', label: 'OpenCode' })
})

test('runtimeOptions lists opencode when a session uses it', () => {
  assert.deepEqual(runtimeOptions([{ runtime: 'opencode' }, { runtime: 'claude' }]), ['claude', 'opencode'])
})

test('isSessionInfo accepts runtime opencode and still refuses an unknown runtime', () => {
  assert.equal(isSessionInfo({ ...base, runtime: 'opencode' }), true)
  assert.equal(isSessionInfo({ ...base, runtime: 'nope' }), false)
})
```

Ajouter dans `scripts/runtime-union.test.ts` les fichiers web de la liste ci-dessus. Run : `pnpm exec tsx --test scripts/opencode-web.test.ts scripts/runtime-union.test.ts` ; attendu : échecs.

- [ ] **Étape 2 : unions et libellés**

Pour chaque emplacement listé, ajouter `'opencode'` à l'union, à l'alternation de comparaisons ou au tableau, dans l'ordre `…'pi', 'gemini', 'opencode'`. Libellés :
- `chrome-utils.ts:111`, sous la ligne Gemini : `if (runtime === 'opencode') return { short: 'OC', label: 'OpenCode' }` ;
- `draw-bubbles.ts:48`, `cluster-model.ts:287`, `a11y-model.ts:350` : libellé `OpenCode` (ou `OPENCODE` là où les autres sont en capitales) ;
- `legend-presence.ts:84` : clé `rt-opencode`, avec son libellé de légende ;
- `conversation-panel.tsx:667` : lire la condition `runtime === 'gemini'` et décider si elle s'applique aussi à OpenCode ; ne l'étendre que si la raison (affichage de l'assistant) est la même.

- [ ] **Étape 3 : marque canvas et couleur**

Lire `drawGeminiMark` et `drawPiMark` dans `draw-agents.ts:85-110`, puis ajouter `drawOpenCodeMark` (même signature, un glyphe simple distinct) et la branche à la ligne 135. La couleur vient d'un jeton de thème existant ou d'un nouveau jeton dans `web/lib/theme-tokens.json` (puis `pnpm run gen:themes`, jamais d'édition de `themes.css`). Le contraste doit atteindre AA dans chaque thème et le runtime ne doit pas reposer sur la seule couleur (le badge `OC` et le nom accessible portent l'information).

- [ ] **Étape 4 : vérifier**

Run, une suite à la fois : `pnpm exec tsx --test scripts/opencode-web.test.ts scripts/runtime-union.test.ts`, `pnpm --dir web exec tsc --noEmit`, `pnpm --dir web run lint:a11y`, `pnpm run test:a11y`, `pnpm run gen:themes && pnpm exec tsx --test scripts/theme-tokens.test.ts`. Attendu : vert, sans toucher aux fichiers de base a11y. Puisque la PR change du rendu (badge, marque), lancer aussi `pnpm --dir web run test:e2e`.

- [ ] **Étape 5 : documentation**

- `README.md` : OpenCode dans la liste des agents pris en charge (lignes citant Pi et Gemini CLI).
- `docs/reading-the-ui.md` : section « Sessions OpenCode » sur le modèle de « Gemini CLI sessions », avec les limites : pas de permission en attente, pas de fin de session (silence ≠ fin), texte en cours de streaming absent, Linux et macOS seulement (Windows : non résolu, `OPENCODE_DB` absolu possible).
- `docs/relay-sources.md` : OpenCode lit une base SQLite en lecture seule, sans hook ; `AGENT_LENS_RUNTIME=opencode`.

Run : `pnpm exec tsx --test scripts/docs.test.ts scripts/ui-glossary.test.ts`. Attendu : vert.

- [ ] **Étape 6 : revue a11y, puis commit**

Lancer l'agent `a11y-reviewer` sur le diff web et corriger ses retours.

```bash
git add web scripts docs README.md
git commit -m "feat(opencode): OpenCode dans l'interface et la documentation (#346)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

PR : `Closes #346`, `agent:frontend-engineer`.

---

## Vérification finale (avant la dernière PR)

Lancer le skill `run-checks` sur la branche, puis, avec une vraie installation d'OpenCode si elle est disponible, ouvrir une session et constater que Agent Lens la montre. Sans installation, le dire explicitement dans la PR : les fixtures viennent du code source v1.19.0, pas de sessions réelles (risque de la spec).
