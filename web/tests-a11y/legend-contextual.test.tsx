// The graph legend lists only the symbols that are on screen (#244). What is shown is proven by the scene
// (web/lib/legend-presence.ts); "Show all symbols" gives the complete reference back on demand.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React, { type ComponentProps } from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'
import { GraphLegend } from '@/components/agent-visualizer/graph-legend'
import { LEGEND_ENTRY_IDS, LEGEND_ENTRIES, type LegendEntryId } from '@/lib/legend-entries'
import { TourBridgeContext } from '@/components/agent-visualizer/guided-tour-context'
import { CTX_TOKENS_LABELS } from '@/lib/ui-glossary'
import { MESSAGES } from '@/lib/messages'

afterEach(() => { cleanup(); document.body.replaceChildren(); window.localStorage.clear() })

const team = { key: 't', name: 'squad', color: '#ffffff', teamKind: 'team', memberNames: ['a'] }
const teams = [team] as unknown as ComponentProps<typeof GraphLegend>['teams']
const openLegend = (view: ReturnType<typeof render>) => fireEvent.click(view.getByRole('button', { name: 'Legend' }))
const rows = () => [...document.querySelectorAll('[data-legend-entry]')].map(el => el.getAttribute('data-legend-entry'))
const headings = () => [...document.querySelectorAll('[data-tour-target^="legend-"]')].map(el => el.getAttribute('data-tour-target'))

test('with a presence, the legend lists exactly those symbols', () => {
  const present: LegendEntryId[] = ['shape-main', 'state-thinking', 'rt-claude']
  const view = render(<GraphLegend teams={[]} present={present} />)
  openLegend(view)
  assert.deepEqual(rows().sort(), [...present].sort())
})

test('a section without a symbol on screen has no heading either', () => {
  const view = render(<GraphLegend teams={[]} present={['shape-main', 'state-thinking']} />)
  openLegend(view)
  assert.deepEqual(headings().sort(), ['legend-shapes', 'legend-states'])
  assert.equal(view.queryByRole('heading', { name: 'Discoveries' }), null)
})

test('the legend says how many symbols it lists and offers the complete list as a toggle button', () => {
  const view = render(<GraphLegend teams={teams} present={['shape-main', 'state-thinking']} />)
  openLegend(view)
  assert.ok(view.getByText(/2 symbols on screen/))
  const toggle = view.getByRole('button', { name: 'Show all symbols' })
  assert.equal(toggle.getAttribute('aria-pressed'), 'false')
  fireEvent.click(toggle)
  assert.equal(toggle.getAttribute('aria-pressed'), 'true')
  assert.deepEqual([...new Set(rows())].sort(), [...LEGEND_ENTRY_IDS].sort(), 'the complete reference')
  assert.ok(view.getByText(/Complete reference/))
  fireEvent.click(toggle)
  assert.equal(rows().length, 2)
})

test('"Show all symbols" is a native button reachable with the keyboard', () => {
  const view = render(<GraphLegend teams={[]} present={['shape-main']} />)
  openLegend(view)
  const toggle = view.getByRole('button', { name: 'Show all symbols' })
  assert.equal(toggle.tagName, 'BUTTON')
  assert.equal(toggle.getAttribute('type'), 'button')
  assert.notEqual(toggle.getAttribute('tabindex'), '-1')
  toggle.focus()
  assert.equal(document.activeElement, toggle)
})

test('nothing on screen: the legend says so instead of listing symbols', () => {
  const view = render(<GraphLegend teams={[]} present={[]} />)
  openLegend(view)
  assert.deepEqual(rows(), [])
  assert.ok(view.getByText(/Nothing to explain yet/))
  assert.ok(view.getByRole('button', { name: 'Show all symbols' }), 'the reference stays one click away')
})

test('without a presence (not computed), the legend stays complete', () => {
  const view = render(<GraphLegend teams={teams} />)
  openLegend(view)
  assert.deepEqual([...new Set(rows())].sort(), [...LEGEND_ENTRY_IDS].sort())
  assert.equal(view.queryByRole('button', { name: 'Show all symbols' }), null, 'nothing to toggle')
})

test('team rows follow the teams on screen, not the presence list alone', () => {
  const view = render(<GraphLegend teams={teams} present={['team-row', 'team-halo']} />)
  openLegend(view)
  assert.deepEqual(rows().sort(), ['team-halo', 'team-row'])
  assert.ok(view.getByText('squad'))
  cleanup()
  const none = render(<GraphLegend teams={teams} present={['shape-main']} />)
  openLegend(none)
  assert.equal(none.queryByText('squad'), null, 'a team that is not proven on screen has no row')
})

test('the guided demo keeps the complete legend its steps talk about', () => {
  const tour = { legendOpen: true, legendShowAll: true, canvasToScreenRef: { current: null } }
  render(<TourBridgeContext.Provider value={tour}><GraphLegend teams={teams} present={['shape-main']} /></TourBridgeContext.Provider>)
  assert.deepEqual([...new Set(rows())].sort(), [...LEGEND_ENTRY_IDS].sort())
})

test('every section heading of the complete legend stays a tour target', () => {
  const view = render(<GraphLegend teams={teams} present={[]} />)
  openLegend(view)
  fireEvent.click(view.getByRole('button', { name: 'Show all symbols' }))
  assert.deepEqual(headings().sort(), Object.keys(LEGEND_ENTRIES).map(s => `legend-${s}`).sort())
})

test('the tour button of a live session is named "Tour this session"', () => {
  const tour = { legendOpen: false, canvasToScreenRef: { current: null }, startTour: () => {}, startTourLabel: 'Tour this session' }
  const view = render(<TourBridgeContext.Provider value={tour}><GraphLegend teams={[]} present={['shape-main']} /></TourBridgeContext.Provider>)
  assert.ok(view.getByRole('button', { name: 'Tour this session' }))
  assert.equal(view.queryByRole('button', { name: 'Guided tour' }), null)
})

test('the contextual legend has no axe violation (open, filtered and complete)', async () => {
  const view = render(<GraphLegend teams={teams} present={['shape-main', 'state-error', 'team-row']} />)
  openLegend(view)
  const run = async (name: string) => {
    const results = await axe.run(view.container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    })
    const found = results.violations.map(v => v.id)
    assert.deepEqual(found, [], `${name}: ${found.join(', ')}`)
  }
  await run('filtered')
  fireEvent.click(view.getByRole('button', { name: 'Show all symbols' }))
  await run('complete')
})

test('the legend defines "ctx tokens", the unit of the Cost panel total (#545 review), filtered or not', () => {
  const view = render(<GraphLegend teams={[]} present={['shape-main']} />)
  openLegend(view)
  assert.equal(MESSAGES.en['legend.ctxTokens'], CTX_TOKENS_LABELS.help)
  const def = view.getByText(CTX_TOKENS_LABELS.help)
  assert.match(def.textContent ?? '', /^ctx tokens/)
  assert.match(def.textContent ?? '', /context/)
  assert.match(def.textContent ?? '', /compaction/)
  assert.match(def.textContent ?? '', /not a consumption/)
})
