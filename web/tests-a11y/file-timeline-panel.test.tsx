// File timeline in the Files panel (#385): each file's observed steps, in order, in words, reachable by keyboard, axe-clean.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, within } from '@testing-library/react'
import axe from 'axe-core'

import { FileAttentionPanel } from '@/components/agent-visualizer/file-attention-panel'
import type { FileAttention } from '@/lib/agent-types'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}
const agentLabel = (key: string) => (key === 's1:main' ? 'alpha (session Main)' : key)
const withSteps: FileAttention = {
  path: '/repo/src/a.ts', reads: 1, edits: 2, totalTokens: 100, lastAccessed: 3, agents: ['s1:main'],
  timeline: {
    steps: [
      { kind: 'read', callId: 'c1', toolUseId: 'toolu_read1', agentId: 's1:main', time: 1 },
      { kind: 'edited', callId: 'c2', toolUseId: 'toolu_edit2', agentId: 's1:main', time: 2 },
      { kind: 'written', callId: 'c3', agentId: 's1:main', time: 3 },
    ],
    omitted: 0,
  },
}
const capped: FileAttention = {
  path: '/repo/src/b.ts', reads: 60, edits: 0, totalTokens: 10, lastAccessed: 3, agents: ['s1:main'],
  timeline: { steps: [{ kind: 'read', callId: 'c9', toolUseId: 'toolu_9', agentId: 's1:main', time: 9 }], omitted: 12 },
}
const none: FileAttention = { path: '/repo/src/c.ts', reads: 1, edits: 0, totalTokens: 0, lastAccessed: 1, agents: ['s1:main'] }
const files = new Map([withSteps, capped, none].map(f => [f.path, f]))

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)
}

function rowOf(container: HTMLElement, path: string): HTMLElement {
  const row = Array.from(container.querySelectorAll('li')).find(li => li.querySelector(`[title="${path}"]`))
  assert.ok(row, `row of ${path}`)
  return row as HTMLElement
}

test('a file with observed steps has a disclosure, a native summary reachable by keyboard', () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} agentLabel={agentLabel} />)
  const summary = rowOf(container, withSteps.path).querySelector('details > summary')
  assert.ok(summary, 'a <details>/<summary> disclosure')
  assert.match(summary.textContent ?? '', /3 steps observed/)
  ;(summary as HTMLElement).focus()
  assert.equal(document.activeElement, summary, 'the summary takes the focus')
})

test('the steps are an ordered list, said in words, each with its agent and its call', () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} agentLabel={agentLabel} />)
  const row = rowOf(container, withSteps.path)
  const list = within(row).getByRole('list', { name: `Steps of ${withSteps.path}` })
  assert.equal(list.tagName, 'OL')
  const items = within(list).getAllByRole('listitem').map(li => li.textContent ?? '')
  assert.equal(items.length, 3)
  assert.match(items[0], /read by alpha \(session Main\).*toolu_read1/)
  assert.match(items[1], /edited by alpha \(session Main\).*toolu_edit2/)
  assert.match(items[2], /written by alpha \(session Main\).*call id not reported/)
})

test('commits are never shown as a step, and the disclosure says why', () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} agentLabel={agentLabel} />)
  const row = rowOf(container, withSteps.path)
  assert.doesNotMatch(within(row).getByRole('list', { name: /Steps of/ }).textContent ?? '', /commit/i)
  assert.match(row.textContent ?? '', /Commits are not shown/)
})

test('steps beyond the cap are counted, never dropped silently', () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} agentLabel={agentLabel} />)
  const row = rowOf(container, capped.path)
  assert.match(row.textContent ?? '', /12 earlier steps not kept/)
  assert.match(row.querySelector('summary')?.textContent ?? '', /13 steps observed/)
})

test('a file without an observed step has no disclosure', () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} agentLabel={agentLabel} />)
  assert.equal(rowOf(container, none.path).querySelector('details'), null)
})

test('events the relay could not replay make the step count "incomplete"', () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} agentLabel={agentLabel} replayLost={4} />)
  assert.match(rowOf(container, withSteps.path).querySelector('summary')?.textContent ?? '', /3 steps observed \(incomplete\)/)
})

test('the panel with open timelines has no axe violation', async () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} onOpenFile={noop} agentLabel={agentLabel} />)
  for (const d of Array.from(container.querySelectorAll('details'))) d.open = true
  assert.deepEqual(await violations(container), [])
})
