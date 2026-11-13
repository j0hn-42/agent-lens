// Burrow view: the name tag under each animal. Without it, with several agents nothing says which animal is which agent.
// The tags follow the graph: a tag that would cover another tag or a bubble is hidden, the selected and the hovered
// agent always keep theirs, and an animal outside the burrow or in the doorway has none.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { truncateName, cullTags, showsTag, nextTagNames, BURROW_TAG_MAX_CHARS, type TagBox } from '../web/lib/burrow/burrow-labels'

test('truncateName: a short name is kept as is', () => {
  assert.equal(truncateName('alpha'), 'alpha')
  assert.equal(truncateName('x'.repeat(BURROW_TAG_MAX_CHARS)), 'x'.repeat(BURROW_TAG_MAX_CHARS))
})

test('truncateName: a long name is cut to the limit, the last character being an ellipsis', () => {
  const out = truncateName('frontend-engineer-worker-42')
  assert.equal(Array.from(out).length, BURROW_TAG_MAX_CHARS)
  assert.equal(out, 'frontend-engine…')
  assert.equal(truncateName('abcdef', 4), 'abc…')
})

test('truncateName: characters outside the BMP are never split, surrounding spaces are trimmed', () => {
  assert.equal(truncateName('🦊'.repeat(20), 5), '🦊🦊🦊🦊…')
  assert.equal(truncateName('  beta  '), 'beta')
  assert.equal(truncateName('abc def', 5), 'abc…')
})

test('showsTag: only an animal on the floor of the burrow has a tag (not outside, not in the doorway)', () => {
  for (const m of ['idle', 'walk', 'queue', 'sit', 'hopOn', 'hopOff']) assert.equal(showsTag(m), true, m)
  for (const m of ['home', 'doorIn', 'doorOut']) assert.equal(showsTag(m), false, m)
})

const box = (key: string, x: number, y: number, w = 40, h = 10): TagBox => ({ key, x, y, w, h })

test('cullTags: tags that do not touch each other are all shown', () => {
  const shown = cullTags([box('a', 0, 0), box('b', 100, 0), box('c', 0, 50)], [])
  assert.deepEqual([...shown].sort(), ['a', 'b', 'c'])
})

test('cullTags: of two overlapping tags only one is shown, the same one whatever the input order', () => {
  const one = cullTags([box('a', 0, 0), box('b', 20, 5)], [])
  const two = cullTags([box('b', 20, 5), box('a', 0, 0)], [])
  assert.equal(one.size, 1)
  assert.deepEqual([...one], [...two])
})

test('cullTags: a tag that would cover a bubble is hidden', () => {
  const shown = cullTags([box('a', 0, 0), box('b', 100, 0)], [{ x: 110, y: 2, w: 60, h: 20 }])
  assert.deepEqual([...shown], ['a'])
})

test('cullTags: the selected and the hovered agent always keep their tag, and push the others away', () => {
  const tags = [box('a', 0, 0), box('b', 10, 2), box('c', 20, 4)]
  const bubble = { x: 0, y: 0, w: 200, h: 20 }
  const shown = cullTags(tags, [bubble], { always: ['c', 'b'] })
  assert.deepEqual([...shown].sort(), ['b', 'c'])
  // without a priority, the bubble hides them all
  assert.equal(cullTags(tags, [bubble]).size, 0)
})

test('cullTags: a tag shown at the previous frame keeps its place against a newcomer (no flicker)', () => {
  const tags = [box('a', 0, 0), box('b', 20, 5)]
  assert.deepEqual([...cullTags(tags, [], { previous: new Set(['b']) })], ['b'])
  assert.deepEqual([...cullTags(tags, [], { previous: new Set(['a']) })], ['a'])
})

test('cullTags: boxes that only share an edge do not overlap', () => {
  assert.equal(cullTags([box('a', 0, 0, 40, 10), box('b', 40, 0, 40, 10)], []).size, 2)
})

// With reduced motion or Freeze motion the tags are placed again only when the scene is marked as changed: a renamed
// agent (its label arrives after it spawned) must mark it, or its tag keeps the old name while the list shows the new one.
test('nextTagNames: a rename is a change, the same names are not', () => {
  const prev = new Map([['s1:a', 'agent-1'], ['s1:b', 'beta']])
  const same = nextTagNames(prev, [{ id: 's1:a', name: 'agent-1' }, { id: 's1:b', name: 'beta' }])
  assert.equal(same.changed, false)
  assert.equal(same.names, prev, 'unchanged names keep the same map')
  const renamed = nextTagNames(prev, [{ id: 's1:a', name: 'Reviewer' }, { id: 's1:b', name: 'beta' }])
  assert.equal(renamed.changed, true)
  assert.equal(renamed.names.get('s1:a'), 'Reviewer')
  assert.equal(nextTagNames(prev, [{ id: 's1:a', name: 'agent-1' }]).changed, true, 'an agent gone is a change')
  assert.equal(nextTagNames(prev, [...prev].map(([id, name]) => ({ id, name })).concat({ id: 's1:c', name: 'c' })).changed, true, 'a new agent is a change')
})
