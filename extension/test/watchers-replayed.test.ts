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
})
