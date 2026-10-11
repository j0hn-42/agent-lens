// "Why this tool?" and the causal chain in the tool detail popup (#231): every line is backed by an
// observed fact, an unprovable one is said so, and everything is reachable and named for the keyboard.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, within } from '@testing-library/react'
import axe from 'axe-core'

import { ToolDetailPopup } from '@/components/agent-visualizer/tool-detail-popup'
import type { ToolWhy } from '@/components/agent-visualizer/tool-why'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const base = { id: 't1', toolName: 'Bash', args: 'ls', state: 'complete' as const }
const nameOf = (id: string) => id.replace(/^s:/, '')
const show = (why: ToolWhy | undefined, tool: Partial<React.ComponentProps<typeof ToolDetailPopup>['tool']> = {}) =>
  render(<ToolDetailPopup tool={{ ...base, ...tool }} why={why} position={{ x: 10, y: 10 }} onClose={() => {}} />)

test('no why data: no section, the popup is unchanged', () => {
  const { queryByText } = show(undefined)
  assert.equal(queryByText('Why this tool?'), null)
})

test('observed reasoning is shown under a disclosure the keyboard can open', () => {
  const why: ToolWhy = { reasoning: { kind: 'found', thoughts: [{ text: 'I should list the files', redacted: false }], incomplete: false }, chain: null, nameOf }
  const { getByText, getByRole } = show(why)
  const summary = getByText('Why this tool?')
  assert.equal(summary.tagName, 'SUMMARY')
  assert.ok(summary.closest('details'), 'a native disclosure: Enter and Space toggle it')
  assert.match(getByText(/I should list the files/).textContent ?? '', /list the files/)
  assert.match(getByRole('region', { name: 'Reasoning observed just before this call' }).textContent ?? '', /list the files/)
  assert.equal(getByRole('region', { name: 'Reasoning observed just before this call' }).getAttribute('tabindex'), '0')
})

test('redacted reasoning says it was not disclosed and shows no text', () => {
  const why: ToolWhy = { reasoning: { kind: 'found', thoughts: [{ text: '', redacted: true }], incomplete: false }, chain: null, nameOf }
  const { getByText } = show(why)
  getByText('Reasoning not disclosed by the runtime')
})

test('no reasoning observed and unprovable cases have their own wording', () => {
  const cases: Array<[ToolWhy['reasoning'], RegExp]> = [
    [{ kind: 'none' }, /No reasoning observed just before this call/],
    [{ kind: 'unknown', reason: 'no-tool-use-id' }, /Not provable: this call has no tool_use_id/],
    [{ kind: 'unknown', reason: 'call-not-in-history' }, /Not provable: the call is no longer in the kept history/],
    [{ kind: 'unknown', reason: 'history-truncated' }, /Not provable: older messages were dropped/],
    [{ kind: 'found', thoughts: [{ text: 'x', redacted: false }], incomplete: true }, /Older messages were dropped: earlier reasoning may be missing/],
  ]
  for (const [reasoning, re] of cases) {
    const { container, unmount } = show({ reasoning, chain: null, nameOf })
    assert.match(container.textContent ?? '', re)
    unmount()
  }
})

test('a failure shows its chain as an ordered list, failure first, with the stop reason when unproven', () => {
  const why: ToolWhy = {
    reasoning: { kind: 'none' },
    nameOf,
    chain: [
      { kind: 'failure', text: 'ENOENT: no such file' },
      { kind: 'reasoning', agentId: 's:worker', result: { kind: 'found', thoughts: [{ text: 'file may be missing', redacted: false }], incomplete: false } },
      { kind: 'dispatch', parentId: 's:main', childId: 's:worker', prompt: 'Rewrite parser.ts', reasoning: { kind: 'none' } },
      { kind: 'prompt', agentId: 's:main', text: 'refactor the parser' },
    ],
  }
  const { getByRole } = show(why, { state: 'error' })
  const list = getByRole('list', { name: 'Causal chain of this failure' })
  const items = within(list).getAllByRole('listitem')
  assert.equal(items.length, 4)
  assert.match(items[0].textContent ?? '', /Failure/)
  assert.match(items[0].textContent ?? '', /ENOENT/)
  assert.match(items[2].textContent ?? '', /main/)
  assert.match(items[2].textContent ?? '', /worker/)
  assert.match(items[2].textContent ?? '', /Rewrite parser\.ts/)
  assert.match(items[3].textContent ?? '', /Latest prompt observed before it/)
  assert.match(items[3].textContent ?? '', /refactor the parser/)
})

test('a broken chain says where and why it stops; an unknown prompt is not invented', () => {
  const { getByRole, unmount } = show({
    reasoning: { kind: 'none' }, nameOf,
    chain: [{ kind: 'failure', text: 'boom' }, { kind: 'break', reason: 'link-unverified', agentId: 's:worker' }],
  }, { state: 'error' })
  assert.match(getByRole('list', { name: 'Causal chain of this failure' }).textContent ?? '', /Chain stops: the link to its parent is unverified/)
  unmount()
  const r = show({
    reasoning: { kind: 'none' }, nameOf,
    chain: [{ kind: 'failure', text: 'boom' }, { kind: 'prompt-unknown', agentId: 's:main', reason: 'none-observed' }],
  }, { state: 'error' })
  assert.match(r.getByRole('list', { name: 'Causal chain of this failure' }).textContent ?? '', /No prompt observed before it/)
})

test('a failure without error text says so instead of showing nothing', () => {
  const { getByRole } = show({ reasoning: { kind: 'none' }, nameOf, chain: [{ kind: 'failure', text: '' }] }, { state: 'error' })
  assert.match(getByRole('list', { name: 'Causal chain of this failure' }).textContent ?? '', /Error text not reported/)
})

test('the section has no axe violation', async () => {
  const { container } = show({
    reasoning: { kind: 'found', thoughts: [{ text: 'think', redacted: false }], incomplete: false }, nameOf,
    chain: [{ kind: 'failure', text: 'boom' }, { kind: 'prompt', agentId: 's:main', text: 'go' }],
  }, { state: 'error' })
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  assert.deepEqual(results.violations.map(v => v.id), [])
})
