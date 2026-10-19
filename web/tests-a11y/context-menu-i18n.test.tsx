// #586 (suite de #373): the context menu speaks the interface language. The English labels are unchanged.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { contextMenuItems } from '@/components/agent-visualizer/context-menu-items'

const noop = () => {}
const actions = { showStats: false, showGrid: false, toggleStats: noop, zoomToFit: noop, toggleGrid: noop, clearHistory: noop, reloadSessionEvents: noop, showAgentDetails: noop }

test('context menu: the English labels are the ones the rest of the suite pins', () => {
  assert.deepEqual(contextMenuItems(false, actions).filter(i => !i.separator).map(i => i.label),
    ['Zoom to fit', 'Toggle stats', 'Toggle grid', 'Clear history', 'Reload session events'])
  assert.equal(contextMenuItems(false, actions).find(i => i.confirmLabel)?.confirmLabel, 'Confirm clear history')
  assert.equal(contextMenuItems(true, actions)[0].label, 'Show details')
})

test('context menu: in French every label, the confirmation included, is French and none is the English one', () => {
  const en = [...contextMenuItems(false, actions), ...contextMenuItems(true, actions)]
  const fr = [...contextMenuItems(false, actions, 'fr'), ...contextMenuItems(true, actions, 'fr')]
  assert.equal(fr.length, en.length)
  fr.forEach((item, i) => {
    if (item.separator) return
    assert.notEqual(item.label, en[i].label, item.label)
    if (item.confirmLabel) assert.notEqual(item.confirmLabel, en[i].confirmLabel)
  })
  assert.equal(fr.find(i => i.confirmLabel)?.confirmLabel, 'Confirmer l’effacement de l’historique')
})
