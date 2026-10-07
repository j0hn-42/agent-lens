/**
 * Session tags on the VS Code lifecycle path (#35), bounded transcript prescan, /status rate key.
 */
import './helpers/alias-vscode'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { lifecycleTags } from '../src/session-runtime'
import { readLinesChunked } from '../src/transcript-parser'
import { statusRateKey } from '../src/relay-guards'
import { KeyedRateLimiter } from '../src/hook-guards'
import { tmpDir, makeSession, makeHarness, ofType } from './helpers/teams-fixtures'

describe('lifecycleTags', () => {
  it('carries team, member, runtime, workspace and cwd, and omits what is unknown', () => {
    assert.deepEqual(
      lifecycleTags({ type: 'updated', sessionId: 's', label: 'x', teamName: 't', memberName: 'm', runtime: 'claude', workspace: '/w', cwd: '/w/sub' }),
      { teamName: 't', memberName: 'm', runtime: 'claude', workspace: '/w', cwd: '/w/sub' },
    )
    assert.deepEqual(lifecycleTags({ type: 'started', sessionId: 's', label: 'x' }), {})
  })
})

describe('readLinesChunked / prescan of a lead transcript', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('yields every line exactly once across chunk boundaries (multi-byte safe) and honours `size`', () => {
    dir = tmpDir()
    const file = path.join(dir, 'lead.jsonl')
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ i, t: 'é€漢'.repeat(i % 7) }))
    fs.writeFileSync(file, lines.join('\n') + '\n' + 'not-flushed-yet')
    const sizeWithoutTail = Buffer.byteLength(lines.join('\n') + '\n')
    for (const chunk of [7, 64, 1000]) {
      assert.deepEqual([...readLinesChunked(file, sizeWithoutTail, chunk)].filter(Boolean), lines, `chunk ${chunk}`)
    }
  })

  it('prescan of a real-shaped lead transcript registers the teammate dispatch without emitting', () => {
    dir = tmpDir()
    const file = path.join(dir, 'lead.jsonl')
    const use = { type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'Audit', name: 'audit-x', subagent_type: 'general-purpose', prompt: 'p' } }] } }
    const res = {
      type: 'user', uuid: 'u2',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'text', text: 'Spawned successfully.' }] }] },
      toolUseResult: { status: 'teammate_spawned', agentId: 'aaudit-x-1', teammate_id: 'audit-x@t', name: 'audit-x', color: 'green', team_name: 't' },
    }
    fs.writeFileSync(file, [use, res].map(e => JSON.stringify(e)).join('\n') + '\n')
    const session = makeSession({ sessionId: 's1', filePath: file })
    const h = makeHarness(session)
    const entries = h.parser.prescanExistingContent(file, fs.statSync(file).size, session)
    assert.equal(entries.length, 2)
    assert.ok(session.spawnedSubagents.has('audit-x'))
    assert.equal(session.pendingToolCalls.size, 0, 'the answered spawn is not pending')
    assert.equal(ofType(h.events, 'agent_spawn').length, 0)
  })
})

describe('statusRateKey', () => {
  it('separates local clients that share the loopback address', () => {
    const ui = statusRateKey('127.0.0.1', { origin: 'http://localhost:3000', 'user-agent': 'browser' })
    const noisy = statusRateKey('127.0.0.1', { 'user-agent': 'curl/8' })
    assert.notEqual(ui, noisy)
    const limiter = new KeyedRateLimiter(2, 0.0001, 100)
    for (let i = 0; i < 10; i++) limiter.allow(noisy, 0)
    assert.equal(limiter.allow(noisy, 1), false)
    assert.equal(limiter.allow(ui, 1), true, 'the UI keeps its own budget')
  })
  it('caps untrusted header length', () => {
    const k = statusRateKey('::1', { origin: 'o'.repeat(5000), 'user-agent': ['u'.repeat(5000)] })
    assert.ok(k.length < 300)
  })
})
