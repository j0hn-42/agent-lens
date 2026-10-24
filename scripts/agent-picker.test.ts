// Agent picker of the Conversation panel: threshold, groups (team / workflow, session, finished), search and unread filter.
import './all-locales' // #662: both languages are loaded before the tests
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_PICKER_MIN, usesAgentPicker, agentPickerGroups, filterPickerIds, doneCollapsedByDefault,
} from '../web/lib/feed-utils'

type A = { name: string; sessionId: string; sessionLabel?: string; teamName?: string; teamKind?: 'team' | 'workflow'; state?: string; activity?: string; archived?: boolean; isMain?: boolean }
const ag = (name: string, extra: Partial<A> = {}): A => ({ name, sessionId: 's1', state: 'idle', ...extra })

test('below AGENT_PICKER_MIN agents with messages the panel keeps its tabs; from it on, the picker', () => {
  assert.equal(AGENT_PICKER_MIN, 5)
  assert.equal(usesAgentPicker(4), false)
  assert.equal(usesAgentPicker(5), true)
  assert.equal(usesAgentPicker(83), true)
})

test('groups: the agents of no team first (the main agent), then team and workflow members, finished agents last in their own group', () => {
  const agents = new Map<string, A>([
    ['o', ag('orchestrator', { isMain: true })],
    ['b1', ag('builder-01', { teamName: 'mega', teamKind: 'workflow' })],
    ['b2', ag('builder-02', { teamName: 'mega', teamKind: 'workflow', activity: 'done' })],
    ['r1', ag('reviewer-01', { teamName: 'crew', teamKind: 'team', state: 'thinking' })],
    ['x', ag('explore', { state: 'complete' })],
  ])
  const groups = agentPickerGroups(['o', 'b1', 'b2', 'r1', 'x'], agents, undefined)
  assert.deepEqual(groups.map(g => [g.kind, g.name, g.ids]), [
    ['active', '', ['o']],
    ['team', 'crew', ['r1']],
    ['workflow', 'mega', ['b1']],
    ['done', '', ['b2', 'x']],
  ])
  // every id is in exactly one group: nothing disappears
  assert.equal(groups.flatMap(g => g.ids).length, 5)
})

test('groups: with several sessions the agents of no team are grouped by session (label, else the start of the id)', () => {
  const agents = new Map<string, A>([
    ['a', ag('alpha', { sessionId: 'aaaaaaaa-1111', sessionLabel: 'Main' })],
    ['b', ag('beta', { sessionId: 'bbbbbbbb-2222' })],
    ['c', ag('gamma', { sessionId: 'aaaaaaaa-1111', sessionLabel: 'Main' })],
  ])
  const groups = agentPickerGroups(['a', 'b', 'c'], agents, undefined)
  assert.deepEqual(groups.map(g => [g.kind, g.name, g.ids]), [
    ['session', 'Main', ['a', 'c']],
    ['session', 'bbbbbbbb', ['b']],
  ])
})

test('search matches the agent name (case and accents ignored) and the team name; unread-only keeps the unread agents', () => {
  const agents = new Map<string, A>([
    ['b1', ag('Builder-01', { teamName: 'mega', teamKind: 'workflow' })],
    ['b2', ag('builder-02', { teamName: 'mega', teamKind: 'workflow' })],
    ['r', ag('révision')],
  ])
  const ids = ['b1', 'b2', 'r']
  assert.deepEqual(filterPickerIds(ids, agents, { query: 'BUILDER-0', unreadOnly: false, unread: new Set() }), ['b1', 'b2'])
  assert.deepEqual(filterPickerIds(ids, agents, { query: 'revis', unreadOnly: false, unread: new Set() }), ['r'])
  assert.deepEqual(filterPickerIds(ids, agents, { query: 'mega', unreadOnly: false, unread: new Set() }), ['b1', 'b2'])
  assert.deepEqual(filterPickerIds(ids, agents, { query: '', unreadOnly: true, unread: new Set(['b2']) }), ['b2'])
  assert.deepEqual(filterPickerIds(ids, agents, { query: '  ', unreadOnly: false, unread: new Set() }), ids)
})

test('finished agents are folded by default only when there are many of them, and never when the selected agent is one', () => {
  assert.equal(doneCollapsedByDefault(5, false), false)
  assert.equal(doneCollapsedByDefault(6, false), true)
  assert.equal(doneCollapsedByDefault(30, true), false)
})

test('the counts of the picker are written for the language (Intl.NumberFormat) and take its plural (Intl.PluralRules)', async () => {
  const { formatCount, pluralCountText } = await import('../web/lib/panel-text')
  const fr = new Intl.NumberFormat('fr').format(1234)
  assert.notEqual(fr, '1234', 'French groups the thousands')
  assert.equal(formatCount('fr', 1234), fr)
  assert.equal(formatCount('en', 1234), '1,234')
  assert.equal(pluralCountText('en', 'conv.picker.count', 1234, { total: 2000 }), '1,234 agents of 2,000')
  assert.equal(pluralCountText('fr', 'conv.picker.count', 1234, { total: 2000 }), `${fr} agents sur ${new Intl.NumberFormat('fr').format(2000)}`)
  // The pill counts agents, not messages, and says so
  assert.equal(pluralCountText('fr', 'conv.picker.unread', 1), '1 agent avec des messages non lus')
  assert.equal(pluralCountText('fr', 'conv.picker.unread', 0), '0 agent avec des messages non lus', 'French: 0 is singular')
  assert.equal(pluralCountText('en', 'conv.picker.unread', 2), '2 agents with unread messages')
  assert.equal(pluralCountText('en', 'conv.picker.unread', 1), '1 agent with unread messages')
})
