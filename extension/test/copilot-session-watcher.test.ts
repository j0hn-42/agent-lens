/**
 * CopilotSessionWatcher : découverte des sessions locales dans ~/.copilot/session-state, filtre sur
 * le workspace (cwd / git_root de workspace.yaml), lecture des événements et reprise à chaud.
 */
import './helpers/alias-vscode'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CopilotSessionWatcher, readSessionWorkspace } from '../src/copilot-session-watcher'
import type { AgentEvent } from '../src/protocol'
import type { SessionLifecycleEvent } from '../src/session-runtime'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const line = (type: string, data: object, id: string) => JSON.stringify({ type, data, id }) + '\n'

describe('readSessionWorkspace', () => {
  let dir = ''
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-copilot-ws-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('reads cwd and git_root, with or without quotes', () => {
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: x\ncwd: "/a b/c"\ngit_root: '/a b'\nsummary: hello: world\n`)
    assert.deepEqual(readSessionWorkspace(dir), { cwd: '/a b/c', gitRoot: '/a b' })
  })

  it('returns null when the file is missing or carries neither key', () => {
    assert.equal(readSessionWorkspace(dir), null)
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'id: x\nsummary: y\n')
    assert.equal(readSessionWorkspace(dir), null)
  })

  it('refuses an oversized file', () => {
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'cwd: /a\n' + 'x'.repeat(70 * 1024))
    assert.equal(readSessionWorkspace(dir), null)
  })
})

describe('CopilotSessionWatcher', () => {
  let home = ''
  let ws = ''
  let prevHome: string | undefined
  let watcher: CopilotSessionWatcher | null = null

  const addSession = (n: number, yaml: string, events: string) => {
    const dir = path.join(home, 'session-state', uuid(n))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), yaml)
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events)
    return dir
  }
  const sessionStart = line('session.start', { selectedModel: 'gpt-5', context: { cwd: '/x' } }, 'e1')

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-copilot-home-'))
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'af-copilot-proj-'))
    fs.mkdirSync(path.join(home, 'session-state'), { recursive: true })
    prevHome = process.env.COPILOT_HOME
    process.env.COPILOT_HOME = home
  })
  afterEach(() => {
    watcher?.dispose()
    watcher = null
    if (prevHome === undefined) delete process.env.COPILOT_HOME
    else process.env.COPILOT_HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('attaches the sessions whose cwd or git_root is the workspace (or inside it), not the others', () => {
    addSession(1, `cwd: ${ws}\n`, sessionStart)
    addSession(2, `cwd: /nowhere/else\ngit_root: ${path.join(ws, 'sub')}\n`, sessionStart)
    addSession(3, `cwd: /nowhere/else\ngit_root: /nowhere/else\n`, sessionStart)
    watcher = new CopilotSessionWatcher(ws)
    watcher.start()
    assert.deepEqual(watcher.getActiveSessions().map(s => s.id).sort(), [uuid(1), uuid(2)])
  })

  it('attaches every session when no workspace is given', () => {
    addSession(1, `cwd: /a\n`, sessionStart)
    addSession(2, `cwd: /b\n`, sessionStart)
    watcher = new CopilotSessionWatcher(null)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 2)
  })

  it('skips an empty log, a stale log and a directory without events.jsonl', () => {
    addSession(1, `cwd: ${ws}\n`, '')
    const stale = addSession(2, `cwd: ${ws}\n`, sessionStart)
    const old = new Date(Date.now() - 3600_000)
    fs.utimesSync(path.join(stale, 'events.jsonl'), old, old)
    fs.mkdirSync(path.join(home, 'session-state', uuid(3)))
    watcher = new CopilotSessionWatcher(ws)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 0)
  })

  it('does nothing when the Copilot directory does not exist', () => {
    fs.rmSync(path.join(home, 'session-state'), { recursive: true })
    watcher = new CopilotSessionWatcher(ws)
    assert.doesNotThrow(() => watcher!.start())
    assert.equal(watcher.isActive(), false)
  })

  it('tags sessions and lifecycle events as copilot, with the cwd', () => {
    addSession(1, `cwd: ${ws}\n`, sessionStart)
    watcher = new CopilotSessionWatcher(ws)
    const lifecycle: SessionLifecycleEvent[] = []
    watcher.onSessionLifecycle(l => lifecycle.push(l))
    watcher.start()
    const [info] = watcher.getActiveSessions()
    assert.equal(info.runtime, 'copilot')
    assert.equal(info.cwd, ws)
    assert.equal(info.label, `Copilot ${uuid(1).slice(0, 8)}`)
    assert.equal(lifecycle.length, 1, 'attaching announces the session once')
    watcher.replaySessionStart()
    assert.equal(lifecycle.length, 2, 'a replay announces it again')
    for (const l of lifecycle) {
      assert.equal(l.type, 'started')
      assert.equal(l.runtime, 'copilot')
      assert.equal(l.cwd, ws)
    }
  })

  it('reads the history at attach time and follows new lines, reassembling a split line', async () => {
    const dir = addSession(1, `cwd: ${ws}\n`,
      sessionStart + line('user.message', { content: 'Fix the bug' }, 'e2'))
    watcher = new CopilotSessionWatcher(ws)
    const events: AgentEvent[] = []
    const relabels: string[] = []
    watcher.onEvent(e => events.push(e))
    watcher.onSessionLifecycle(l => { if (l.type === 'updated') relabels.push(l.label) })
    watcher.start()

    assert.ok(events.some(e => e.type === 'agent_spawn' && e.sessionId === uuid(1)))
    assert.ok(events.some(e => e.type === 'message' && e.payload.content === 'Fix the bug'))
    assert.deepEqual(relabels, ['Fix the bug'])

    const next = line('assistant.message', { messageId: 'm', content: 'On it.' }, 'e3')
    const file = path.join(dir, 'events.jsonl')
    fs.appendFileSync(file, next.slice(0, 20))
    fs.appendFileSync(file, next.slice(20))
    const deadline = Date.now() + 5000
    while (!events.some(e => e.payload.content === 'On it.') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }
    assert.ok(events.some(e => e.type === 'message' && e.payload.content === 'On it.'), 'the appended line is delivered once complete')
  })

  it('picks up a session directory created after start', async () => {
    watcher = new CopilotSessionWatcher(ws)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 0)
    addSession(1, `cwd: ${ws}\n`, sessionStart)
    const deadline = Date.now() + 8000
    while (watcher.getActiveSessions().length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }
    assert.equal(watcher.getActiveSessions().length, 1)
  })
})
