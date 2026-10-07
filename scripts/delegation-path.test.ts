import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  delegationPathEdges, hopProgress, pathDurationMs, createPathAnimation, strokeDelegationPath,
  PATH_MAX_DURATION_MS, PATH_HOP_MS,
} from '../web/components/agent-visualizer/canvas/delegation-path'
import type { Edge } from '../web/lib/agent-types'

const e = (from: string, to: string, type: Edge['type'] = 'parent-child'): Edge => ({ id: `${from}>${to}`, from, to, type, opacity: 1 })

const edges = [e('root', 'a'), e('root', 'b'), e('a', 'a1'), e('a1', 'tool1', 'tool'), e('b', 'b1')]

test('path: root to the selected node, hop by hop in order', () => {
  assert.deepEqual(delegationPathEdges('a1', edges).map(x => x.id), ['root>a', 'a>a1'])
  assert.deepEqual(delegationPathEdges('tool1', edges).map(x => x.id), ['root>a', 'a>a1', 'a1>tool1'])
})

test('path: the root and an unknown node have no path', () => {
  assert.deepEqual(delegationPathEdges('root', edges), [])
  assert.deepEqual(delegationPathEdges('ghost', edges), [])
  assert.deepEqual(delegationPathEdges(null, edges), [])
})

test('path: a cycle or an absurdly deep chain terminates', () => {
  assert.ok(delegationPathEdges('x', [e('x', 'y'), e('y', 'x')]).length <= 2)
  const deep: Edge[] = []
  for (let i = 0; i < 5000; i++) deep.push(e(`n${i}`, `n${i + 1}`))
  assert.ok(delegationPathEdges('n5000', deep).length <= 64)
})

test('duration: short paths take hops x PATH_HOP_MS, deep ones are capped at 500 ms', () => {
  assert.equal(PATH_MAX_DURATION_MS, 500)
  assert.equal(pathDurationMs(0), 0)
  assert.equal(pathDurationMs(2), 2 * PATH_HOP_MS)
  assert.equal(pathDurationMs(40), 500)
})

test('hopProgress: hops run one after the other, the last one ends at the total duration', () => {
  const n = 4, d = pathDurationMs(n)
  assert.equal(hopProgress(0, n, 0, false), 0)
  assert.equal(hopProgress(0, n, d / n / 2, false), 0.5)
  assert.equal(hopProgress(1, n, d / n / 2, false), 0)
  assert.equal(hopProgress(0, n, d / n, false), 1)
  assert.equal(hopProgress(3, n, d, false), 1)
  assert.equal(hopProgress(3, n, d * 10, false), 1)
  assert.equal(hopProgress(0, n, -50, false), 0)
})

test('hopProgress: a deep path still finishes within 500 ms', () => {
  assert.equal(hopProgress(39, 40, 500, false), 1)
  assert.ok(hopProgress(39, 40, 499, false) < 1)
})

test('hopProgress: reduced motion shows the whole path at once, no animation', () => {
  assert.equal(hopProgress(0, 4, 0, true), 1)
  assert.equal(hopProgress(3, 4, 0, true), 1)
})

test('animation: restarts on a new target, keeps its start while the target is unchanged', () => {
  const a = createPathAnimation()
  assert.equal(a.elapsed('n1', 1000), 0)
  assert.equal(a.elapsed('n1', 1200), 200)
  assert.equal(a.elapsed('n2', 1300), 0)
  assert.equal(a.elapsed('n2', 1350), 50)
  assert.equal(a.elapsed(null, 1400), null)
  assert.equal(a.elapsed('n2', 1500), 0, 'selecting again after a deselection replays it')
})

test('stroke: draws a partial curve per hop and nothing for a zero progress', () => {
  const calls: string[] = []
  const names = ['beginPath', 'moveTo', 'lineTo', 'stroke']
  const ctx = new Proxy({}, {
    get: (_t, k) => (typeof k === 'string' && names.includes(k) ? () => { calls.push(k) } : undefined),
    set: () => true,
  }) as unknown as CanvasRenderingContext2D
  strokeDelegationPath(ctx, { x: 0, y: 0 }, { x: 100, y: 0 }, 0)
  assert.equal(calls.length, 0)
  strokeDelegationPath(ctx, { x: 0, y: 0 }, { x: 100, y: 0 }, 0.5)
  assert.ok(calls.includes('stroke') && calls.filter(c => c === 'lineTo').length >= 2)
})
