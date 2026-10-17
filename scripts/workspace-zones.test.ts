// Workspace zones: one rounded zone per project when several projects are on screen, never guessed.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeWorkspaceZones, zoneHeaderText } from '../web/components/agent-visualizer/canvas/workspace-zones'
import type { Cluster } from '../web/components/agent-visualizer/canvas/cluster-model'

const cl = (key: string, cx: number, cy: number, r: number, project?: { id: string; name: string }, kind: Cluster['kind'] = 'session'): Cluster => ({
  key, kind, title: key, color: '#66ccff', cx, cy, r, memberIds: ['a'], sessionIds: ['s'], runtime: 'Claude',
  status: 'idle', statusText: 'idle', cost: null, costText: '', costSpoken: '',
  ...(project ? { projectId: project.id, projectName: project.name } : {}),
})
const A = { id: 'A', name: 'alpha' }
const B = { id: 'B', name: 'beta' }

test('no zone when fewer than two projects are known', () => {
  assert.deepEqual(computeWorkspaceZones([]), [])
  assert.deepEqual(computeWorkspaceZones([cl('s1', 0, 0, 100, A), cl('s2', 500, 0, 100, A)]), [])
  assert.deepEqual(computeWorkspaceZones([cl('s1', 0, 0, 100, A), cl('s2', 500, 0, 100)]), [])
})

test('one zone per project, containing every halo of the project', () => {
  const zones = computeWorkspaceZones([cl('a1', 0, 0, 100, A), cl('a2', 300, 50, 80, A, 'team'), cl('b1', 2000, 0, 100, B), cl('loose', 0, 1500, 90)])
  assert.deepEqual(zones.map(z => z.projectId), ['A', 'B'])
  const a = zones[0]
  assert.deepEqual(a.clusterKeys, ['a1', 'a2'])
  assert.ok(a.x <= -100 && a.x + a.w >= 380 && a.y <= -100 && a.y + a.h >= 130)
  assert.equal(a.name, 'alpha')
})

test('a cluster without proven project belongs to no zone', () => {
  const zones = computeWorkspaceZones([cl('a1', 0, 0, 100, A), cl('b1', 2000, 0, 100, B), cl('loose', 0, 1500, 90)])
  assert.ok(zones.every(z => !z.clusterKeys.includes('loose')))
})

test('zones are sorted by project id so draw order is stable', () => {
  const zones = computeWorkspaceZones([cl('b1', 0, 0, 10, B), cl('a1', 500, 0, 10, A)])
  assert.deepEqual(zones.map(z => z.projectId), ['A', 'B'])
})

test('header text says how many sessions and teams, in words', () => {
  const zones = computeWorkspaceZones([cl('a1', 0, 0, 100, A), cl('a2', 300, 50, 80, A, 'team'), cl('a3', 600, 0, 80, A), cl('b1', 2000, 0, 100, B)])
  assert.equal(zoneHeaderText(zones[0]), 'Workspace alpha · 2 sessions · 1 team')
  assert.equal(zoneHeaderText(zones[1]), 'Workspace beta · 1 session')
})

test('drawWorkspaceZones draws one rounded zone per project, masks the name, and nothing for no zone', async () => {
  const { drawWorkspaceZones } = await import('../web/components/agent-visualizer/canvas/draw-teams')
  const { DEFAULT_DRAW_OPTS } = await import('../web/components/agent-visualizer/canvas/draw-options')
  const zones = computeWorkspaceZones([cl('a1', 0, 0, 100, A), cl('b1', 2000, 0, 100, B)])
  const run = (maskText: boolean, list = zones) => {
    const rects: number[][] = []
    const texts: string[] = []
    const ctx = new Proxy({}, {
      get: (_t, p: string) => p === 'roundRect' ? (...a: number[]) => rects.push(a)
        : p === 'fillText' ? (s: string) => texts.push(s)
        : p === 'measureText' ? (s: string) => ({ width: s.length * 7 })
        : () => {},
      set: () => true,
    }) as unknown as CanvasRenderingContext2D
    drawWorkspaceZones(ctx, list, { ...DEFAULT_DRAW_OPTS, maskText })
    return { rects, texts }
  }
  const plain = run(false)
  assert.equal(plain.rects.length, 4, 'a zone and a header chip per project')
  assert.deepEqual(plain.texts, ['Workspace alpha · 1 session', 'Workspace beta · 1 session'])
  assert.ok(run(true).texts.every(t => !t.includes('alpha') && !t.includes('beta')))
  assert.equal(run(false, []).rects.length, 0)
})
