/**
 * Session times (#365): the last activity of a watched session is when its transcript was last written, its
 * start is the one the transcript records, and attaching is never presented as activity or as the start.
 */
import './helpers/alias-vscode'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ClaudeSessionPipeline, listedStartTimes } from '../src/claude-session-pipeline'
import { newestSessionMtime } from '../src/fs-utils'
import { startedSessionInfo } from '../src/session-runtime'
import type { SessionInfo, WatchedSession } from '../src/protocol'

const SESSION = '12121212-1212-4121-8121-121212121212'
const line = (o: unknown) => JSON.stringify(o) + '\n'

function tmpTranscript(writtenAt: number): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-times-'))
  const file = path.join(dir, `${SESSION}.jsonl`)
  fs.writeFileSync(file, line({ type: 'user', timestamp: new Date(writtenAt).toISOString(), message: { role: 'user', content: 'Hello' } }))
  fs.utimesSync(file, writtenAt / 1000, writtenAt / 1000)
  return { dir, file }
}

test('attach keeps the last activity at the mtime: reading the history is not activity', () => {
  const writtenAt = Date.now() - 9 * 60_000
  const { dir, file } = tmpTranscript(writtenAt)
  const sessions = new Map<string, WatchedSession>()
  const pipeline = new ClaudeSessionPipeline({
    sessions, submit() {}, fireLifecycle() {}, withHistory: load => load(),
  })
  const session = pipeline.newSession(SESSION, file, { lastActivityTime: writtenAt, recordedStartTime: writtenAt - 3600_000 })
  sessions.set(SESSION, session)
  try {
    pipeline.attach(session)
    assert.equal(session.lastActivityTime, writtenAt, 'not the attach time')
    assert.ok(session.inactivityTimer, 'the inactivity timer still runs')
    // New content is activity
    pipeline.resetInactivityTimer(SESSION)
    assert.ok(session.lastActivityTime >= Date.now() - 1000)
  } finally {
    pipeline.release(session)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('listedStartTimes: the recorded start apart from the event origin, or the start said to be the watch start', () => {
  assert.deepEqual(listedStartTimes({ sessionStartTime: 2000, recordedStartTime: 1000 }), { startTime: 2000, recordedStartTime: 1000 })
  assert.deepEqual(listedStartTimes({ sessionStartTime: 2000 }), { startTime: 2000, startTimeWatched: true })
})

test('newestSessionMtime: newest of the transcript and its subagent transcripts', () => {
  const writtenAt = Date.now() - 20 * 60_000
  const { dir, file } = tmpTranscript(writtenAt)
  try {
    assert.equal(Math.round(newestSessionMtime(file, SESSION)), Math.round(writtenAt))
    const subDir = path.join(dir, SESSION, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const sub = path.join(subDir, 'agent-a.jsonl')
    fs.writeFileSync(sub, '')
    const subAt = writtenAt + 60_000
    fs.utimesSync(sub, subAt / 1000, subAt / 1000)
    assert.equal(Math.round(newestSessionMtime(file, SESSION)), Math.round(subAt))
    assert.equal(newestSessionMtime(path.join(dir, 'missing.jsonl'), SESSION, 42), 42, 'unreadable: the fallback')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('startedSessionInfo: keeps the listed times; now only for a session the watcher does not list', () => {
  const lifecycle = { type: 'started' as const, sessionId: 's1', label: 'L', runtime: 'claude' }
  const listed: SessionInfo = { id: 's1', label: 'L', status: 'active', startTime: 5000, recordedStartTime: 1000, lastActivityTime: 3000 }
  const info = startedSessionInfo(lifecycle, listed, 9999)
  assert.equal(info.startTime, 5000)
  assert.equal(info.recordedStartTime, 1000)
  assert.equal(info.lastActivityTime, 3000)
  assert.equal(info.runtime, 'claude')
  const watched = startedSessionInfo(lifecycle, { ...listed, recordedStartTime: undefined, startTimeWatched: true }, 9999)
  assert.equal(watched.startTimeWatched, true)
  assert.equal('recordedStartTime' in watched, false)
  const unknown = startedSessionInfo(lifecycle, undefined, 9999)
  assert.equal(unknown.startTime, 9999)
  assert.equal(unknown.lastActivityTime, 9999)
})
