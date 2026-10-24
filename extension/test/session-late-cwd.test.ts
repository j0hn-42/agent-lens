/**
 * A transcript found while Claude Code is starting the session holds only metadata at its head (agent-setting, mode,
 * permission-mode...): its cwd, so its project, comes with a later entry. It is learnt from the lines read live and
 * sent to the clients in session-updated, so the session joins its workspace (never guessed before that).
 */
import './helpers/alias-vscode'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ClaudeSessionPipeline } from '../src/claude-session-pipeline'
import { completeSessionHeader } from '../src/team-watcher'
import { updatedSessionMessage } from '../src/session-runtime'
import type { WatchedSession } from '../src/protocol'

const SESSION = '1a7ec3d0-0000-4000-8000-00000000c3d1'
const line = (o: unknown) => JSON.stringify(o)
const META = [line({ type: 'agent-setting' }), line({ type: 'mode', mode: 'normal' }), line({ type: 'permission-mode' })]

describe('completeSessionHeader', () => {
  it('learns the cwd and the branch from the first new entry that carries a cwd', () => {
    const cwd = new Map<string, string>()
    const branch = new Map<string, string>()
    assert.equal(completeSessionHeader(SESSION, META, cwd, branch), false, 'no cwd yet: nothing learnt')
    assert.equal(cwd.has(SESSION), false)
    const lines = [line({ type: 'attachment', cwd: '/w/repo', gitBranch: 'feat/a' }), line({ type: 'user', cwd: '/w/other' })]
    assert.equal(completeSessionHeader(SESSION, lines, cwd, branch), true)
    assert.equal(cwd.get(SESSION), '/w/repo')
    assert.equal(branch.get(SESSION), 'feat/a')
  })

  it('keeps a cwd already known, and skips partial or foreign lines', () => {
    const cwd = new Map([[SESSION, '/w/first']])
    assert.equal(completeSessionHeader(SESSION, [line({ type: 'user', cwd: '/w/later' })], cwd, new Map()), false)
    assert.equal(cwd.get(SESSION), '/w/first')
    const fresh = new Map<string, string>()
    assert.equal(completeSessionHeader(SESSION, ['{"type":"user","cwd":', 'not json', line({ cwd: 42 })], fresh, new Map()), false)
    assert.equal(fresh.size, 0)
  })

  it('a relative cwd is no cwd: it would resolve against the relay\'s own directory', () => {
    const cwd = new Map<string, string>()
    assert.equal(completeSessionHeader(SESSION, [line({ type: 'user', cwd: '.' }), line({ type: 'user', cwd: 'sub/dir' })], cwd, new Map()), false)
    assert.equal(cwd.size, 0)
  })

  it('a detached HEAD (no branch) learns the cwd and no branch', () => {
    const cwd = new Map<string, string>()
    const branch = new Map<string, string>()
    assert.equal(completeSessionHeader(SESSION, [line({ type: 'user', cwd: '/w/repo', gitBranch: '' })], cwd, branch), true)
    assert.equal(branch.has(SESSION), false)
  })
})

describe('ClaudeSessionPipeline: lines read live go to the host', () => {
  it('hands every batch of new lines to onTranscriptLines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-late-cwd-'))
    const file = path.join(dir, `${SESSION}.jsonl`)
    fs.writeFileSync(file, META.join('\n') + '\n')
    const sessions = new Map<string, WatchedSession>()
    const seen: string[][] = []
    const pipeline = new ClaudeSessionPipeline({
      sessions, submit() {}, fireLifecycle() {}, withHistory: load => load(),
      onTranscriptLines: (sessionId, lines) => { assert.equal(sessionId, SESSION); seen.push([...lines]) },
    })
    const session = pipeline.newSession(SESSION, file)
    sessions.set(SESSION, session)
    try {
      await pipeline.attach(session)
      const entry = line({ type: 'user', cwd: '/w/repo', message: { role: 'user', content: 'Hi' } })
      fs.appendFileSync(file, entry + '\n')
      pipeline.readNewLines(SESSION)
      assert.deepEqual(seen, [[entry]])
    } finally {
      pipeline.release(session)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('updatedSessionMessage', () => {
  it('carries the project, the cwd and the branch of the lifecycle event', () => {
    assert.deepEqual(updatedSessionMessage({
      type: 'updated', sessionId: 's1', label: 'L', cwd: '/w/repo', projectId: 'abc', projectName: 'repo', branch: 'main', teamName: 't',
    }), { type: 'session-updated', sessionId: 's1', label: 'L', teamName: 't', cwd: '/w/repo', projectId: 'abc', projectName: 'repo', branch: 'main' })
  })

  it('never half a project, and nothing it does not know', () => {
    assert.deepEqual(updatedSessionMessage({ type: 'updated', sessionId: 's1', label: 'L', projectId: 'abc' }),
      { type: 'session-updated', sessionId: 's1', label: 'L' })
  })
})
