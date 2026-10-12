// #245: presentation mode (subtitles of transitions, masking of sensitive data, automatic follow).
// Pure rules only: nothing is shown that an observed event does not prove.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  PRESENTATION_STORAGE_KEY, DEFAULT_PRESENTATION_OPTIONS, parsePresentationOptions, serializePresentationOptions,
  maskText, maskedClusterLabelSource, agentRoleLabel, snapshotOf, transitionSubtitle, pickFollowAgent, followTransform,
  MAX_SUBTITLE_LENGTH, INITIAL_FOLLOW, stepFollow,
} from '../web/lib/presentation'
import { SHORTCUTS } from '../web/lib/shortcuts'
import type { Agent } from '../web/lib/agent-types'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    agentKey: over.id, sessionId: 's1', localId: over.id, displayName: over.id, name: over.id, state: 'idle', parentId: null, parentKey: null,
    tokensUsed: 0, tokensMax: 200000, contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    ...over,
  } as Agent
}

test('options: defaults, round trip, and hostile storage never throws', () => {
  assert.deepEqual(parsePresentationOptions(null), DEFAULT_PRESENTATION_OPTIONS)
  assert.deepEqual(parsePresentationOptions(undefined), DEFAULT_PRESENTATION_OPTIONS)
  assert.deepEqual(parsePresentationOptions('not json'), DEFAULT_PRESENTATION_OPTIONS)
  assert.deepEqual(parsePresentationOptions('[1,2]'), DEFAULT_PRESENTATION_OPTIONS)
  const custom = { subtitles: false, mask: true, follow: false }
  assert.deepEqual(parsePresentationOptions(serializePresentationOptions(custom)), custom)
  // a value that is not a boolean falls back to its default, other keys are dropped
  assert.deepEqual(parsePresentationOptions('{"subtitles":"no","mask":false,"follow":1,"x":true}'), { ...DEFAULT_PRESENTATION_OPTIONS, mask: false })
  assert.match(PRESENTATION_STORAGE_KEY, /^agent-lens:/)
})

test('masking is on by default: a demo must be safe before it is configured', () => {
  assert.equal(DEFAULT_PRESENTATION_OPTIONS.mask, true)
})

test('maskText hides every visible character, keeps the length and the spaces, and is idempotent', () => {
  assert.equal(maskText('/home/jo/app.ts'), '•'.repeat('/home/jo/app.ts'.length))
  assert.equal(maskText('a b'), '• •')
  assert.equal(maskText(''), '')
  assert.equal(maskText(maskText('secret key')), maskText('secret key'))
  assert.equal(maskText(undefined), '')
  assert.ok(!/[A-Za-z0-9]/.test(maskText('token abc123')))
})

test('maskedClusterLabelSource masks the title, workspace and project but not the counts', () => {
  const c = { title: 'client-secret-repo', workspace: '/home/jo/client', projectName: 'client', memberIds: ['a'] }
  const m = maskedClusterLabelSource(c)
  assert.equal(m.title, maskText('client-secret-repo'))
  assert.equal(m.workspace, maskText('/home/jo/client'))
  assert.equal(m.projectName, maskText('client'))
  assert.deepEqual(m.memberIds, ['a'])
  assert.equal(maskedClusterLabelSource<{ title: string; workspace?: string; memberIds: string[] }>({ title: 't', memberIds: [] }).workspace, undefined)
})

test('agentRoleLabel names the role, never the prompt', () => {
  assert.equal(agentRoleLabel(agent({ id: 'a', isMain: true })), 'Main agent')
  assert.equal(agentRoleLabel(agent({ id: 'a', kind: 'subagent' })), 'Sub-agent')
  assert.equal(agentRoleLabel(agent({ id: 'a', kind: 'teammate' })), 'Teammate')
  assert.equal(agentRoleLabel(agent({ id: 'a', parentId: 'p' })), 'Sub-agent')
})

test('transitionSubtitle: a state change observed live gives a sentence with both states', () => {
  const prev = snapshotOf(agent({ id: 'a', name: 'Refactor payments', state: 'thinking' }))
  const next = agent({ id: 'a', name: 'Refactor payments', state: 'tool_calling', currentTool: 'Read', freshnessSource: 'live', lastEventAt: 5 })
  assert.equal(transitionSubtitle(prev, next, false), 'Refactor payments: Thinking → Calling tool Read')
})

test('transitionSubtitle: no change, no subtitle', () => {
  const a = agent({ id: 'a', state: 'thinking', lastEventAt: 1 })
  assert.equal(transitionSubtitle(snapshotOf(a), { ...a, x: 10 }, false), null)
})

test('transitionSubtitle: a new tool while still calling tools is a transition', () => {
  const a = agent({ id: 'a', name: 'Main', state: 'tool_calling', currentTool: 'Read', lastEventAt: 1 })
  const b = { ...a, currentTool: 'Edit' }
  assert.equal(transitionSubtitle(snapshotOf(a), b, false), 'Main: Calling tool Read → Calling tool Edit')
})

test('transitionSubtitle: an agent unknown before is announced as started, with its observed state', () => {
  const a = agent({ id: 'a', name: 'Explore', state: 'thinking', lastEventAt: 1, freshnessSource: 'live' })
  assert.equal(transitionSubtitle(undefined, a, false), 'Explore: started (Thinking)')
})

test('transitionSubtitle: replayed history and imported transcripts prove no live transition', () => {
  const prev = snapshotOf(agent({ id: 'a', state: 'thinking' }))
  for (const freshnessSource of ['history', 'imported'] as const) {
    assert.equal(transitionSubtitle(prev, agent({ id: 'a', state: 'complete', freshnessSource, lastEventAt: 1 }), false), null)
    assert.equal(transitionSubtitle(undefined, agent({ id: 'a', state: 'thinking', freshnessSource, lastEventAt: 1 }), false), null)
  }
})

test('transitionSubtitle: an agent never observed live (no lastEventAt) proves nothing', () => {
  assert.equal(transitionSubtitle(snapshotOf(agent({ id: 'a', state: 'idle' })), agent({ id: 'a', state: 'thinking' }), false), null)
})

test('transitionSubtitle: masked, the name is the role and the tool is the only free text kept', () => {
  const prev = snapshotOf(agent({ id: 'a', state: 'thinking', isMain: true }))
  const next = agent({ id: 'a', name: 'Fix the leak in /home/jo/client/secret.ts', isMain: true, state: 'tool_calling', currentTool: 'Edit', lastEventAt: 1 })
  const s = transitionSubtitle(prev, next, true)!
  assert.equal(s, 'Main agent: Thinking → Calling tool Edit')
  assert.ok(!s.includes('secret'))
})

test('transitionSubtitle: an MCP tool shows its tool, not the server', () => {
  const prev = snapshotOf(agent({ id: 'a', state: 'thinking' }))
  const s = transitionSubtitle(prev, agent({ id: 'a', name: 'M', state: 'tool_calling', currentTool: 'mcp__crm_prod__lookup_customer', lastEventAt: 1 }), false)!
  assert.ok(s.endsWith('Calling tool lookup_customer'), s)
  assert.ok(!s.includes('crm_prod'))
})

test('transitionSubtitle: control characters are stripped and the length is bounded', () => {
  const prev = snapshotOf(agent({ id: 'a', state: 'thinking' }))
  const s = transitionSubtitle(prev, agent({ id: 'a', name: 'x\u0000y\n' + 'z'.repeat(500), state: 'complete', lastEventAt: 1 }), false)!
  assert.ok(!/[\u0000-\u001f]/.test(s))
  assert.ok(s.length <= MAX_SUBTITLE_LENGTH)
})

test('pickFollowAgent: the most recently active working agent, never an invented one', () => {
  const a = agent({ id: 'a', state: 'thinking', lastEventAt: 10, freshnessSource: 'live' })
  const b = agent({ id: 'b', state: 'tool_calling', lastEventAt: 20, freshnessSource: 'live' })
  const c = agent({ id: 'c', state: 'complete', lastEventAt: 99, freshnessSource: 'live' })
  assert.equal(pickFollowAgent([a, b, c])?.id, 'b')
  assert.equal(pickFollowAgent([c, agent({ id: 'd', state: 'idle', lastEventAt: 5 })]), null)
  assert.equal(pickFollowAgent([]), null)
})

test('pickFollowAgent: a waiting agent counts, archived, replayed and unobserved agents do not', () => {
  assert.equal(pickFollowAgent([agent({ id: 'w', state: 'waiting_permission', lastEventAt: 3 })])?.id, 'w')
  assert.equal(pickFollowAgent([agent({ id: 'x', state: 'thinking', lastEventAt: 3, archived: true })]), null)
  assert.equal(pickFollowAgent([agent({ id: 'x', state: 'thinking', lastEventAt: 3, freshnessSource: 'history' })]), null)
  assert.equal(pickFollowAgent([agent({ id: 'x', state: 'thinking', lastEventAt: 3, freshnessSource: 'imported' })]), null)
  assert.equal(pickFollowAgent([agent({ id: 'x', state: 'thinking' })]), null)
})

test('pickFollowAgent: ties are broken by id so the camera does not flicker', () => {
  const a = agent({ id: 'a', state: 'thinking', lastEventAt: 7 })
  const b = agent({ id: 'b', state: 'thinking', lastEventAt: 7 })
  assert.equal(pickFollowAgent([b, a])?.id, 'a')
  assert.equal(pickFollowAgent([a, b])?.id, 'a')
})

test('followTransform centres the agent in the free area and keeps the zoom', () => {
  const t = followTransform({ x: 100, y: 50 }, { x: 0, y: 0, scale: 2 }, { width: 800, height: 600 }, { top: 0, right: 0, bottom: 0, left: 0 })
  assert.equal(t.scale, 2)
  assert.equal(t.x + 100 * 2, 400)
  assert.equal(t.y + 50 * 2, 300)
  const inset = followTransform({ x: 0, y: 0 }, { x: 0, y: 0, scale: 1 }, { width: 800, height: 600 }, { top: 100, right: 200, bottom: 0, left: 0 })
  assert.equal(inset.x, 300)
  assert.equal(inset.y, 350)
})

test('followTransform survives a degenerate free area', () => {
  const t = followTransform({ x: 1, y: 1 }, { x: 0, y: 0, scale: 1 }, { width: 100, height: 100 }, { top: 90, right: 90, bottom: 90, left: 90 })
  assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y))
})

test('the shortcut table documents V for presentation mode', () => {
  const v = SHORTCUTS.find(s => s.key === 'v')
  assert.ok(v, 'v is listed')
  assert.match(v!.description, /presentation/i)
  assert.equal(v!.singleKey, true)
})

test('stepFollow: tracks the picked agent, a manual pan or zoom suspends it until the target changes', () => {
  let r = stepFollow(INITIAL_FOLLOW, 'a', false)
  assert.equal(r.track, true)
  r = stepFollow(r.state, 'a', true)
  assert.equal(r.track, false, 'manual navigation suspends following')
  r = stepFollow(r.state, 'a', false)
  assert.equal(r.track, false, 'stays suspended while the same agent is the target')
  r = stepFollow(r.state, 'b', false)
  assert.equal(r.track, true, 'a new target resumes following')
  r = stepFollow(r.state, null, false)
  assert.equal(r.track, false, 'no working agent: the camera stays where it is')
  r = stepFollow(r.state, 'b', false)
  assert.equal(r.track, true, 'the same agent working again resumes')
})
