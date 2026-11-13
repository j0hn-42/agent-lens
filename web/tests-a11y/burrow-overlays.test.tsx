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
  const classes = column.className.split(/\s+/)
  assert.ok(classes.includes('right-2'), 'right edge of the scene')
  assert.ok(!classes.includes('top-2') && !classes.includes('left-2'))
})
