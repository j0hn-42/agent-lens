// Context compactions (#232): the COMPACTED row of the Conversation panel says what happened in words,
// is reachable with the keyboard like every other row, and stays listed when tool calls are hidden.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { clearPair } from '@/lib/pair-filter-store'
import { compactionText } from '@/lib/compaction'
import type { Agent } from '@/lib/agent-types'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { ConversationHarness, createPanelRegistry } from './conversation-harness'

beforeEach(() => clearPair())
afterEach(() => { cleanup(); document.body.replaceChildren(); clearPair() })

const agent = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, agentKey: id, sessionId: 's', localId: id, displayName: name, name, parentKey: null, state: 'idle', isMain: false, ...extra } as unknown as Agent)

const agents = new Map<string, Agent>([['o', agent('o', 'orchestrator', { isMain: true })]])

const auto = { trigger: 'auto' as const, preTokens: 154321 }
const conversations = new Map<string, ConversationMessage[]>([
  ['o', [
    { id: 'a1', type: 'assistant', timestamp: 1, content: 'plan the work' },
    { id: 'c1', type: 'compaction', timestamp: 2, content: compactionText(auto), compaction: auto },
    { id: 'c2', type: 'compaction', timestamp: 3, content: compactionText({}), compaction: {} },
  ]],
])

function panel(extra: Partial<React.ComponentProps<typeof ConversationHarness>> = {}) {
  const clicked: (string | null)[] = []
  const r = render(
    <ConversationHarness
      registry={createPanelRegistry()} conversations={conversations} agents={agents} selectedAgentId={null}
      onAgentClick={id => { clicked.push(id) }} onOpened={() => {}} onClosed={() => {}}
      initialOpen {...extra}
    />,
  )
  return { ...r, clicked }
}

async function axeViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => v.id)
}

test('a compaction row is a named button: label, trigger and size before in words', () => {
  const r = panel()
  const row = r.getByRole('button', { name: /COMPACTED.*Context compacted \(automatic\)\. Size before: 154,321 tokens, reported by the runtime\. Cost not reported\./ })
  assert.equal(row.tagName, 'BUTTON')
  assert.notEqual(row.getAttribute('tabindex'), '-1', 'reachable with Tab')
  fireEvent.click(row)
  assert.deepEqual(r.clicked, ['o'], 'activating the row selects its agent, like the other rows')
  assert.ok(r.getByRole('button', { name: /COMPACTED.*trigger not reported\)\. Size before not reported\. Cost not reported\./ }))
})

test('compaction rows stay listed when tool calls are hidden, and the search finds them', () => {
  const r = panel()
  fireEvent.click(r.getByRole('button', { name: 'Tool calls' }))
  assert.equal(r.getAllByRole('button', { name: /COMPACTED/ }).length, 2)
  fireEvent.click(r.getByRole('button', { name: 'Search messages' }))
  fireEvent.change(r.getByRole('searchbox', { name: 'Search messages' }), { target: { value: 'size before: 154' } })
  assert.equal(r.getAllByRole('button', { name: /COMPACTED/ }).length, 1)
})

test('the pill names a compaction when it is the latest row', () => {
  const r = panel({ initialOpen: false })
  assert.ok(r.getByRole('button', { name: /^Open Conversation\. Latest compacted message from orchestrator: Context compacted/ }))
})

test('no axe violation with compaction rows', async () => {
  const r = panel()
  assert.deepEqual(await axeViolations(r.container), [])
})
