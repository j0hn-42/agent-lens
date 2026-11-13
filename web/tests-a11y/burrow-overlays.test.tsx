// Burrow view: its controls sit under the top bar. The BurrowView fills <main>, which starts at the top of the window,
// and the top bar (z-index above the scene) is drawn over its first ~60px: a control there could not be clicked and
// its focus ring would be hidden.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'

import { BurrowView } from '@/components/agent-visualizer/burrow-view'

afterEach(() => { cleanup(); document.body.replaceChildren() })

test('the Room titles button sits below the top bar, on the right (the Conversation pill holds the left)', () => {
  render(
    <BurrowView
      simulationRef={{ current: { agents: new Map(), toolCalls: new Map(), links: new Map(), discoveries: [] } } as never}
      selectedAgentId={null}
      onAgentClick={() => {}}
      onAgentHover={() => {}}
    />,
  )
  const button = screen.getByRole('button', { name: /Room titles|Titres des pièces/ })
  const column = button.parentElement as HTMLElement
  assert.match(column.style.top, /var\(--topbar-h/, 'the column is offset by the measured top bar height')
  assert.equal(column.style.right, '8px', 'right edge of the scene when no panel is docked there')
  const classes = column.className.split(/\s+/)
  assert.ok(!classes.includes('top-2') && !classes.includes('left-2'))
})

// The Conversation panel docked on the right covered the column (and the Library and the Laboratory of the picture):
// the burrow reads the docked panels' edges like the graph's fit does, and keeps its controls left of the dock.
test('an open right dock pushes the Room titles button and the agent list left of it', () => {
  const dock = document.createElement('div')
  dock.setAttribute('data-canvas-inset', 'right')
  document.body.appendChild(dock)
  const original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const box = (x: number, y: number, w: number, h: number) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect
    if (this === dock) return box(1000, 0, 400, 900)
    if (this.getAttribute('role') === 'region') return box(0, 0, 1400, 900)
    return box(0, 0, 0, 0)
  }
  try {
    render(
      <BurrowView
        simulationRef={{ current: { agents: new Map(), toolCalls: new Map(), links: new Map(), discoveries: [] } } as never}
        selectedAgentId={null}
        onAgentClick={() => {}}
        onAgentHover={() => {}}
      />,
    )
    const button = screen.getByRole('button', { name: /Room titles|Titres des pièces/ })
    assert.equal((button.parentElement as HTMLElement).style.right, '408px')
  } finally {
    Element.prototype.getBoundingClientRect = original
  }
})
