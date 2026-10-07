import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSwimlaneArrows, arrowGeometry, filterArrowsByPair, buildMessageRows, arrowKindLabel, hitTestArrow,
  orderEntriesBySequence, capMessageRows, type SwimlaneLink,
} from '../web/lib/timeline-rows'

const L = { labelWidth: 100, headerHeight: 20, rowHeight: 24 }
const m = (id: string, type: string, timestamp: number, from?: string, to?: string, isError?: boolean) =>
  ({ id, type, content: `c-${id}`, timestamp, from, to, isError })

const links = new Map<string, SwimlaneLink>([
  ['l1', { id: 'l1', from: 'lead', to: 'child', messages: [m('d', 'dispatch', 2, 'lead', 'child'), m('r', 'return', 8, 'child', 'lead', true)] }],
  ['l2', { id: 'l2', from: 'mate1', to: 'mate2', messages: [m('p', 'message', 5, 'mate1', 'mate2'), m('x', 'assistant', 6, 'mate1', 'mate2')] }],
])
const ids = ['lead', 'child', 'mate1', 'mate2']

test('arrows: parent->child at dispatch, child->parent at return, peers between teammate rows', () => {
  const arrows = buildSwimlaneArrows(ids, links, id => id.toUpperCase())
  assert.deepEqual(arrows.map(a => [a.id, a.kind, a.fromRow, a.toRow]), [['d', 'dispatch', 0, 1], ['p', 'message', 2, 3], ['r', 'return', 1, 0]])
  assert.equal(arrows[2].isError, true)
  assert.equal(arrows[0].label, 'LEAD -> CHILD - DISPATCH')
  assert.equal(arrows[0].fromName, 'LEAD')
})

test('arrows skip endpoints without a row and plain messages', () => {
  assert.equal(buildSwimlaneArrows(['lead'], links).length, 0)
  assert.equal(buildSwimlaneArrows(ids, undefined).length, 0)
})

test('geometry: x follows time, y at row centres, clamped to the bar', () => {
  const arrows = buildSwimlaneArrows(ids, links)
  const g = arrowGeometry(arrows, 0, 10, 300, L)
  assert.deepEqual(g[0], { id: 'd', x: 100 + 0.2 * 200, y1: 20 + 12, y2: 20 + 24 + 12 })
  assert.equal(g[2].y1 > g[2].y2, true) // return goes back up
  const clamped = arrowGeometry(arrows, 4, 6, 300, L)
  assert.equal(clamped[0].x, 100)
  assert.equal(clamped[2].x, 300)
  assert.ok(arrowGeometry(arrows, 0, 0, 50, L).every(a => Number.isFinite(a.x)))
})

test('hover hit test finds the arrow near its vertical line', () => {
  const g = arrowGeometry(buildSwimlaneArrows(ids, links), 0, 10, 300, L)
  assert.equal(hitTestArrow(g, g[0].x + 2, 40), 'd')
  assert.equal(hitTestArrow(g, g[0].x + 30, 40), undefined)
})

test('pair filter on arrows works in both directions', () => {
  const arrows = buildSwimlaneArrows(ids, links)
  assert.deepEqual(filterArrowsByPair(arrows, 'child', 'lead').map(a => a.id), ['d', 'r'])
  assert.equal(filterArrowsByPair(arrows, 'lead', '').length, 3)
})

test('table rows list kind, from, to, time', () => {
  const rows = buildMessageRows(buildSwimlaneArrows(ids, links, id => id))
  assert.deepEqual(rows.map(r => [r.kindLabel, r.from, r.to, r.start]), [
    ['Dispatch', 'lead', 'child', '0:02'], ['Message', 'mate1', 'mate2', '0:05'], ['Return (error)', 'child', 'lead', '0:08'],
  ])
  assert.equal(arrowKindLabel('return', false), 'Return')
})

test('Sequence orders rows by first interaction, non-interacting agents last', () => {
  const entries = [
    { agentId: 'solo', startTime: 0 }, { agentId: 'mate2', startTime: 1 }, { agentId: 'child', startTime: 2 },
    { agentId: 'lead', startTime: 3 }, { agentId: 'mate1', startTime: 4 },
  ]
  assert.deepEqual(orderEntriesBySequence(entries, links).map(e => e.agentId), ['child', 'lead', 'mate2', 'mate1', 'solo'])
  assert.deepEqual(orderEntriesBySequence(entries, undefined).map(e => e.agentId), ['solo', 'mate2', 'child', 'lead', 'mate1'])
})

test('capMessageRows keeps the most recent rows', () => {
  assert.deepEqual(capMessageRows([1, 2, 3, 4], 2), { rows: [3, 4], hidden: 2 })
})
