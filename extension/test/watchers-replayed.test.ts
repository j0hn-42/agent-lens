/**
 * Issue #390 : l'historique lu à l'attache par les watchers Codex, Copilot, Pi et Gemini est marqué
 * `replayed` (comme celui d'un transcript Claude, #361) ; une ligne ajoutée ensuite ne l'est pas.
 */
import './helpers/alias-vscode'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexSessionWatcher } from '../src/codex-session-watcher'
import { CopilotSessionWatcher } from '../src/copilot-session-watcher'
import { PiSessionWatcher } from '../src/pi-session-watcher'
import { GeminiSessionWatcher } from '../src/gemini-session-watcher'
import { geminiProjectHash } from '../src/gemini-event-parser'
import type { AgentEvent } from '../src/protocol'

interface Harness {
  /** Creates the session on disk with a first message, returns the file to append to */
  setup(ws: string, home: string): string
  make(ws: string): { start(): void; dispose(): void; onEvent: (l: (e: AgentEvent) => void) => unknown }
  /** A line appended after the attach */
  later: string
  restore(): void
}

const uuid = '00000000-0000-4000-8000-000000000001'
const j = (o: unknown) => JSON.stringify(o) + '\n'

function env(key: string, value: string): () => void {
  const prev = process.env[key]
  process.env[key] = value
  return () => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev }
}

const codexMsg = (text: string) => j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })

const harnesses: Record<string, () => Harness> = {
  codex: () => {
    let restore = () => {}
    return {
      later: codexMsg('later line'),
      setup(ws, home) {
        restore = env('CODEX_HOME', home)
        const now = new Date()
        const dir = path.join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `rollout-2026-10-08T09-00-00-${uuid}.jsonl`)
        fs.writeFileSync(file, j({ type: 'session_meta', payload: { cwd: ws } }) + codexMsg('history line'))
        return file
      },
      make: (ws) => new CodexSessionWatcher(ws),
      restore: () => restore(),
    }
  },
  copilot: () => {
    let restore = () => {}
    const line = (type: string, data: object, id: string) => j({ type, data, id })
    return {
      later: line('assistant.message', { messageId: 'm2', content: 'later line' }, 'e9'),
      setup(ws, home) {
        restore = env('COPILOT_HOME', home)
        const dir = path.join(home, 'session-state', uuid)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'workspace.yaml'), `cwd: ${ws}\n`)
        const file = path.join(dir, 'events.jsonl')
        fs.writeFileSync(file, line('session.start', { selectedModel: 'gpt-5', context: { cwd: ws } }, 'e1') + line('user.message', { content: 'history line' }, 'e2'))
        return file
      },
      make: (ws) => new CopilotSessionWatcher(ws),
      restore: () => restore(),
    }
  },
  pi: () => {
    let restore = () => {}
    const msg = (id: string, content: string) => j({ type: 'message', id, parentId: null, timestamp: '2026-10-12T09:00:01.000Z', message: { role: 'user', content, timestamp: 1 } })
    return {
      later: msg('u2', 'later line'),
      setup(ws, home) {
        restore = env('PI_CODING_AGENT_DIR', home)
        const dir = path.join(home, 'sessions', '--p--')
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `2026-10-12T09-00-00-000Z_${uuid}.jsonl`)
        fs.writeFileSync(file, j({ type: 'session', version: 3, id: 'x', timestamp: '2026-01-05T09:00:00.000Z', cwd: ws }) + msg('u1', 'history line'))
        return file
      },
      make: (ws) => new PiSessionWatcher(ws),
      restore: () => restore(),
    }
  },
  gemini: () => {
    let restore = () => {}
    const msg = (id: string, content: string) => j({ id, timestamp: '2026-10-12T09:00:01.000Z', type: 'user', content })
    return {
      later: msg('u2', 'later line'),
      setup(ws, home) {
        restore = env('GEMINI_CLI_HOME', home)
        const dir = path.join(home, '.gemini', 'tmp', 'slug', 'chats')
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, 'session-2026-10-12T09-00-0001.jsonl')
        fs.writeFileSync(file, j({ sessionId: uuid, projectHash: geminiProjectHash(ws), startTime: '2026-01-05T09:00:00.000Z', lastUpdated: '2026-01-05T09:00:00.000Z' }) + msg('u1', 'history line'))
        return file
      },
      make: (ws) => new GeminiSessionWatcher(ws),
      restore: () => restore(),
    }
  },
}

describe('historique des watchers non-Claude marqué replayed (#390)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { while (cleanups.length) cleanups.pop()!() })

  for (const [name, build] of Object.entries(harnesses)) {
    it(`${name} : tout événement lu à l'attache porte replayed, la ligne suivante non`, async () => {
      const h = build()
      const home = fs.mkdtempSync(path.join(os.tmpdir(), `af-replayed-${name}-home-`))
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `af-replayed-${name}-ws-`)))
      cleanups.push(() => { h.restore(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }) })
      const file = h.setup(ws, home)
      const watcher = h.make(ws)
      cleanups.push(() => watcher.dispose())
      const events: AgentEvent[] = []
      watcher.onEvent(e => events.push(e))
      watcher.start()

      assert.ok(events.some(e => e.type === 'message'), 'le message de l\'historique est lu')
      for (const e of events) assert.equal(e.replayed, true, `${e.type} de l'historique`)

      const before = events.length
      fs.appendFileSync(file, h.later)
      const deadline = Date.now() + 5000
      while (events.length === before && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
      const fresh = events.slice(before)
      assert.ok(fresh.length > 0, 'la ligne ajoutée est livrée')
      for (const e of fresh) assert.notEqual(e.replayed, true, `${e.type} live`)
    })
  }

  for (const [name, build] of Object.entries(harnesses)) {
    it(`${name} : la reprise d'une session libérée ne relit pas l'historique et reste live`, () => {
      const h = build()
      const home = fs.mkdtempSync(path.join(os.tmpdir(), `af-replayed-${name}-home-`))
      const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `af-replayed-${name}-ws-`)))
      cleanups.push(() => { h.restore(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }) })
      const file = h.setup(ws, home)
      const watcher = h.make(ws)
      cleanups.push(() => watcher.dispose())
      const events: AgentEvent[] = []
      watcher.onEvent(e => events.push(e))
      watcher.start()
      assert.ok(events.length > 0, 'l\'historique est lu à l\'attache')

      // The session is released (inactive for too long), then its file resumes
      const internals = watcher as unknown as {
        sessions: Map<string, { lastActivityTime: number }>
        releaseEndedSessions(): void
        scanForSessions(): void
      }
      for (const s of internals.sessions.values()) s.lastActivityTime = 0
      internals.releaseEndedSessions()
      assert.equal(internals.sessions.size, 0, 'la session est libérée')
      fs.appendFileSync(file, h.later)
      const before = events.length
      internals.scanForSessions()

      assert.equal(internals.sessions.size, 1, 'la session est rattachée')
      const fresh = events.slice(before)
      assert.equal(fresh.filter(e => e.type === 'message').length, 1, 'seule la ligne écrite pendant la libération est livrée')
      for (const e of fresh) assert.notEqual(e.replayed, true, `${e.type} live`)
    })
  }

  // Comportement connu, documenté et non corrigé (#613, choix du propriétaire) : docs/relay-sources.md (« may overstate »).
  // Un transcript Codex, Copilot ou Pi tronqué pendant le suivi est relu depuis l'octet 0 (fs-utils readNewFileLines)
  // sans `replayed`. Les parseurs écartent les copies qu'ils reconnaissent (Pi et Copilot par id d'entrée, 5 000 au
  // plus ; Codex par empreinte de message et id d'appel) ; le reste est réémis comme live et compté une deuxième fois
  // par le chiffre de perte de l'extension. Ces tests échouent le jour où ce défaut est corrigé : mettre la doc à jour.
  async function truncateAndRewrite(name: 'codex' | 'copilot' | 'pi', fill?: (file: string) => void) {
    const { panelLoss } = await import('../src/panel-loss')
    panelLoss.clear()
    const h = harnesses[name]!()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `af-replayed-${name}-trunc-home-`))
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `af-replayed-${name}-trunc-ws-`)))
    cleanups.push(() => { panelLoss.clear(); h.restore(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }) })
    const file = h.setup(ws, home)
    fill?.(file)
    const watcher = h.make(ws)
    cleanups.push(() => watcher.dispose())
    const events: AgentEvent[] = []
    watcher.onEvent(e => { events.push(e); panelLoss.note(e) })
    watcher.start()
    const sid = events.find(e => e.type === 'message')!.sessionId!
    const counted = () => panelLoss.snapshotAfterReplay(() => {})?.evicted[sid] ?? 0
    const atAttach = { count: counted(), events: events.length }
    for (const e of events) assert.equal(e.replayed, true, 'précondition : tout l\'historique est replayed')
    const content = fs.readFileSync(file)
    const read = () => (watcher as unknown as { readNewLines(id: string): void }).readNewLines(sid)
    // Synchronous: no fs.watch callback can run between these steps
    fs.writeFileSync(file, '')
    read()
    fs.writeFileSync(file, content)
    read()
    return { atAttach, again: events.slice(atAttach.events), counted: counted() }
  }

  it('codex : un rollout tronqué puis réécrit à l\'identique réémet son context_update sans replayed, compté une deuxième fois (limite documentée, #613)', async () => {
    const { atAttach, again, counted } = await truncateAndRewrite('codex')
    assert.deepEqual(again.map(e => e.type), ['context_update'], 'le message est écarté (empreinte), pas le context_update de session_meta')
    assert.notEqual(again[0]!.replayed, true)
    assert.equal(counted, atAttach.count + 1, 'le chiffre dépasse de 1 les événements prouvés')
  })

  for (const name of ['copilot', 'pi'] as const) {
    it(`${name} : réécrit à l'identique, les entrées à id ne sont pas réémises (limite documentée, #613)`, async () => {
      const { atAttach, again, counted } = await truncateAndRewrite(name)
      assert.deepEqual(again, [])
      assert.equal(counted, atAttach.count)
    })
  }

  it('pi : au-delà de 5 000 ids d\'entrée, la relecture après troncature réémet les plus anciennes sans replayed (limite documentée, #613)', async () => {
    const msg = (i: number) => j({ type: 'message', id: `m${i}`, parentId: null, timestamp: '2026-10-12T09:00:01.000Z', message: { role: 'user', content: `m${i}`, timestamp: 1 } })
    const { atAttach, again, counted } = await truncateAndRewrite('pi', (file) => {
      fs.appendFileSync(file, Array.from({ length: 5000 }, (_, i) => msg(i)).join(''))
    })
    const messages = again.filter(e => e.type === 'message')
    assert.ok(messages.length > 0, 'des messages déjà lus sont réémis')
    for (const e of messages) assert.notEqual(e.replayed, true)
    assert.ok(counted > atAttach.count, `compté au-dessus de la preuve (${counted} > ${atAttach.count})`)
  })

  it('gemini : une réécriture par rename (nouvel inode) ne redit pas l\'ancien message et garde le nouveau live', async () => {
    const h = harnesses.gemini!()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-replayed-gemini-rw-home-'))
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-replayed-gemini-rw-ws-')))
    cleanups.push(() => { h.restore(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }) })
    const file = h.setup(ws, home)
    const watcher = h.make(ws)
    cleanups.push(() => watcher.dispose())
    const events: AgentEvent[] = []
    watcher.onEvent(e => events.push(e))
    watcher.start()
    const history = events.filter(e => e.type === 'message')
    assert.equal(history.length, 1)
    assert.equal(history[0]!.replayed, true)

    // gemini-cli rewrites the whole file (temp file + rename, a new inode) when a session is resumed
    const head = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(`${file}.tmp`, head + h.later)
    fs.renameSync(`${file}.tmp`, file)
    const before = events.length
    const deadline = Date.now() + 5000
    while (!events.slice(before).some(e => e.type === 'message') && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))

    const messages = events.slice(before).filter(e => e.type === 'message')
    assert.equal(messages.length, 1, 'seule la ligne nouvelle est émise, pas l\'ancienne')
    assert.equal((messages[0]!.payload as { content?: string }).content, 'later line')
    for (const e of events.slice(before)) assert.notEqual(e.replayed, true, `${e.type} de la réécriture`)
  })
})
