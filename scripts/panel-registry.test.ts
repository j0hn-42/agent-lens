import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPanelRegistry } from '../web/hooks/use-panel-registry'

/** A panel that is open until Escape closes it; records the order in which panels were asked. */
function panel(log: string[], name: string, open = true) {
  const state = { open }
  const handler = () => { if (!state.open) return false; state.open = false; log.push(name); return true }
  return { state, handler }
}

test('Escape asks the most recently registered panel first (LIFO)', () => {
  const log: string[] = []
  const reg = createPanelRegistry()
  for (const n of ['a', 'b', 'c']) reg.register(n, panel(log, n).handler)
  assert.equal(reg.escape(), true)
  assert.deepEqual(log, ['c'])
  assert.equal(reg.escape(), true); assert.equal(reg.escape(), true)
  assert.deepEqual(log, ['c', 'b', 'a'])
  assert.equal(reg.escape(), false, 'nothing left to close')
})

test('a panel registered later closes before an earlier one, even when both are open', () => {
  const log: string[] = []
  const reg = createPanelRegistry()
  const early = panel(log, 'early'); const late = panel(log, 'late')
  reg.register('early', early.handler)
  reg.register('late', late.handler)
  reg.escape()
  assert.equal(late.state.open, false); assert.equal(early.state.open, true)
})

test('panels with nothing to close are skipped and the next open one closes', () => {
  const log: string[] = []
  const reg = createPanelRegistry()
  const open = panel(log, 'open'); const closed = panel(log, 'closed', false)
  reg.register('open', open.handler); reg.register('closed', closed.handler)
  assert.equal(reg.escape(), true)
  assert.deepEqual(log, ['open'])
  assert.equal(open.state.open, false)
})

test('unregistering mid-stack keeps the order of the others', () => {
  const log: string[] = []
  const reg = createPanelRegistry()
  reg.register('a', panel(log, 'a').handler)
  const offB = reg.register('b', panel(log, 'b').handler)
  reg.register('c', panel(log, 'c').handler)
  offB()
  assert.deepEqual(reg.ids(), ['a', 'c'])
  reg.escape(); reg.escape()
  assert.deepEqual(log, ['c', 'a'], 'b is never asked')
  offB() // double unregister is harmless
  assert.deepEqual(reg.ids(), ['a', 'c'])
})

test('re-registering an id replaces the handler and moves it to the top; the stale unregister is a no-op', () => {
  const log: string[] = []
  const reg = createPanelRegistry()
  const offOld = reg.register('x', panel(log, 'x-old').handler)
  reg.register('y', panel(log, 'y').handler)
  reg.register('x', panel(log, 'x-new').handler)
  assert.deepEqual(reg.ids(), ['y', 'x'])
  offOld()
  assert.deepEqual(reg.ids(), ['y', 'x'], 'stale cleanup must not remove the new registration')
  reg.escape()
  assert.deepEqual(log, ['x-new'])
})

test('one Escape never closes two panels', () => {
  const log: string[] = []
  const reg = createPanelRegistry()
  const panels = ['a', 'b', 'c', 'd'].map(n => ({ n, ...panel(log, n) }))
  for (const p of panels) reg.register(p.n, p.handler)
  reg.escape()
  assert.equal(panels.filter(p => !p.state.open).length, 1)
  reg.escape()
  assert.equal(panels.filter(p => !p.state.open).length, 2)
})

test('a handler that unregisters itself while closing does not disturb the pass', () => {
  const log: string[] = []
  const reg = createPanelRegistry()
  reg.register('a', panel(log, 'a').handler)
  let off = () => {}
  off = reg.register('b', () => { off(); log.push('b'); return true })
  assert.equal(reg.escape(), true)
  assert.deepEqual(log, ['b'])
  assert.deepEqual(reg.ids(), ['a'])
})

test('a throwing handler counts as "nothing to close" and the next panel is asked', () => {
  const log: string[] = []
  const reg = createPanelRegistry()
  reg.register('a', panel(log, 'a').handler)
  reg.register('bad', () => { throw new Error('boom') })
  const logged: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    assert.equal(reg.escape(), true)
  } finally {
    console.error = original
  }
  assert.deepEqual(log, ['a'])
  assert.equal(logged.length, 1, 'the failure leaves a trace (a panel bug must not become invisible)')
  assert.match(String(logged[0][0]), /"bad"/)
})
