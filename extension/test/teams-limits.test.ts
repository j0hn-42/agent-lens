/**
 * Every Agent Teams limit is a documented constant in constants.ts. This pins the values and
 * their relations so a change is a conscious decision; enforcement is tested next to each
 * feature (teammate.test.ts, team-watcher.test.ts).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/constants'
import { MessageDeduper } from '../src/team-links'

describe('Agent Teams limits', () => {
  it('are positive integers with the documented values', () => {
    const expected: Record<string, number> = {
      TEAMMATE_RECENT_WRITE_MS: 15_000,
      TEAMMATE_STALE_WORKING_MS: 90_000,
      TEAMMATE_REPLAY_MAX_MESSAGES: 40,
      TEAMMATE_REPLAY_MAX_BYTES: 1024 * 1024,
      TEAMMATE_MAX_PER_SESSION: 64,
      TEAMMATE_META_MAX_BYTES: 64 * 1024,
      TEAM_FIELD_MAX: 64,
      TEAM_SCAN_INTERVAL_MS: 2000,
      TEAM_INFO_DEBOUNCE_MS: 750,
      TEAM_MAX_TEAMS: 50,
      TEAM_MAX_MEMBERS: 64,
      TEAM_CONFIG_MAX_BYTES: 256 * 1024,
      TEAM_INBOX_MAX_FILES: 64,
      TEAM_INBOX_MAX_BYTES: 512 * 1024,
      TEAM_INBOX_MAX_MESSAGES: 200,
      TEAM_INBOX_SEEN_MAX: 1024,
      TEAM_DEDUPE_WINDOW_MS: 60_000,
      TEAM_DEDUPE_MAX_ENTRIES: 512,
      TEAM_JOIN_MATCH_WINDOW_MS: 120_000,
      SESSION_HEADER_MAX_BYTES: 16 * 1024,
      SESSION_TAG_MAX: 256,
    }
    const all = C as unknown as Record<string, number>
    for (const [name, value] of Object.entries(expected)) {
      assert.equal(all[name], value, name)
      assert.ok(Number.isInteger(all[name]) && all[name] > 0, name)
    }
  })

  it('relations that keep memory bounded hold', () => {
    assert.ok(C.TEAMMATE_STALE_WORKING_MS > C.TEAMMATE_RECENT_WRITE_MS)
    assert.ok(C.TEAM_INBOX_SEEN_MAX >= C.TEAM_INBOX_MAX_MESSAGES, 'keys of a full inbox must fit in the seen set')
    assert.ok(C.TEAM_MAX_MEMBERS * C.TEAM_MAX_TEAMS < 10_000)
    assert.ok(C.TEAMMATE_REPLAY_MAX_BYTES <= 4 * 1024 * 1024)
  })

  it('the dedupe memory never exceeds TEAM_DEDUPE_MAX_ENTRIES', () => {
    const d = new MessageDeduper()
    for (let i = 0; i < C.TEAM_DEDUPE_MAX_ENTRIES * 3; i++) d.accept('link', `message ${i}`, 0)
    assert.equal(d.size, C.TEAM_DEDUPE_MAX_ENTRIES)
  })
})
