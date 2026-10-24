// One block per workspace in the fleet layout when several projects are on screen.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeClusterAnchors, workspaceCentres, type ClusterInput } from '../web/hooks/simulation/fleet-layout'
import { WORKSPACE_ZONE } from '../web/lib/canvas-constants'

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

// ─── Workspaces moved by hand ────────────────────────────────────────────────

type Box = { x0: number; x1: number; y0: number; y1: number }
const boxOf = (project: string, clusters: ClusterInput[], anchors: ReturnType<typeof computeClusterAnchors>): Box => {
  const r = rectOf(clusters.filter(c => c.projectId === project).map(c => c.key), anchors)
  return { x0: r.x0 - WORKSPACE_ZONE.padSide, x1: r.x1 + WORKSPACE_ZONE.padSide, y0: r.y0 - WORKSPACE_ZONE.padTop, y1: r.y1 + WORKSPACE_ZONE.padSide }
}
const centreOf = (b: Box) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 })
const apart = (a: Box, b: Box) => a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6

const THREE: ClusterInput[] = [
  { key: 'a1', size: 3, projectId: 'A', projectName: 'alpha' },
  { key: 'a2', size: 1, projectId: 'A', projectName: 'alpha' },
  { key: 'b1', size: 2, projectId: 'B', projectName: 'beta' },
  { key: 'c1', size: 4, projectId: 'C', projectName: 'gamma' },
]

test('placed workspace: its zone is centred where it was put, its clusters keep their arrangement', () => {
  const free = computeClusterAnchors(THREE)
  const placed = computeClusterAnchors(THREE, new Map([['A', { x: 5000, y: -3000 }]]))
  const c = centreOf(boxOf('A', THREE, placed))
  assert.ok(near(c, { x: 5000, y: -3000 }), `zone A centred at ${c.x},${c.y}`)
  const d = (k: string, m: typeof free) => ({ x: m.get(k)!.x - m.get('a1')!.x, y: m.get(k)!.y - m.get('a1')!.y })
  assert.ok(near(d('a2', free), d('a2', placed)), 'the clusters of A move together')
})

test('placed workspace: workspaces it does not touch keep their slot', () => {
  const free = computeClusterAnchors(THREE)
  const placed = computeClusterAnchors(THREE, new Map([['A', { x: 5000, y: -3000 }]]))
  for (const k of ['b1', 'c1']) assert.ok(near(free.get(k)!, placed.get(k)!), `${k} moved`)
})

test('placed workspace: dropped onto another one, it keeps its place and the other steps aside', () => {
  const free = computeClusterAnchors(THREE)
  const target = centreOf(boxOf('B', THREE, free))
  const placed = computeClusterAnchors(THREE, new Map([['A', target]]))
  assert.ok(near(centreOf(boxOf('A', THREE, placed)), target), 'A is where it was dropped')
  const boxes = ['A', 'B', 'C'].map(p => boxOf(p, THREE, placed))
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(apart(boxes[i], boxes[j]), `zones ${i} and ${j} intersect`)
})

test('placed workspaces: the one moved last keeps its place when two are put on each other', () => {
  const placed = computeClusterAnchors(THREE, new Map([['B', { x: 0, y: 0 }], ['A', { x: 10, y: 10 }]]))
  assert.ok(near(centreOf(boxOf('A', THREE, placed)), { x: 10, y: 10 }), 'A, moved last, stays')
  assert.ok(apart(boxOf('A', THREE, placed), boxOf('B', THREE, placed)), 'B steps aside')
})

test('placed workspace: a cluster without project never ends inside a moved zone', () => {
  const clusters: ClusterInput[] = [...THREE, { key: 'loose', size: 2 }]
  const loose = computeClusterAnchors(clusters).get('loose')!
  const placed = computeClusterAnchors(clusters, new Map([['A', { x: loose.x, y: loose.y }]]))
  const l = placed.get('loose')!
  assert.ok(apart(boxOf('A', clusters, placed), { x0: l.x - l.radius, x1: l.x + l.radius, y0: l.y - l.radius, y1: l.y + l.radius }))
})

test('placed workspace: ignored with a single project (no zone is drawn) and for an unknown project', () => {
  const one: ClusterInput[] = [{ key: 'a1', size: 2, projectId: 'A', projectName: 'alpha' }, { key: 'a2', size: 1, projectId: 'A', projectName: 'alpha' }]
  assert.deepEqual(computeClusterAnchors(one, new Map([['A', { x: 900, y: 900 }]])), computeClusterAnchors(one))
  assert.deepEqual(computeClusterAnchors(THREE, new Map([['Z', { x: 900, y: 900 }]])), computeClusterAnchors(THREE))
})

test('placed workspace: deterministic', () => {
  const placed = new Map([['C', { x: 40, y: -20 }], ['A', { x: 0, y: 0 }]])
  assert.deepEqual(computeClusterAnchors(THREE, placed), computeClusterAnchors(THREE, placed))
})

test('workspaceCentres: the centre of each zone, as placed or as laid out', () => {
  const placed = new Map([['A', { x: 5000, y: -3000 }]])
  const anchors = computeClusterAnchors(THREE, placed)
  const centres = workspaceCentres(THREE, placed)
  assert.deepEqual([...centres.keys()].sort(), ['A', 'B', 'C'])
  for (const p of ['A', 'B', 'C']) assert.ok(near(centres.get(p)!, centreOf(boxOf(p, THREE, anchors))), `centre of ${p}`)
  assert.equal(workspaceCentres(THREE.slice(0, 2)).size, 0, 'a single project has no zone')
})
