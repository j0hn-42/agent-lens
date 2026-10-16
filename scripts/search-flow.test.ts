// Flow from a Grep tool card to the file cards its output listed (#384). The link is proven by the
// tool_use_id and the agent, never inferred; nothing is drawn for a call that is missing or not complete; a
// frozen scene keeps a static line and an arrowhead (the direction is not carried by motion).
import './canvas-recorder'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { recordingContext, stubDocument } from './canvas-recorder'
import { SEARCH_DISCOVERY, MIN_VISIBLE_OPACITY } from '../web/lib/canvas-constants'
import { searchFlowSegments, drawSearchFlow } from '../web/components/agent-visualizer/canvas/search-flow'

stubDocument()

/* eslint-disable @typescript-eslint/no-explicit-any */
function call(over: Record<string, unknown> = {}): any {
  return { id: 'c1', agentId: 'a1', toolName: 'Grep', args: 'foo', state: 'complete', toolUseId: 'tu1', x: 100, y: 200, startTime: 0, opacity: 1, ...over }
}
function disc(i: number, over: Record<string, unknown> = {}): any {
  return {
    id: `disc-a1-tu1-${i}`, agentId: 'a1', type: 'file', label: `f${i}.ts`, content: `src/f${i}.ts`,
    x: 100 + SEARCH_DISCOVERY.offsetX, y: 200 + i * SEARCH_DISCOVERY.gapY, targetX: 0, targetY: 0, opacity: 0.9, timestamp: 0,
    toolUseId: 'tu1', listing: { tool: 'Grep', position: i + 1, reported: 9, shown: 3 }, ...over,
  }
}
const calls = (...l: any[]): Map<string, any> => new Map(l.map(c => [c.id, c]))
const size = () => ({ w: 120, h: 40 })

test('a card whose call is present and complete gets one segment, tool card edge to card edge (#384)', () => {
  const segs = searchFlowSegments([disc(0), disc(1)], calls(call()), size)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].toolCallId, 'c1')
  assert.equal(segs[0].x1, 160, 'starts at the right edge of the tool card')
  assert.equal(segs[0].y1, 200)
  assert.ok(segs[0].x2 < 100 + SEARCH_DISCOVERY.offsetX && segs[0].x2 > segs[0].x1, 'ends at the left edge of the file card')
})

test('no matching call, another agent, another tool_use_id, or no tool_use_id: nothing (#384)', () => {
  assert.equal(searchFlowSegments([disc(0)], calls(), size).length, 0)
  assert.equal(searchFlowSegments([disc(0)], calls(call({ agentId: 'a2' })), size).length, 0)
  assert.equal(searchFlowSegments([disc(0)], calls(call({ toolUseId: 'other' })), size).length, 0)
  assert.equal(searchFlowSegments([disc(0, { toolUseId: undefined })], calls(call({ toolUseId: undefined })), size).length, 0)
  assert.equal(searchFlowSegments([disc(0, { listing: undefined })], calls(call()), size).length, 0, 'a card not made from a search')
})

test('a call that is not complete draws nothing (#384)', () => {
  for (const state of ['running', 'error', 'cancelled', 'expired']) {
    assert.equal(searchFlowSegments([disc(0)], calls(call({ state })), size).length, 0, state)
  }
})

test('an expired card or a faded call draws nothing; opacity follows the card (#384)', () => {
  assert.equal(searchFlowSegments([disc(0, { opacity: MIN_VISIBLE_OPACITY / 2 })], calls(call()), size).length, 0)
  assert.equal(searchFlowSegments([disc(0)], calls(call({ opacity: 0 })), size).length, 0)
  assert.equal(searchFlowSegments([disc(0, { opacity: 0.5 })], calls(call()), size)[0].opacity, 0.5)
})

test('at most SEARCH_DISCOVERY.maxPerCall segments per call (#384)', () => {
  const many = Array.from({ length: 12 }, (_, i) => disc(i))
  assert.equal(searchFlowSegments(many, calls(call()), size).length, SEARCH_DISCOVERY.maxPerCall)
})

function draw(segs: any[], reduced: boolean, time = 1.3) {
  const rec = recordingContext(1)
  drawSearchFlow(rec.ctx, segs, time, { reducedMotion: reduced, zoom: 1, showCost: false, showStats: false })
  return rec
}

test('chips stay on their line, move with the clock and are spread out (#384)', () => {
  const segs = searchFlowSegments([disc(0), disc(0, { id: 'd-b' }), disc(0, { id: 'd-c' })], calls(call()), size)
  const arcs = (t: number) => draw(segs, false, t).ops.filter(o => o.name === 'arc').map(o => o.args as number[])
  for (let t = 0; t < 6; t += 0.41) {
    for (const [x] of arcs(t)) assert.ok(x >= segs[0].x1 && x <= segs[0].x2, 'inside the line')
  }
  assert.notEqual(arcs(1)[0][0], arcs(1)[1][0], 'chips of one call do not pile up')
  assert.notEqual(arcs(1)[0][0], arcs(1.5)[0][0], 'the clock moves them')
})

test('animated: a line, an arrowhead and at most one chip per card, no text (#384)', () => {
  const segs = searchFlowSegments([disc(0), disc(1), disc(2)], calls(call()), size)
  const rec = draw(segs, false)
  assert.equal(rec.ops.filter(o => o.name === 'arc').length, 3, 'one chip per segment')
  assert.ok(rec.ops.filter(o => o.name === 'lineTo').length >= 3)
  assert.equal(rec.texts.length, 0, 'the placement layer stays the only authority on labels')
})

test('reduced motion: the same static line and arrowhead, no chip, independent of the clock (#384)', () => {
  const segs = searchFlowSegments([disc(0), disc(1)], calls(call()), size)
  const moving = draw(segs, false)
  const still = draw(segs, true)
  assert.equal(still.ops.filter(o => o.name === 'arc').length, 0)
  const shape = (r: typeof still) => r.ops.filter(o => o.name === 'moveTo' || o.name === 'lineTo').length
  assert.equal(shape(still), shape(moving), 'line and arrowhead are kept')
  assert.ok(shape(still) > 0)
  assert.deepEqual(draw(segs, true, 1).ops.map(o => o.args), draw(segs, true, 9).ops.map(o => o.args))
})

test('nothing to draw: the context is not touched (#384)', () => {
  assert.equal(draw([], false).ops.length, 0)
})
