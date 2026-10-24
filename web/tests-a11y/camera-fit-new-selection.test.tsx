// #377 (relecture de #494) : « Zoom to fit » du menu d'un agent sélectionne cet agent puis cadre. Les deux
// changements arrivent dans le même rendu : le cadrage doit viser la nouvelle sélection, et l'effet qui annule le
// déplacement en cours à chaque changement de sélection ne doit pas effacer ce cadrage demandé dans le même rendu.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, cleanup } from '@testing-library/react'
import type { MutableRefObject } from 'react'

import { useCanvasCamera } from '@/hooks/use-canvas-camera'

afterEach(() => cleanup())

const agent = (id: string, x: number, isMain = false) => ({
  id, name: id, x, y: 0, isMain, parentId: isMain ? null : 'main', opacity: 1, scale: 1, state: 'idle', sessionId: 's1',
  tokensUsed: 0, tokensMax: 0, messageBubbles: [],
})
const agents = new Map([['main', agent('main', 0, true)], ['a', agent('a', -3000)], ['b', agent('b', 3000)]])

function mount(initialSelection: string) {
  const drawPropsRef = {
    current: {
      agents, toolCalls: new Map(), discoveries: [], dimensions: { width: 800, height: 600 },
      selectedAgentId: initialSelection as string, pauseAutoFit: true, isDragging: false,
    },
  }
  const hook = renderHook(
    ({ selectedAgentId, zoomToFitTrigger }: { selectedAgentId: string; zoomToFitTrigger: number }) => useCanvasCamera({
      mainCanvasRef: { current: null },
      drawPropsRef: drawPropsRef as unknown as MutableRefObject<never>,
      simTimeRef: { current: 0 },
      dimensions: drawPropsRef.current.dimensions,
      agentCount: 0,
      zoomToFitTrigger,
      selectedAgentId,
      reducedMotionRef: { current: true },
    }),
    { initialProps: { selectedAgentId: initialSelection, zoomToFitTrigger: 0 } },
  )
  // A first frame records the content, as the draw loop does long before any click (a content change resets the target)
  hook.result.current.updateCamera(false, true)
  /** One render with a new selection and a zoom request, as a click on the menu item batches them */
  const selectAndZoom = (id: string, trigger: number) => {
    // The draw props are rebuilt during the render (use-canvas-draw-props), before the camera's effects run
    drawPropsRef.current = { ...drawPropsRef.current, selectedAgentId: id }
    hook.rerender({ selectedAgentId: id, zoomToFitTrigger: trigger })
    hook.result.current.updateCamera(false, true)
    return { ...hook.result.current.transformRef.current }
  }
  return { selectAndZoom }
}

test('zoom requested in the same render as a new selection frames the newly selected agent', () => {
  // Reference: b was already selected, then a zoom
  const expected = mount('b').selectAndZoom('b', 1)
  assert.notDeepEqual(expected, { x: 0, y: 0, scale: 1 }, 'the reference zoom moved the camera')
  // a selected; the menu of b selects b and zooms in the same render
  const got = mount('a').selectAndZoom('b', 1)
  assert.deepEqual(got, expected, "the camera frames b's subtree, not a's, and the zoom is not cancelled")
})
