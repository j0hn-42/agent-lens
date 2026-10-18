// #378 (suite): while the scene grows, the automatic framing catches up with what it frames instead of
// trailing it. On develop @ 03da64a the camera closed 6 % of the gap to its fit target per frame whatever
// the target: something that appeared outside the frame stayed (partly) outside for a while (bench of
// autoframe-grow.e2e.ts on the tour demo: longest run 657 ms and worst item 241 px off at 1024 x 768, 468 ms and
// 121 px at 390 x 844). The "Fit to view" button sets the same kind of target and takes the same catch-up.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, cleanup } from '@testing-library/react'
import type { MutableRefObject } from 'react'

import { useCanvasCamera } from '@/hooks/use-canvas-camera'
import { computeFitBounds, fitInsets, safeRect, type Transform } from '@/components/agent-visualizer/canvas/camera-fit'
import { ANIM } from '@/lib/agent-types'

afterEach(() => cleanup())

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(id: string, x: number, y: number): any {
  return {
    id, agentKey: id, sessionId: 's1', name: id, state: 'idle', parentId: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    x, y, vx: 0, vy: 0, isMain: id === 'main', spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
  }
}

const DIM = { width: 1024, height: 768 }
const INSETS = { top: 60, right: 0, bottom: 110, left: 0 }

function mount(reduced = false) {
  const agents = new Map<string, any>([['main', agent('main', 0, 0)]])
  const drawPropsRef = {
    current: { agents, toolCalls: new Map(), discoveries: [], dimensions: DIM, selectedAgentId: null, pauseAutoFit: false, isDragging: false },
  }
  const { result } = renderHook(() => useCanvasCamera({
    mainCanvasRef: { current: null },
    drawPropsRef: drawPropsRef as unknown as MutableRefObject<never>,
    simTimeRef: { current: 0 },
    dimensions: DIM,
    agentCount: agents.size,
    selectedAgentId: null,
    clustersRef: { current: [] },
    getInsets: () => INSETS,
    reducedMotionRef: { current: reduced },
  }))
  const frames = (n: number) => { for (let i = 0; i < n; i++) result.current.updateCamera(false, false) }
  return { cam: result, agents, frames }
}

/** How far (screen px) the framed content of `agents` sticks out of the safe area at transform `t` */
function outside(agents: Map<string, any>, t: Transform): number {
  const b = computeFitBounds({ agents: agents.values(), simTime: 0 })
  const safe = safeRect(DIM, fitInsets(INSETS, false))
  const l = b.minX * t.scale + t.x, r = b.maxX * t.scale + t.x, top = b.minY * t.scale + t.y, bot = b.maxY * t.scale + t.y
  return Math.max(0, safe.x - l, r - (safe.x + safe.w), safe.y - top, bot - (safe.y + safe.h))
}

test('a new agent outside the frame is inside the safe area within 250 ms (15 frames) of its spawn (#378)', () => {
  const { cam, agents, frames } = mount()
  frames(600)
  assert.equal(outside(agents, cam.current.transformRef.current), 0, 'precondition: the first agent is framed')
  agents.set('far', agent('far', 1600, 300))
  frames(1)
  assert.ok(outside(agents, cam.current.transformRef.current) > 50, 'precondition: the new agent spawns outside the frame')
  frames(14)
  const out = outside(agents, cam.current.transformRef.current)
  assert.equal(Math.round(out * 10) / 10, 0, `still ${out.toFixed(1)} px outside the safe area 15 frames after the spawn`)
})

test('once everything is inside, the camera eases as before (a shrinking scene is not rushed) (#378)', () => {
  const { cam, agents, frames } = mount()
  agents.set('far', agent('far', 1600, 300))
  frames(600)
  const wide = cam.current.transformRef.current
  agents.delete('far')
  frames(1)
  const after = cam.current.transformRef.current
  // The fit target zooms in on the remaining agent: the first step closes at most the usual share of the gap
  frames(600)
  const target = cam.current.transformRef.current
  const share = (after.scale - wide.scale) / (target.scale - wide.scale)
  assert.ok(share > 0 && share <= ANIM.autoFitLerp + 1e-9, `first step closed ${(share * 100).toFixed(1)} % of the zoom gap (ease is ${ANIM.autoFitLerp * 100} %)`)
})

test('under reduced motion the fit target is still reached in one frame (#380)', () => {
  const { cam, agents, frames } = mount(true)
  frames(2)
  agents.set('far', agent('far', 1600, 300))
  frames(2)
  assert.equal(outside(agents, cam.current.transformRef.current), 0)
})

test('"Fit to view" from a zoom-in takes the same catch-up: the content off screen comes back within 15 frames (#378)', () => {
  const { cam, agents, frames } = mount()
  agents.set('far', agent('far', 1600, 300))
  frames(600)
  const fitted = cam.current.transformRef.current
  cam.current.zoomBy(4)
  assert.ok(outside(agents, cam.current.transformRef.current) > 50, 'precondition: zoomed in, part of the content is off the safe area')
  cam.current.doZoomToFit()
  const zoomed = cam.current.transformRef.current
  frames(1)
  const share = (zoomed.scale - cam.current.transformRef.current.scale) / (zoomed.scale - fitted.scale)
  assert.ok(share > ANIM.autoFitLerp + 1e-6, `first step closed ${(share * 100).toFixed(1)} % of the zoom gap (catch-up is ${ANIM.autoFitCatchUpLerp * 100} %)`)
  frames(14)
  const out = outside(agents, cam.current.transformRef.current)
  assert.equal(Math.round(out * 10) / 10, 0, `still ${out.toFixed(1)} px outside the safe area 15 frames after "Fit to view"`)
})
