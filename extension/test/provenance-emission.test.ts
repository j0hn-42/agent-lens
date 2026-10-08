/**
 * Provenance fields at every production site (#50, #60): the web relies on them to avoid presenting an
 * estimate as a measure or a configured model as a detected one.
 *   - tokenSource: Codex context_update ('reported' only once token_count arrived), Claude session-watcher
 *   - modelSource 'configured': teammate sidecar (subagent-watcher) and lead dispatch (transcript-parser)
 *   - `effort` / `modelSource` are identifier keys: control characters never reach the stream
 */
import './helpers/alias-vscode'
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent } from '../src/protocol'
import { CodexRolloutParser, createCodexRolloutState } from '../src/codex-rollout-parser'
import { scanSubagentsDir } from '../src/subagent-watcher'
import { SessionNormalizer } from '../src/event-normalize'
import { NORM_ID_MAX } from '../src/constants'
import {
  tmpDir, makeSession, makeHarness, ofType, writeTeammate, teammateMeta, assistantText,
} from './helpers/teams-fixtures'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-provenance-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

const HOUR = 3_600_000

describe('Codex context_update tokenSource', () => {
  const run = (lines: unknown[]) => {
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: e => events.push(e), elapsed: () => 0 })
    const state = createCodexRolloutState()
    for (const l of lines) parser.processLine(JSON.stringify(l), state)
    return events.filter(e => e.type === 'context_update')
  }
  const userMessage = {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the files please' }] },
  }
  const tokenCount = (input: number) => ({
    type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, total_tokens: input }, model_context_window: 200000 } },
  })

  it('is estimated while Codex has reported no token_count', () => {
    const updates = run([{ type: 'session_meta', payload: { id: 'x' } }, userMessage])
    assert.ok(updates.length > 0, 'a context_update was emitted')
    for (const u of updates) assert.equal(u.payload.tokenSource, 'estimated')
  })

  it("is reported from the token_count on, and stays reported for later estimates' updates", () => {
    const updates = run([{ type: 'session_meta', payload: { id: 'x' } }, userMessage, tokenCount(12000), userMessage])
    const sources = updates.map(u => u.payload.tokenSource)
    assert.equal(sources[0], 'estimated')
    assert.equal(sources[sources.length - 1], 'reported')
    const authoritative = updates.find(u => u.payload.isAuthoritative === true)!
    assert.equal(authoritative.payload.tokenSource, 'reported')
    assert.equal(authoritative.payload.tokens, 12000)
  })
})

describe('Claude session-watcher context_update tokenSource', () => {
  const SESSION = '77777777-7777-4777-8777-777777777777'
  let SessionWatcher: typeof import('../src/session-watcher').SessionWatcher
  before(async () => {
    const vscodeShim = require('vscode') as { window: Record<string, unknown> }
    vscodeShim.window.setStatusBarMessage = () => ({ dispose() {} })
    ;({ SessionWatcher } = await import('../src/session-watcher'))
    const cwd = fs.realpathSync(process.cwd())
    const projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`),
      JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run the build' } }) + '\n')
  })
  after(() => fs.rmSync(fakeHome, { recursive: true, force: true }))

  it('the figure computed from the transcript is flagged estimated', () => {
    const watcher = new SessionWatcher()
    const out: AgentEvent[] = []
    watcher.onEvent(e => out.push(e))
    watcher.start()
    try {
      const updates = out.filter(e => e.type === 'context_update' && e.sessionId === SESSION)
      assert.ok(updates.length > 0, `the session was detected and announced a context_update (${out.map(e => e.type).join(',')})`)
      for (const u of updates) assert.equal(u.payload.tokenSource, 'estimated')
    } finally { watcher.dispose() }
  })
})

describe("teammate model provenance 'configured'", () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  const spawnOf = (meta: Record<string, unknown>) => {
    dir = tmpDir()
    writeTeammate(dir, { agentId: 'aaaa1111', meta, entries: [assistantText('ok')], mtimeMs: Date.now() - HOUR })
    const session = makeSession({ subagentsDir: dir })
    const h = makeHarness(session)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    h.closeWatchers()
    return ofType(h.events, 'agent_spawn').find(e => e.payload.name === 'alice')!
  }

  it('a sidecar naming a model: the model is marked configured (subagent-watcher)', () => {
    const s = spawnOf(teammateMeta('alice', { model: 'claude-sonnet-4-5' }))
    assert.equal(s.payload.model, 'claude-sonnet-4-5')
    assert.equal(s.payload.modelSource, 'configured')
  })

  it('a sidecar without a model: neither model nor modelSource', () => {
    const s = spawnOf(teammateMeta('alice', { model: undefined }))
    assert.ok(s)
    assert.equal('model' in s.payload, false)
    assert.equal('modelSource' in s.payload, false)
  })

  it('the lead dispatch result naming a model: the teammate node is marked configured (transcript-parser)', () => {
    const session = makeSession()
    const h = makeHarness(session)
    const feed = (entry: unknown) =>
      h.parser.processTranscriptLine(JSON.stringify(entry), 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1')
    feed({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s', name: 'Agent', input: { description: 'Audit', name: 'alice', subagent_type: 'general-purpose', prompt: 'p' } }] },
    })
    const result = (model?: string) => ({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: [{ type: 'text', text: 'Spawned successfully.' }] }] },
      toolUseResult: { status: 'teammate_spawned', agentId: 'aalice-1', name: 'alice', team_name: 'demo-team', agent_type: 'general-purpose', ...(model ? { model } : {}) },
    })
    feed(result('sonnet'))
    const spawns = ofType(h.events, 'agent_spawn').filter(e => e.payload.kind === 'teammate')
    assert.ok(spawns.length >= 1)
    const last = spawns[spawns.length - 1]
    assert.equal(last.payload.model, 'sonnet')
    assert.equal(last.payload.modelSource, 'configured')
  })
})

describe('normalization of the provenance keys', () => {
  it('effort and modelSource are identifiers: control characters and newlines are stripped, length capped', () => {
    const n = new SessionNormalizer('s1')
    const [out] = n.process({
      time: 1, type: 'model_detected',
      payload: { agent: 'orchestrator', model: 'gpt-5', effort: 'hi\u0000gh\n\u001b[31m' + 'x'.repeat(500), modelSource: 'conf\nigured\u0007' },
    })
    const p = out.payload as Record<string, string>
    assert.ok(p.effort.startsWith('high[31m'), p.effort)
    assert.ok(!/[\u0000-\u001f\u007f]/.test(p.effort + p.modelSource), 'no control character survives')
    assert.ok(p.effort.length <= NORM_ID_MAX, `capped, got ${p.effort.length}`)
    assert.equal(p.modelSource, 'configured')
    assert.ok(n.stats.clampedFields >= 2, 'the alteration is counted')
  })
})
