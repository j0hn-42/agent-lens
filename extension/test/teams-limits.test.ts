/**
 * Agent Teams bounds, asserted through behaviour (not by pinning constant values): every
 * untrusted input is capped by the code that reads it. Feature-level coverage lives next to each
 * feature (teammate.test.ts, team-watcher.test.ts).
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as C from '../src/constants'
import { MessageDeduper, sanitizeAgentName, sanitizeMessageContent } from '../src/team-links'
import { selectReplayLines, readTranscriptTail, sanitizeTeamField, TeammateTracker } from '../src/teammate'
import { parseInbox, parseTeamConfig } from '../src/team-watcher'
import { tmpDir, assistantText, writeJsonl, teamConfig } from './helpers/teams-fixtures'

describe('Agent Teams limits are enforced', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('the dedupe memory never exceeds its cap and still dedupes inside the window', () => {
    const d = new MessageDeduper()
    for (let i = 0; i < C.TEAM_DEDUPE_MAX_ENTRIES * 3; i++) d.accept('link', `message ${i}`, 0)
    assert.equal(d.size, C.TEAM_DEDUPE_MAX_ENTRIES)
    assert.equal(d.accept('l2', 'same', 1000), true)
    assert.equal(d.accept('l2', 'same', 1000 + C.TEAM_DEDUPE_WINDOW_MS - 1), false)
    assert.equal(d.accept('l2', 'same', 1000 + C.TEAM_DEDUPE_WINDOW_MS + 1), true)
  })

  it('transcript replay keeps only the newest user/assistant lines', () => {
    const lines = Array.from({ length: C.TEAMMATE_REPLAY_MAX_MESSAGES * 3 }, (_, i) =>
      JSON.stringify({ type: i % 2 ? 'assistant' : 'user', message: { content: `m${i}` } }))
    lines.splice(5, 0, JSON.stringify({ type: 'summary' }))
    const out = selectReplayLines(lines)
    assert.equal(out.length, C.TEAMMATE_REPLAY_MAX_MESSAGES)
    assert.equal(out[out.length - 1], lines[lines.length - 1])
    assert.ok(out.every(l => !l.includes('summary')))
  })

  it('the transcript tail never reads more than the byte window and drops the cut first line', () => {
    dir = tmpDir()
    const file = path.join(dir, 't.jsonl')
    writeJsonl(file, Array.from({ length: 400 }, (_, i) => assistantText(`line ${i} ${'x'.repeat(200)}`)))
    const window = 10_000
    const tail = readTranscriptTail(file, window)
    assert.ok(tail.lines.join('\n').length <= window)
    assert.ok(tail.lines.length > 0 && tail.lines.every(l => { try { JSON.parse(l); return true } catch { return false } }))
    assert.ok(tail.lines[tail.lines.length - 1].includes('line 399'))
  })

  it('inbox parsing keeps the newest messages and caps each text', () => {
    const many = Array.from({ length: C.TEAM_INBOX_MAX_MESSAGES + 50 }, (_, i) => ({ from: 'a', text: `m${i}` }))
    const parsed = parseInbox(many)
    assert.equal(parsed.length, C.TEAM_INBOX_MAX_MESSAGES)
    assert.equal(parsed[parsed.length - 1].text, `m${many.length - 1}`)
    assert.ok(sanitizeMessageContent('y'.repeat(C.TEAM_MESSAGE_MAX * 4))!.length <= C.TEAM_MESSAGE_MAX + 1)
  })

  it('team configs keep a bounded roster and short single-line names', () => {
    const members = Array.from({ length: C.TEAM_MAX_MEMBERS + 30 }, (_, i) => ({ name: `member-${i}` }))
    assert.equal(parseTeamConfig({ ...teamConfig(), members }, 'd')!.members.length, C.TEAM_MAX_MEMBERS)
    const field = sanitizeTeamField('t'.repeat(500) + '\nsecond line\u0000')!
    assert.ok(field.length <= C.TEAM_FIELD_MAX)
    assert.ok(!/[\n\u0000]/.test(field))
    assert.ok(sanitizeAgentName('n'.repeat(500))!.length <= C.TEAM_FIELD_MAX * 4)
  })

  it('a working teammate turns idle once its stale window has passed', () => {
    const t = new TeammateTracker(0)
    t.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }), 0)
    assert.equal(t.activity(C.TEAMMATE_STALE_WORKING_MS - 1), 'working')
    assert.equal(t.activity(C.TEAMMATE_STALE_WORKING_MS + 1), 'idle')
  })

  it('relations that keep memory bounded hold', () => {
    assert.ok(C.TEAMMATE_STALE_WORKING_MS > C.TEAMMATE_RECENT_WRITE_MS)
    assert.ok(C.TEAM_INBOX_SEEN_MAX >= C.TEAM_INBOX_MAX_MESSAGES, 'keys of a full inbox must fit in the seen set')
    assert.ok(C.TEAM_INBOX_FIRST_SCAN_MAX <= C.TEAM_INBOX_MAX_MESSAGES)
  })
})
