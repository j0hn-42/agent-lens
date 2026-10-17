// One block per workspace in the fleet layout when several projects are on screen.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeClusterAnchors, type ClusterInput } from '../web/hooks/simulation/fleet-layout'

const rectOf = (ids: string[], anchors: ReturnType<typeof computeClusterAnchors>) => {
  const as = ids.map(k => anchors.get(k)!)
  return {
    x0: Math.min(...as.map(a => a.x - a.radius)), x1: Math.max(...as.map(a => a.x + a.radius)),
    y0: Math.min(...as.map(a => a.y - a.radius)), y1: Math.max(...as.map(a => a.y + a.radius)),
  }
}

test('anchors: with several projects, the bounding boxes of two projects never intersect', () => {
  for (const n of [2, 3, 5, 9]) {
    const clusters: ClusterInput[] = []
    for (let p = 0; p < n; p++) {
      for (let i = 0; i < 1 + (p % 3); i++) clusters.push({ key: `p${p}c${i}`, size: 1 + i + (p % 2) * 4, projectId: `P${p}`, projectName: `proj${p}` })
    }
    const anchors = computeClusterAnchors(clusters)
    const boxes = Array.from({ length: n }, (_, p) => rectOf(clusters.filter(c => c.projectId === `P${p}`).map(c => c.key), anchors))
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = boxes[i], b = boxes[j]
      const apart = a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0
      assert.ok(apart, `projects ${i} and ${j} intersect with ${n} projects`)
    }
  }
})

test('anchors: a cluster without project stays outside the box of every project', () => {
  const clusters: ClusterInput[] = [
    { key: 'a1', size: 2, projectId: 'A', projectName: 'alpha' },
    { key: 'a2', size: 2, projectId: 'A', projectName: 'alpha' },
    { key: 'b1', size: 2, projectId: 'B', projectName: 'beta' },
    { key: 'loose', size: 3 },
  ]
  const anchors = computeClusterAnchors(clusters)
  const loose = anchors.get('loose')!
  for (const ids of [['a1', 'a2'], ['b1']]) {
    const r = rectOf(ids, anchors)
    const inside = loose.x + loose.radius > r.x0 && loose.x - loose.radius < r.x1 && loose.y + loose.radius > r.y0 && loose.y - loose.radius < r.y1
    assert.ok(!inside, `loose cluster enters the box of ${ids.join(',')}`)
  }
})

test('anchors: the zone padding around each project box is kept free of other clusters', () => {
  const clusters: ClusterInput[] = [
    { key: 'a1', size: 1, projectId: 'A', projectName: 'alpha' },
    { key: 'b1', size: 1, projectId: 'B', projectName: 'beta' },
  ]
  const anchors = computeClusterAnchors(clusters)
  const a = anchors.get('a1')!, b = anchors.get('b1')!
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius + 2 * 60, 'two zones would touch')
})
