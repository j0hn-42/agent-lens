// Loop and repeat badges of the nodes (#377): the screen-reader outline says what the badge shows, with the same
// word as the Sessions panel, and the legend lists the badge only when one is drawn. No badge, no words.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { createElement } from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'
import { GraphA11yList } from '@/components/agent-visualizer/graph-a11y-list'
import { GraphLegend } from '@/components/agent-visualizer/graph-legend'
import { buildA11yModel } from '@/components/agent-visualizer/canvas/a11y-model'
import { repeatMarks } from '@/lib/repeat-marks'
import { emptyWasteLedger, recordToolStart } from '@/lib/waste'
import type { HealthVerdict } from '@/lib/loop-detection'
import type { Agent } from '@/lib/agent-types'

afterEach(() => { cleanup(); document.body.replaceChildren(); window.localStorage.clear() })

const agent = (id: string, name: string) => ({ id, name, state: 'idle', isMain: false, parentId: null, contextBreakdown: {} }) as unknown as Agent
const loop: HealthVerdict = { status: 'loop', findings: [{ kind: 'repeat', toolName: 'Read', count: 3, atLeast: false, toolUseIds: [] }], calls: 3, comparable: 3, dropped: 0, lostEvents: 0 }

function modelWithMarks() {
  let waste = emptyWasteLedger()
  for (let i = 0; i < 2; i++) waste = recordToolStart(waste, { sessionId: 's1', agentId: 's1:b', toolName: 'Glob', inputData: { pattern: '**/*.ts' }, toolUseId: `u${i}`, toolCallId: `t${i}`, time: i })
  const agents = new Map([['s1:a', agent('s1:a', 'alpha')], ['s1:b', agent('s1:b', 'beta')], ['s1:c', agent('s1:c', 'gamma')]])
  const marks = repeatMarks(new Map([['s1:a', loop]]), waste, agents.keys())
  return buildA11yModel(agents, new Map(), [], new Map(), { repeatMarks: marks })
}

test('the outline names the badge after the state and gives its evidence; an agent without badge says nothing', () => {
  const view = render(createElement(GraphA11yList, {
    model: modelWithMarks(), communications: [], announcements: [], focusedNode: null, onAgentClick: () => {}, onFocusNode: () => {},
  } as never))
  assert.ok(view.getByRole('button', { name: /^alpha, .*, loop observed$/ }))
  assert.ok(view.getByText('Loop observed: Read called 3× in a row with the same input.'))
  assert.ok(view.getByRole('button', { name: /^beta, .*, repeated calls observed$/ }))
  assert.ok(view.getByText('Repeated calls observed: same Glob run again 1 time, no edit seen in between.'))
  const gamma = view.getByRole('button', { name: /^gamma/ })
  assert.ok(!/loop|repeat/i.test(gamma.textContent ?? ''), 'no "no loop" for an agent without badge')
  assert.ok(!/waste/i.test(document.body.textContent ?? ''))
})

test('the legend lists the badges only when one is drawn, under "Loops and repeats", with no axe violation', async () => {
  const view = render(createElement(GraphLegend, { present: ['shape-sub'] }))
  fireEvent.click(view.getByRole('button', { name: 'Legend' }))
  assert.equal(document.querySelector('[data-legend-entry="mark-loop"]'), null)
  cleanup()
  window.localStorage.clear()
  const shown = render(createElement(GraphLegend, { present: ['shape-sub', 'mark-loop', 'mark-repeated'] }))
  fireEvent.click(shown.getByRole('button', { name: 'Legend' }))
  assert.ok(shown.getByText('Loops and repeats'))
  const loopRow = document.querySelector('[data-legend-entry="mark-loop"]')!
  const repeatRow = document.querySelector('[data-legend-entry="mark-repeated"]')!
  assert.match(loopRow.textContent ?? '', /Circular arrow on a node: loop observed \(the same call 3 times in a row/)
  assert.match(repeatRow.textContent ?? '', /Double chevron on a node: repeated reads or calls observed/)
  assert.ok(!/waste/i.test(`${loopRow.textContent}${repeatRow.textContent}`))
  const results = await axe.run(shown.container)
  assert.deepEqual(results.violations.map(v => v.id), [])
})
