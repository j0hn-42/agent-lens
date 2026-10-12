import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { nextInspectorMemory, goneText, type InspectorMemory } from '../web/lib/inspector-model'

// What the card shows for a peer or a missing node is proven on the real component: web/tests-a11y/inspector-own-state.test.tsx

test('memory keeps the last known name of a selection that disappears', () => {
  const mem: InspectorMemory | null = nextInspectorMemory(null, 's2:main', { name: 'Reviewer' })
  assert.deepEqual(mem, { id: 's2:main', name: 'Reviewer' })
  assert.equal(nextInspectorMemory(mem, 's2:main', undefined), mem, 'memory survives the disappearance')
  assert.equal(nextInspectorMemory(mem, 's2:main', { name: 'Reviewer' }), mem, 'same name: same object')
  assert.deepEqual(nextInspectorMemory(mem, 's2:main', { name: 'Renamed' }), { id: 's2:main', name: 'Renamed' })
  assert.equal(goneText('Reviewer'), 'Reviewer is no longer listed')
  assert.equal(goneText(null), 'This node is no longer listed')
})

test('rapid selection change: memory never leaks the previous node name', () => {
  let mem = nextInspectorMemory(null, 's1:main', { name: 'Anchor' })
  mem = nextInspectorMemory(mem, 's2:main', undefined)
  assert.equal(mem, null, 'the new selection is unknown: no name rather than the previous one')
  assert.equal(nextInspectorMemory(mem, null, undefined), null)
})
