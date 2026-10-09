// Keeps the legend and its list of entries in sync: the guided tour must cover every entry (issue guided demo).
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React, { type ComponentProps } from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { GraphLegend } from '@/components/agent-visualizer/graph-legend'
import { LEGEND_ENTRY_IDS, LEGEND_ENTRIES } from '@/lib/legend-entries'
import { TourBridgeContext } from '@/components/agent-visualizer/guided-tour-context'

// The open/closed state of the legend is persisted: reset it so each test starts closed.
afterEach(() => { cleanup(); document.body.replaceChildren(); window.localStorage.clear() })

const team = { key: 't', name: 'squad', color: '#ffffff', teamKind: 'team', memberNames: ['a'] }
const teams = [team] as unknown as ComponentProps<typeof GraphLegend>['teams']

test('the legend renders exactly the entries of LEGEND_ENTRY_IDS (one team row included)', () => {
  const view = render(<GraphLegend teams={teams} />)
  fireEvent.click(view.getByRole('button', { name: /legend/i }))
  const rendered = [...document.querySelectorAll('[data-legend-entry]')].map(el => el.getAttribute('data-legend-entry'))
  assert.deepEqual([...new Set(rendered)].sort(), [...LEGEND_ENTRY_IDS].sort())
  assert.equal(new Set(LEGEND_ENTRY_IDS).size, LEGEND_ENTRY_IDS.length, 'no duplicate id')
})

test('every section heading is a tour target', () => {
  const view = render(<GraphLegend teams={teams} />)
  fireEvent.click(view.getByRole('button', { name: /legend/i }))
  for (const section of Object.keys(LEGEND_ENTRIES)) {
    assert.ok(document.querySelector(`[data-tour-target="legend-${section}"]`), `heading of ${section}`)
  }
})

test('while the tour holds the legend open, the Legend button neither collapses it nor saves a preference', () => {
  const tour = { legendOpen: true, canvasToScreenRef: { current: null } }
  const view = render(<TourBridgeContext.Provider value={tour}><GraphLegend teams={teams} /></TourBridgeContext.Provider>)
  const button = view.getByRole('button', { name: /legend/i })
  assert.equal(button.getAttribute('aria-expanded'), 'true')
  fireEvent.click(button)
  assert.equal(window.localStorage.getItem('agent-viz-legend-open'), null, 'no preference saved')
  assert.equal(button.getAttribute('aria-expanded'), 'true')
})
