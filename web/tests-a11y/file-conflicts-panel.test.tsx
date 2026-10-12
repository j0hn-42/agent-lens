// File conflicts in the Files panel (#227): the proven conflicts are listed in words, reachable by keyboard, axe-clean.
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
const names: Record<string, string> = { 's1:main': 'alpha (session Main)', 's2:main': 'beta (session Fix)' }
const agentLabel = (key: string) => names[key] ?? key

const conflicted: FileAttention = {
  path: '/repo/src/a.ts', reads: 1, edits: 2, totalTokens: 300, lastAccessed: 5, agents: ['s1:main', 's2:main'],
  editors: [
    { agent: 's1:main', started: 1, succeeded: 1, lastEditTime: 3 },
    { agent: 's2:main', started: 1, succeeded: 1, lastEditTime: 5 },
  ],
}
const pending: FileAttention = {
  path: '/repo/src/b.ts', reads: 0, edits: 2, totalTokens: 0, lastAccessed: 4, agents: ['s1:main', 's2:main'],
  editors: [
    { agent: 's1:main', started: 1, succeeded: 1, lastEditTime: 2 },
    { agent: 's2:main', started: 1, succeeded: 0 },
  ],
}
const files = new Map([[conflicted.path, conflicted], [pending.path, pending]])

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)
}

test('the conflicts list names the file and every agent whose edit succeeded', () => {
  const { getByRole } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} agentLabel={agentLabel} />)
  const list = getByRole('list', { name: 'File conflicts' })
  const items = within(list).getAllByRole('listitem')
  assert.equal(items.length, 1, 'an edit whose success was not observed is not a conflict')
  assert.match(items[0].textContent ?? '', /\/repo\/src\/a\.ts/)
  assert.match(items[0].textContent ?? '', /edited by alpha \(session Main\): 1 successful edit; beta \(session Fix\): 1 successful edit/)
})

test('the file row says "conflict" in words, not only by colour', () => {
  const { getAllByText } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} agentLabel={agentLabel} />)
  const tags = getAllByText('conflict', { exact: true })
  assert.equal(tags.length, 1)
})

test('with the editor open, each conflict is a button whose name states the conflict', () => {
  let opened = ''
  const { getByRole } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} onOpenFile={p => { opened = p }} agentLabel={agentLabel} />)
  const list = getByRole('list', { name: 'File conflicts' })
  const button = within(list).getByRole('button')
  assert.match(button.getAttribute('aria-label') ?? '', /^Open \/repo\/src\/a\.ts, conflict: edited by alpha \(session Main\)/)
  button.click()
  assert.equal(opened, '/repo/src/a.ts')
})

test('no conflict, no conflicts list', () => {
  const { queryByRole } = render(<FileAttentionPanel visible fileAttention={new Map([[pending.path, pending]])} onClose={noop} />)
  assert.equal(queryByRole('list', { name: 'File conflicts' }), null)
})

test('the panel with conflicts has no axe violation', async () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} onOpenFile={noop} agentLabel={agentLabel} />)
  assert.deepEqual(await violations(container), [])
})
