// File cards made from a Glob / Grep output (#438) are described as what they are: a path the call listed,
// with how many files it reported and how many cards are drawn; never as something an agent "pinned".
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { createElement } from 'react'
import { render, renderHook, act, cleanup, fireEvent } from '@testing-library/react'
import { GraphA11yList } from '@/components/agent-visualizer/graph-a11y-list'
import { GraphLegend } from '@/components/agent-visualizer/graph-legend'
import { DiscoveryDetailPopup } from '@/components/agent-visualizer/discovery-detail-popup'
import { buildA11yModel } from '@/components/agent-visualizer/canvas/a11y-model'
import { describeTooltip } from '@/components/agent-visualizer/canvas/tooltip'
import { createEmptyState } from '@/hooks/simulation/types'
import { useSelectionState } from '@/hooks/use-selection-state'
import { LIVE_ENTRY_TEXT } from '@/lib/live-tour'
import type { Agent, Discovery } from '@/lib/agent-types'

afterEach(cleanup)

const listed: Discovery = {
  id: 'disc-s1:a-tu1-0', agentId: 's1:a', type: 'file', label: 'a.ts', content: 'src/a.ts',
  x: 0, y: 0, targetX: 0, targetY: 0, opacity: 0.9, timestamp: 1, toolUseId: 'tu1',
  listing: { tool: 'Grep', position: 1, reported: 47, shown: 3 },
}
const ORIGIN = 'File listed by Grep, 1 of 47 files the call reported; 3 shown, 44 not drawn'

const agent = { id: 's1:a', name: 'alpha' } as unknown as Agent

test('the graph list names a listed file card by the call it comes from', () => {
  const model = buildA11yModel(new Map([['s1:a', agent]]), new Map(), [listed], new Map())
  assert.equal(model.discoveries[0].origin, ORIGIN)
  const { getByRole } = render(createElement(GraphA11yList, {
    model, communications: [], announcements: [], focusedNode: null, onAgentClick: () => {}, onFocusNode: () => {},
  } as never))
  // The file name first: it is what tells the cards of one call apart
  assert.ok(getByRole('button', { name: `a.ts: ${ORIGIN}, call by alpha` }))
})

test('two complete Grep calls of one agent: each file card says which pattern listed it (#458)', () => {
  const call = (id: string, toolUseId: string, args: string, state = 'complete') =>
    [id, { id, agentId: 's1:a', toolName: 'Grep', state, args, toolUseId }] as const
  const toolCalls = new Map([call('t1', 'tu1', 'foo'), call('t2', 'tu2', 'bar'), call('t3', 'tu3', 'baz', 'running')]) as never
  const d = (id: string, toolUseId: string): Discovery => ({ ...listed, id, toolUseId, listing: { tool: 'Grep', position: 1, reported: 2, shown: 2 } })
  const other = { ...d('d4', 'tu1'), agentId: 's1:b' }
  const model = buildA11yModel(new Map([['s1:a', agent], ['s1:b', { id: 's1:b', name: 'beta' } as unknown as Agent]]), toolCalls,
    [d('d1', 'tu1'), d('d2', 'tu2'), d('d3', 'tu3'), other], new Map())
  const origins = model.discoveries.map(x => x.origin)
  assert.equal(origins[0], 'File listed by Grep "foo", 1 of 2 files the call reported')
  assert.equal(origins[1], 'File listed by Grep "bar", 1 of 2 files the call reported')
  assert.equal(origins[2], 'File listed by Grep, 1 of 2 files the call reported', 'call not complete: nothing invented')
  assert.equal(origins[3], 'File listed by Grep, 1 of 2 files the call reported', 'same id, other agent: no match')
})

test('a discovery from no call keeps its generic name', () => {
  const plain: Discovery = { ...listed, id: 'd2', toolUseId: undefined, listing: undefined }
  const model = buildA11yModel(new Map([['s1:a', agent]]), new Map(), [plain], new Map())
  assert.equal(model.discoveries[0].origin, undefined)
  const { getByRole } = render(createElement(GraphA11yList, {
    model, communications: [], announcements: [], focusedNode: null, onAgentClick: () => {}, onFocusNode: () => {},
  } as never))
  assert.ok(getByRole('button', { name: 'file found by alpha: a.ts' }))
})

test('the tooltip and the popup say where the card comes from', () => {
  const sim = { ...createEmptyState(), discoveries: [listed] }
  assert.deepEqual(describeTooltip({ type: 'discovery', id: listed.id }, sim), { title: 'a.ts', lines: [ORIGIN] })
  const { getByText } = render(createElement(DiscoveryDetailPopup, { discovery: listed, agentName: 'alpha', position: { x: 10, y: 10 }, onClose: () => {} }))
  assert.ok(getByText(ORIGIN))
})

test('the legend describes file cards as listed paths, not pinned files', () => {
  assert.match(LIVE_ENTRY_TEXT['disc-file'], /Grep/)
  assert.doesNotMatch(LIVE_ENTRY_TEXT['disc-file'], /pinned/)
  // A Glob whose structured result proves its listing makes cards too (#451): both texts name it
  assert.match(LIVE_ENTRY_TEXT['disc-file'], /Glob/)
  const { container, getByRole } = render(createElement(GraphLegend, {}))
  fireEvent.click(getByRole('button', { name: /Legend/ }))
  // The row of the file card only: the repeat badge row (#377) names the Glob rule of the waste ledger
  const text = container.querySelector('[data-legend-entry="disc-file"]')?.textContent ?? ''
  assert.ok(text.includes('File: a path a Grep or Glob call listed'), 'the legend row')
})

test('clicking a listed file card opens a popup that still says where it comes from', () => {
  // The path the canvas takes: the selection snapshot, not the live discovery, feeds the popup
  const { result } = renderHook(() => useSelectionState({ agents: new Map([['s1:a', agent]]), toolCalls: new Map(), discoveries: [listed] }))
  act(() => { result.current.handleDiscoveryClick(listed.id) })
  const snapshot = result.current.selectedDiscoveryData
  assert.ok(snapshot)
  const { getByText } = render(createElement(DiscoveryDetailPopup, { discovery: snapshot, agentName: 'alpha', position: { x: 10, y: 10 }, onClose: () => {} }))
  assert.ok(getByText(ORIGIN))
})
