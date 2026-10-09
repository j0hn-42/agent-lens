import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { SHORTCUTS, SHORTCUT_GROUPS, graphKeyboardHelp } from '../web/lib/shortcuts'
import { keyToAction } from '../web/components/agent-visualizer/canvas/keyboard-nav'
import { nextMenuIndex, clampMenuPosition } from '../web/lib/menu-nav'
import { getStateLabel } from '../web/lib/state-labels'

test('SHORTCUTS keys are unique and non-empty', () => {
  const keys = SHORTCUTS.map(s => s.key)
  assert.equal(new Set(keys).size, keys.length)
  for (const s of SHORTCUTS) {
    assert.ok(s.display.length > 0)
    assert.ok(s.description.length > 0)
  }
})

test('SHORTCUTS covers the keys handled by the hook', () => {
  const keys = new Set(SHORTCUTS.map(s => s.key))
  for (const k of [' ', 'f', 'F', 'z', 't', 'c', 'g', 's', '$', 'm', '1', '2', '3', '4', 'Escape', '?']) {
    assert.ok(keys.has(k), k)
  }
})

test('nextMenuIndex wraps and supports Home/End', () => {
  assert.equal(nextMenuIndex(0, 3, 'ArrowUp'), 2)
  assert.equal(nextMenuIndex(2, 3, 'ArrowDown'), 0)
  assert.equal(nextMenuIndex(1, 3, 'Home'), 0)
  assert.equal(nextMenuIndex(1, 3, 'End'), 2)
  assert.equal(nextMenuIndex(1, 3, 'a'), null)
  assert.equal(nextMenuIndex(0, 0, 'ArrowDown'), null)
})

test('clampMenuPosition keeps the menu in the viewport', () => {
  const vp = { width: 400, height: 300 }
  const size = { width: 160, height: 100 }
  assert.deepEqual(clampMenuPosition({ x: 390, y: 290 }, size, vp), { left: 232, top: 192 })
  assert.deepEqual(clampMenuPosition({ x: -5, y: -5 }, size, vp), { left: 8, top: 8 })
})

test('getStateLabel maps states to readable labels', () => {
  assert.equal(getStateLabel('tool_calling'), 'Calling tool')
  assert.equal(getStateLabel('waiting_permission'), 'Waiting for permission')
  assert.equal(getStateLabel('some_new_state'), 'some new state')
})

test('the Graph group lists exactly the keys keyboard-nav.ts maps to an action (#127)', () => {
  assert.ok((SHORTCUT_GROUPS as readonly string[]).includes('Graph'))
  const documented = new Set(SHORTCUTS.filter(s => s.group === 'Graph').flatMap(s => s.handles ?? []))
  const probes = [
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', '0', 'Enter', ' ', 'ContextMenu', 'F10',
    'Delete', 'Backspace', 'Tab', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', '1', 'a', 'f', '*', '/',
  ]
  const handled = new Set<string>()
  for (const key of probes) {
    for (const shiftKey of [false, true]) {
      if (keyToAction({ key, shiftKey, ctrlKey: false, metaKey: false, altKey: false })) handled.add(key)
    }
  }
  assert.deepEqual([...documented].sort(), [...handled].sort())
})

test('every Graph entry has keys, and the sr-only description is generated from the table (#127)', () => {
  const graph = SHORTCUTS.filter(s => s.group === 'Graph')
  assert.ok(graph.length >= 6)
  for (const g of graph) assert.ok(g.handles && g.handles.length > 0, g.key)
  const text = graphKeyboardHelp()
  for (const g of graph) assert.ok(text.includes(g.description), g.description)
})

test('panel shortcuts: Context (P) and Stats (S) are in the table (#124)', () => {
  const byKey = new Map(SHORTCUTS.map(s => [s.key, s]))
  assert.equal(byKey.get('p')!.group, 'Panels')
  assert.match(byKey.get('p')!.description, /^Toggle Context panel/)
  assert.equal(byKey.get('s')!.description, 'Toggle Stats panel')
})
