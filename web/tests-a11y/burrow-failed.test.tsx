// Burrow view: when its pictures fail to load, the message has a way out, a button back to the node graph.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'

import { BurrowView } from '@/components/agent-visualizer/burrow-view'
import { useUiPreferences } from '@/hooks/use-ui-preferences'

const RealImage = globalThis.Image
afterEach(() => { cleanup(); document.body.replaceChildren(); globalThis.Image = RealImage })

class FailingImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(_v: string) { setTimeout(() => this.onerror?.(), 0) }
}

function Probe() {
  const { prefs, setPref } = useUiPreferences()
  return (
    <main id="visualizer-main" tabIndex={-1}>
      <output data-testid="scene">{prefs.sceneStyle}</output>
      <button type="button" onClick={() => setPref('sceneStyle', 'burrow')}>to-burrow</button>
      <BurrowView
        simulationRef={{ current: { agents: new Map(), toolCalls: new Map(), links: new Map(), discoveries: [] } } as never}
        selectedAgentId={null}
        onAgentClick={() => {}}
        onAgentHover={() => {}}
        focusTargetId="visualizer-main"
      />
    </main>
  )
}

test('when the burrow pictures fail, a "Back to the graph" button switches the scene style to graph', async () => {
  globalThis.Image = FailingImage as never
  render(<Probe />)
  fireEvent.click(screen.getByText('to-burrow'))
  await act(() => new Promise<void>((ok) => setTimeout(ok, 150)))
  assert.equal(screen.getByTestId('scene').textContent, 'burrow')
  assert.ok(screen.getByText(/could not start|n’a pas pu démarrer/))
  const back = screen.getByRole('button', { name: /Back to the graph|Revenir au graphe/ })
  back.focus()
  fireEvent.click(back)
  assert.equal(screen.getByTestId('scene').textContent, 'graph')
  // the button goes away with the burrow: focus lands on the scene region, not on <body>
  assert.equal(document.activeElement?.id, 'visualizer-main')
})
