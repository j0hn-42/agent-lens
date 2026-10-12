/**
 * GeminiSessionWatcher (#238) : découverte des sessions sous <gemini>/tmp/<projet>/chats (racine
 * surchargée par GEMINI_CLI_HOME), filtre sur le projectHash de l'en-tête (le nom du dossier n'est
 * jamais lu), sous-agents ignorés, lecture des lignes et reprise à chaud.
 */
import './helpers/alias-vscode'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { GeminiSessionWatcher, geminiTmpRoot, readGeminiSessionHeader } from '../src/gemini-session-watcher'
import { geminiProjectHash } from '../src/gemini-event-parser'
import type { AgentEvent } from '../src/protocol'
import type { SessionLifecycleEvent } from '../src/session-runtime'

const uuid = (n: number) => `9c1d2e3f-0000-4000-8000-${String(n).padStart(12, '0')}`
const fileName = (n: number) => `session-2026-10-12T09-00-${uuid(n).slice(-4)}.jsonl`
const header = (root: string, n: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({ sessionId: uuid(n), projectHash: geminiProjectHash(root), startTime: '2026-01-05T09:00:00.000Z', lastUpdated: '2026-01-05T09:00:00.000Z', ...over }) + '\n'
const user = (id: string, content: string) =>
  JSON.stringify({ id, timestamp: '2026-10-12T09:00:01.000Z', type: 'user', content }) + '\n'

describe('geminiTmpRoot', () => {
  const saved = process.env.GEMINI_CLI_HOME
  beforeEach(() => { delete process.env.GEMINI_CLI_HOME })
  afterEach(() => { if (saved === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = saved })

  it('defaults to ~/.gemini/tmp', () => {
    assert.equal(geminiTmpRoot(), path.join(os.homedir(), '.gemini', 'tmp'))
  })

  it('follows GEMINI_CLI_HOME, the variable gemini-cli itself reads for its home', () => {
    process.env.GEMINI_CLI_HOME = '/opt/gemini-home'
    assert.equal(geminiTmpRoot(), path.join('/opt/gemini-home', '.gemini', 'tmp'))
  })
})

describe('readGeminiSessionHeader', () => {
  let dir = ''
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-gem-hdr-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('reads the session id, project hash and start of the first record', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, header('/w/app', 1) + user('u1', 'hi'))
    assert.deepEqual(readGeminiSessionHeader(f), {
      sessionId: uuid(1), projectHash: geminiProjectHash('/w/app'), final: true, startMs: Date.parse('2026-01-05T09:00:00.000Z'),
    })
  })

  it('refuses a first line that is not a metadata record', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, user('u1', 'hi'))
    assert.deepEqual(readGeminiSessionHeader(f), { sessionId: null, projectHash: null, final: true })
  })

  it('refuses an unsafe session id (dot, slash, too long)', () => {
    const f = path.join(dir, 'a.jsonl')
    for (const sessionId of ['a.b', '../x', 'a'.repeat(200)]) {
      fs.writeFileSync(f, header('/w', 1, { sessionId }))
      assert.equal(readGeminiSessionHeader(f).sessionId, null, sessionId)
    }
  })

  it('marks a sub-agent file, which is not read', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, header('/w', 1, { kind: 'subagent' }))
    assert.equal(readGeminiSessionHeader(f).subagent, true)
  })

  it('is not final while the first line is still being written', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, '{"sessionId":"x","proj')
    assert.deepEqual(readGeminiSessionHeader(f), { sessionId: null, projectHash: null, final: false })
  })

  it('gives up on a first line larger than the cap', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, JSON.stringify({ sessionId: 'x', projectHash: 'h', pad: 'x'.repeat(80 * 1024) }) + '\n')
    assert.deepEqual(readGeminiSessionHeader(f), { sessionId: null, projectHash: null, final: true })
  })
})

describe('GeminiSessionWatcher', () => {
  let home = ''
  let ws = ''
  let savedHome: string | undefined
  let watcher: GeminiSessionWatcher | null = null

  const tmp = () => path.join(home, '.gemini', 'tmp')
  /** The project directory name is a registry slug, not a hash: it must never matter. */
  const addSession = (n: number, root: string, body = '', project = 'some-slug', over: Record<string, unknown> = {}) => {
    const dir = path.join(tmp(), project, 'chats')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, fileName(n))
    fs.writeFileSync(file, header(root, n, over) + body)
    return file
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-gem-home-'))
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-gem-proj-')))
    fs.mkdirSync(tmp(), { recursive: true })
    savedHome = process.env.GEMINI_CLI_HOME
    process.env.GEMINI_CLI_HOME = home
  })
  afterEach(() => {
    watcher?.dispose()
    watcher = null
    if (savedHome === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = savedHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('attaches the sessions whose project hash is the workspace, whatever the directory name', () => {
    addSession(1, ws, '', 'my-project')
    addSession(2, ws, '', geminiProjectHash('/nowhere/else'))
    addSession(3, '/nowhere/else', '', geminiProjectHash(ws))
    watcher = new GeminiSessionWatcher(ws)
    watcher.start()
    assert.deepEqual(watcher.getActiveSessions().map(s => s.id).sort(), [uuid(1), uuid(2)])
  })

  it('attaches every session when no workspace is given, without inventing a cwd', () => {
    addSession(1, '/a')
    addSession(2, '/b')
    watcher = new GeminiSessionWatcher(null)
    watcher.start()
    const sessions = watcher.getActiveSessions()
    assert.equal(sessions.length, 2)
    for (const s of sessions) assert.equal(s.cwd, undefined)
  })

  it('does not read a sub-agent file, nor files nested under the parent session directory', () => {
    addSession(1, ws, '', 'p', { kind: 'subagent' })
    const nested = path.join(tmp(), 'p', 'chats', uuid(9))
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, `${uuid(2)}.jsonl`), header(ws, 2, { kind: 'subagent' }))
    fs.writeFileSync(path.join(nested, fileName(3)), header(ws, 3))
    watcher = new GeminiSessionWatcher(ws)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 0)
  })

  it('skips a stale file, a file without metadata, legacy .json and other files', () => {
    const stale = addSession(1, ws)
    const old = new Date(Date.now() - 3600_000)
    fs.utimesSync(stale, old, old)
    const dir = path.dirname(stale)
    fs.writeFileSync(path.join(dir, fileName(2)), user('u1', 'no header'))
    fs.writeFileSync(path.join(dir, 'session-legacy.json'), header(ws, 3))
    fs.writeFileSync(path.join(dir, 'notes.txt'), header(ws, 4))
    watcher = new GeminiSessionWatcher(ws)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 0)
  })

  it('does nothing when the Gemini directory does not exist', () => {
    fs.rmSync(path.join(home, '.gemini'), { recursive: true })
    watcher = new GeminiSessionWatcher(ws)
    assert.doesNotThrow(() => watcher!.start())
    assert.equal(watcher.isActive(), false)
  })

  it('tags sessions and lifecycle events as gemini; the cwd is the workspace whose hash matched', () => {
    addSession(1, ws)
    watcher = new GeminiSessionWatcher(ws)
    const lifecycle: SessionLifecycleEvent[] = []
    watcher.onSessionLifecycle(l => lifecycle.push(l))
    watcher.start()
    const [info] = watcher.getActiveSessions()
    assert.equal(info.runtime, 'gemini')
    assert.equal(info.cwd, ws)
    assert.equal(info.label, `Gemini ${uuid(1).slice(0, 8)}`)
    assert.equal(info.startTime, Date.parse('2026-01-05T09:00:00.000Z'))
    assert.equal(lifecycle.length, 1)
    watcher.replaySessionStart()
    assert.equal(lifecycle.length, 2)
    for (const l of lifecycle) {
      assert.equal(l.type, 'started')
      assert.equal(l.runtime, 'gemini')
      assert.equal(l.cwd, ws)
    }
  })

  it('matches a workspace given through a symbolic link by its real path too', () => {
    const link = path.join(os.tmpdir(), `af-gem-link-${process.pid}`)
    fs.symlinkSync(ws, link)
    try {
      addSession(1, ws)
      watcher = new GeminiSessionWatcher(link)
      watcher.start()
      assert.equal(watcher.getActiveSessions().length, 1)
    } finally { fs.rmSync(link, { force: true }) }
  })

  it('reads the history at attach time and follows new lines, reassembling a split line', async () => {
    const file = addSession(1, ws, user('u1', 'Fix the bug'))
    watcher = new GeminiSessionWatcher(ws)
    const events: AgentEvent[] = []
    const relabels: string[] = []
    watcher.onEvent(e => events.push(e))
    watcher.onSessionLifecycle(l => { if (l.type === 'updated') relabels.push(l.label) })
    watcher.start()

    assert.ok(events.some(e => e.type === 'agent_spawn' && e.sessionId === uuid(1)))
    assert.ok(events.some(e => e.type === 'message' && e.payload.content === 'Fix the bug'))
    assert.deepEqual(relabels, ['Fix the bug'])

    const next = JSON.stringify({ id: 'g1', timestamp: 't', type: 'gemini', content: 'On it.', model: 'gemini-x', thoughts: [], tokens: null }) + '\n'
    fs.appendFileSync(file, next.slice(0, 20))
    fs.appendFileSync(file, next.slice(20))
    const deadline = Date.now() + 5000
    while (!events.some(e => e.payload.content === 'On it.') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }
    assert.ok(events.some(e => e.type === 'message' && e.payload.content === 'On it.'))
  })

  it('does not show twice a message that the CLI rewrites after a resume', async () => {
    const file = addSession(1, ws, user('u1', 'Fix the bug'))
    watcher = new GeminiSessionWatcher(ws)
    const events: AgentEvent[] = []
    watcher.onEvent(e => events.push(e))
    watcher.start()
    // gemini-cli rewrites the whole file (temp file + rename, a new inode) when a session is resumed
    fs.writeFileSync(`${file}.tmp`, header(ws, 1) + user('u1', 'Fix the bug') + user('u2', 'And this'))
    fs.renameSync(`${file}.tmp`, file)
    const deadline = Date.now() + 5000
    while (!events.some(e => e.payload.content === 'And this') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }
    assert.equal(events.filter(e => e.payload.content === 'Fix the bug').length, 1)
    assert.equal(events.filter(e => e.payload.content === 'And this').length, 1)
  })

  it('does not follow a symbolic link to a session file', () => {
    const real = addSession(1, ws)
    const dir = path.dirname(real)
    fs.renameSync(real, path.join(home, 'outside.jsonl'))
    fs.symlinkSync(path.join(home, 'outside.jsonl'), path.join(dir, fileName(2)))
    watcher = new GeminiSessionWatcher(ws)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 0)
  })

  it('watches at most 25 sessions', () => {
    for (let n = 1; n <= 30; n++) addSession(n, ws)
    watcher = new GeminiSessionWatcher(ws)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 25)
  })

  it('survives a listener that throws: no uncaught exception, the session stays watched', async () => {
    const file = addSession(1, ws)
    watcher = new GeminiSessionWatcher(ws)
    watcher.start()
    let calls = 0
    watcher.onEvent(() => { calls++; throw new Error('listener boom') })
    fs.appendFileSync(file, user('u9', 'trigger'))
    const deadline = Date.now() + 5000
    while (calls === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
    assert.ok(calls > 0)
    assert.equal(watcher.isSessionActive(uuid(1)), true)
  })

  it('picks up a session file created after start', async () => {
    watcher = new GeminiSessionWatcher(ws)
    watcher.start()
    assert.equal(watcher.getActiveSessions().length, 0)
    addSession(1, ws)
    const deadline = Date.now() + 8000
    while (watcher.getActiveSessions().length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }
    assert.equal(watcher.getActiveSessions().length, 1)
  })
})
