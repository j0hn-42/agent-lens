// #379: verbosity of the live announcements. "all" keeps today's behaviour; "important" tells only live
// failures and permission requests. Urgent states are never dropped, whatever the level.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAnnouncementQueue, enqueueAnnouncements } from '../web/components/agent-visualizer/canvas/a11y-model'
import { DEFAULT_UI_PREFS, sanitizePref, sanitizePrefs, parsePrefs, serializePrefs, ANNOUNCE_LEVELS } from '../web/lib/ui-preferences'
import type { StateTransition } from '../web/components/agent-visualizer/canvas/detect-state-changes'

type Level = 'all' | 'important'
const announce = (ts: StateTransition[], level?: Level) =>
  enqueueAnnouncements(createAnnouncementQueue(), ts, undefined, level ? { level } : {}).items

test('the level is a stored preference: default "all", invalid values fall back', () => {
  assert.deepEqual([...ANNOUNCE_LEVELS], ['all', 'important'])
  assert.equal(DEFAULT_UI_PREFS.announceLevel, 'all')
  assert.equal(sanitizePref('announceLevel', 'important'), 'important')
  for (const bad of ['quiet', '', 3, null, undefined, {}, ['important']]) assert.equal(sanitizePref('announceLevel', bad), 'all')
  assert.equal(sanitizePrefs({ v: 1, prefs: { announceLevel: 'important' } }).announceLevel, 'important')
  assert.equal(parsePrefs(serializePrefs({ ...DEFAULT_UI_PREFS, announceLevel: 'important' })).announceLevel, 'important')
})

test('each level announces its own transitions', () => {
  const live: StateTransition[] = [
    { kind: 'agent_spawn', id: 'a1', name: 'A' },
    { kind: 'agent_complete', id: 'a2', name: 'B' },
    { kind: 'agent_error', id: 'a3', name: 'C', live: true },
    { kind: 'agent_waiting_permission', id: 'a4', name: 'D', live: true },
    { kind: 'tool_error', id: 't1', name: 'Bash', live: true },
    { kind: 'message_sent', id: 'm1', from: 'A', to: 'B', link: 'l1' } as StateTransition,
  ]
  assert.deepEqual(announce(live, 'all').map(i => i.text), [
    'Agent C failed', 'Agent D is waiting for permission', 'Tool Bash failed',
    'Agent A started', 'Agent B completed', 'A sent a message to B',
  ])
  assert.deepEqual(announce(live, 'important').map(i => i.text), [
    'Agent C failed', 'Agent D is waiting for permission', 'Tool Bash failed',
  ])
  assert.deepEqual(announce(live), announce(live, 'all'), 'no level given: same as "all"')
})

test('"important" drops last-known states read from a history, which are not live', () => {
  const history: StateTransition[] = [
    { kind: 'agent_error', id: 'a1', name: 'C', live: false },
    { kind: 'agent_waiting_permission', id: 'a2', name: 'D', live: false },
  ]
  assert.equal(announce(history, 'all').length, 2)
  assert.equal(announce(history, 'important').length, 0)
})

test('a burst of 10 transitions with a permission and a failure: urgent states survive at every level', () => {
  const burst: StateTransition[] = [
    ...Array.from({ length: 8 }, (_, i) => ({ kind: 'agent_spawn' as const, id: `s${i}`, name: `n${i}` })),
    { kind: 'agent_waiting_permission', id: 'p', name: 'Reviewer', live: true },
    { kind: 'agent_error', id: 'e', name: 'Builder', live: true },
  ]
  const all = announce(burst, 'all')
  assert.deepEqual(all.filter(i => i.urgent).map(i => i.text), ['Agent Reviewer is waiting for permission', 'Agent Builder failed'])
  assert.ok(all.some(i => i.text === '8 agent graph updates'), 'the calm part is still summarised, exactly')
  const important = announce(burst, 'important')
  assert.deepEqual(important.map(i => i.text), ['Agent Reviewer is waiting for permission', 'Agent Builder failed'])
  assert.ok(important.every(i => i.urgent))
})

test('more urgent states than the sentence cap: the remainder is counted and stays urgent, at every level', () => {
  const many: StateTransition[] = Array.from({ length: 6 }, (_, i) => ({ kind: 'agent_waiting_permission' as const, id: `p${i}`, name: `n${i}`, live: true }))
  for (const level of ['all', 'important'] as const) {
    const items = announce(many, level)
    assert.equal(items.length, 4, level)
    assert.equal(items[3].text, 'and 3 more failures or permission requests', level)
    assert.ok(items.every(i => i.urgent), level)
  }
})

test('a level with nothing to say returns the same queue', () => {
  const q = createAnnouncementQueue()
  assert.equal(enqueueAnnouncements(q, [{ kind: 'agent_spawn', id: 'a', name: 'A' }], undefined, { level: 'important' }), q)
})
