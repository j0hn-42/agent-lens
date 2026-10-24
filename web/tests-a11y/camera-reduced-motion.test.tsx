// #380: the camera (pan inertia, lerp toward the auto-fit / zoom target) honours reduced motion.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, cleanup } from '@testing-library/react'
import type { MutableRefObject } from 'react'

import { useCanvasCamera } from '@/hooks/use-canvas-camera'

afterEach(() => cleanup())

function mount(reduced: boolean | undefined) {
  const drawPropsRef = {
    current: {
      agents: new Map(), toolCalls: new Map(), discoveries: [], dimensions: { width: 800, height: 600 },
      selectedAgentId: null, pauseAutoFit: true, isDragging: false,
    },
  }
  const reducedMotionRef = reduced === undefined ? undefined : { current: reduced }
  return renderHook(() => useCanvasCamera({
    mainCanvasRef: { current: null },
    drawPropsRef: drawPropsRef as unknown as MutableRefObject<never>,
    simTimeRef: { current: 0 },
    dimensions: drawPropsRef.current.dimensions,
    agentCount: 0,
    selectedAgentId: null,
    reducedMotionRef,
  })).result
}

test('without reduced motion the camera eases toward its target (control)', () => {
  const cam = mount(false)
  cam.current.zoomToCircle(500, 400, 100)
  cam.current.updateCamera(false, true)
  const t = cam.current.transformRef.current
  assert.ok(t.x !== 0 || t.y !== 0 || t.scale !== 1, 'moved')
  // a single frame does not reach the target: a second frame moves again
  cam.current.updateCamera(false, true)
  assert.notDeepEqual(cam.current.transformRef.current, t)
})

test('under reduced motion a zoom target is reached in one frame', () => {
  const cam = mount(true)
  cam.current.zoomToCircle(500, 400, 100)
  cam.current.updateCamera(false, true)
  const t = cam.current.transformRef.current
  cam.current.updateCamera(false, true)
  assert.deepEqual(cam.current.transformRef.current, t, 'a second frame does not move: already at the target')
  assert.ok(t.scale !== 1)
  assert.equal(cam.current.isCameraBusy(), false)
})

test('under reduced motion a released pan does not coast', () => {
  const cam = mount(true)
  cam.current.panVelocityRef.current = { vx: 40, vy: 25, active: true }
  cam.current.updateCamera(false, true)
  assert.deepEqual(cam.current.transformRef.current, { x: 0, y: 0, scale: 1 })
  assert.equal(cam.current.panVelocityRef.current.active, false)
})

test('without reduced motion a released pan coasts', () => {
  const cam = mount(false)
  cam.current.panVelocityRef.current = { vx: 40, vy: 25, active: true }
  cam.current.updateCamera(false, true)
  assert.equal(cam.current.transformRef.current.x, 40)
})
