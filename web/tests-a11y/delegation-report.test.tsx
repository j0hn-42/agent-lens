// Delegation report in the inspector (#233): one entry per sub-agent, values in words, reachable by keyboard, axe-clean.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, within, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { AgentDetailCard } from '@/components/agent-visualizer/agent-detail-card'
import { createFreshnessClock } from '@/hooks/use-freshness-clock'
import type { DelegationRow } from '@/lib/delegation-report'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const NOW = 1_700_000_000_000
const clock = createFreshnessClock({ now: () => NOW, isHidden: () => true })
const noop = () => {}
const parent = { id: 's1:main', name: 'Orchestrator', state: 'thinking' as const, tokensUsed: 1, tokensMax: 10, toolCalls: 0, timeAlive: 1, lastEventAt: NOW, freshnessSource: 'live' as const }

const returned: DelegationRow = {
  agentId: 's1:scout', name: 'scout', subagentType: 'Explore', linkVerified: true,
  tokens: { value: 1_200, status: 'available', estimated: false },
  filesRead: ['/repo/src/a.ts', '/repo/src/b.ts'], filesReadCount: 2, readsNotConfirmed: 1,
  duration: { kind: 'measured', seconds: 42 },
  result: { kind: 'returned', excerpt: 'Found the payment module', truncated: false },
}
const running: DelegationRow = {
  agentId: 's1:fixer', name: 'fixer', linkVerified: false,
  tokens: { value: null, status: 'unavailable', estimated: false },
  filesRead: [], filesReadCount: 0, readsNotConfirmed: 0,
  duration: { kind: 'not-returned' },
  result: { kind: 'not-returned', finished: false },
}

function renderCard(delegation: DelegationRow[], onSelectAgent: (id: string) => void = noop) {
  return render(<AgentDetailCard agent={parent} toolErrors={0} onClose={noop} freshnessClock={clock} delegation={delegation} onSelectAgent={onSelectAgent} />)
}

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)
}

test('the report is a named list with one entry per sub-agent', () => {
  const v = renderCard([returned, running])
  const list = v.getByRole('list', { name: 'Delegation report: 2 sub-agents' })
  assert.equal(within(list).getAllByRole('listitem').filter(li => li.parentElement === list).length, 2)
})

test('each entry states tokens, files read, duration and result in words', () => {
  const v = renderCard([returned, running])
  const [first, second] = within(v.getByRole('list', { name: /^Delegation report/ })).getAllByTestId('delegation-row')
  const a = first.textContent ?? ''
  assert.match(a, /Tokens\s*1\.2k/)
  assert.match(a, /Files read\s*2 files, 1 not confirmed/)
  assert.match(a, /Duration\s*0:42 \(measured\)/)
  assert.match(a, /Result\s*Found the payment module/)
  const b = second.textContent ?? ''
  assert.match(b, /Tokens\s*not reported/)
  assert.match(b, /Files read\s*none observed/)
  assert.match(b, /Duration\s*no return observed/)
  assert.match(b, /Result\s*No return observed yet/)
  assert.match(b, /parent link not verified/)
})

test('each sub-agent is a button with an accessible name that opens its own inspector, by keyboard too', () => {
  const picked: string[] = []
  const v = renderCard([returned, running], id => picked.push(id))
  const button = v.getByRole('button', { name: 'Inspect sub-agent scout' })
  button.focus()
  assert.equal(document.activeElement, button)
  fireEvent.click(button)
  assert.deepEqual(picked, ['s1:scout'])
})

test('the files read are listed in a disclosure (native details/summary, keyboard-operable)', () => {
  const v = renderCard([returned])
  const summary = v.getByText('2 files, 1 not confirmed', { selector: 'summary' })
  const details = summary.closest('details')!
  const items = within(details).getAllByRole('listitem').map(li => li.textContent)
  assert.deepEqual(items, ['/repo/src/a.ts', '/repo/src/b.ts'])
})

test('no sub-agent, no report section', () => {
  const v = renderCard([])
  assert.equal(v.queryByRole('list', { name: /^Delegation report/ }), null)
})

test('the card with a report has no axe violation', async () => {
  const v = renderCard([returned, running])
  assert.deepEqual(await violations(v.container), [])
})
