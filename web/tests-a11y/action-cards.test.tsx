// Dedicated Edit / MultiEdit / Bash cards (#317): figures come from the call's input only, shape and
// text carry the meaning (never color alone), and nothing is shown when the input does not carry it.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import axe from 'axe-core'

import { ToolDetailPopup } from '@/components/agent-visualizer/tool-detail-popup'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const show = (toolName: string, inputData: Record<string, unknown>) =>
  render(
    <ToolDetailPopup
      tool={{ id: 't1', toolName, args: '', state: 'complete', inputData }}
      position={{ x: 10, y: 10 }}
      onClose={() => {}}
    />,
  )

test('Edit: a +N -M summary with a spoken equivalent', () => {
  const { getByRole } = show('Edit', { file_path: '/a.ts', old_string: 'a\nb\nc', new_string: 'x\ny' })
  const summary = getByRole('group', { name: 'Edit summary' })
  assert.match(summary.textContent ?? '', /\+2/)
  assert.match(summary.textContent ?? '', /-3/)
  assert.match(summary.textContent ?? '', /2 lines added, 3 lines removed/)
})

test('MultiEdit: every block is shown, numbered, with the block count', () => {
  const { getByRole, getAllByText } = show('MultiEdit', {
    file_path: '/a.ts',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd\ne' },
    ],
  })
  const summary = getByRole('group', { name: 'Edit summary' })
  assert.match(summary.textContent ?? '', /2 blocks/)
  assert.match(summary.textContent ?? '', /\+3/)
  assert.match(summary.textContent ?? '', /-2/)
  assert.equal(getAllByText(/^Block \d of 2$/).length, 2)
})

test('Edit without old_string / new_string: no summary is invented', () => {
  const { queryByRole } = show('Edit', { file_path: '/a.ts' })
  assert.equal(queryByRole('group', { name: 'Edit summary' }), null)
})

test('Bash: git and gh calls get a pill that names the subcommand in text', () => {
  const { getByRole } = show('Bash', { command: 'git add -A && git commit -m x && gh pr create --title t' })
  const list = getByRole('list', { name: 'Version control commands' })
  const items = Array.from(list.querySelectorAll('li')).map(li => li.textContent?.replace(/\s+/g, ' ').trim())
  assert.deepEqual(items, ['git add', 'git commit', 'gh pr create'])
})

test('Bash: no git / gh, no pill list; no exit code or duration is claimed', () => {
  const { queryByRole, container } = show('Bash', { command: 'ls -la' })
  assert.equal(queryByRole('list', { name: 'Version control commands' }), null)
  assert.doesNotMatch(container.textContent ?? '', /exit code|exited/i)
})

test('Write: the line count is stated in text', () => {
  const { getByText } = show('Write', { file_path: '/a.ts', content: 'a\nb\nc' })
  assert.ok(getByText('3 lines'))
})

test('Write without content: no count', () => {
  const { queryByText } = show('Write', { file_path: '/a.ts' })
  assert.equal(queryByText(/^\d+ lines?$/), null)
})

test('Read: the range is spelled out from offset and limit', () => {
  const { getByText } = show('Read', { file_path: '/a.ts', offset: 10, limit: 50 })
  assert.ok(getByText('lines 10–59'))
})

test('TodoWrite: progress counted from the list, stated in text', () => {
  const { getByRole } = show('TodoWrite', {
    todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }],
  })
  const p = getByRole('group', { name: 'Todo progress' })
  assert.match(p.textContent ?? '', /1 of 3 done/)
  assert.match(p.textContent ?? '', /1 in progress/)
})

test('WebFetch: the host is named on its own', () => {
  const { getByText } = show('WebFetch', { url: 'https://stripe.com/docs/api', prompt: 'p' })
  assert.ok(getByText('stripe.com'))
})

test('Task: sub-agent type and description are shown', () => {
  const { getByText } = show('Task', { subagent_type: 'Explore', description: 'Find the relay', prompt: 'long prompt' })
  assert.ok(getByText('Explore'))
  assert.ok(getByText('Find the relay'))
})

test('NotebookEdit: path, cell and mode as stated by the call', () => {
  const { container } = show('NotebookEdit', { notebook_path: '/n.ipynb', cell_number: 3, edit_mode: 'replace' })
  assert.match(container.textContent ?? '', /n\.ipynb/)
  assert.match(container.textContent ?? '', /cell 3/)
  assert.match(container.textContent ?? '', /replace/)
})

test('Bash: Python, test, docker and package commands get their own list', () => {
  const { getByRole } = show('Bash', { command: 'pnpm install && python analyse.py && pnpm test' })
  const list = getByRole('list', { name: 'Tooling commands' })
  const items = Array.from(list.querySelectorAll('li')).map(li => li.textContent?.replace(/\s+/g, ' ').trim())
  assert.deepEqual(items, ['pnpm install', 'python analyse.py', 'pnpm test'])
})

test('the new cards have no axe violation', async () => {
  for (const [name, input] of [
    ['Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: '/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] }],
    ['Bash', { command: 'git push origin main && pytest' }],
    ['TodoWrite', { todos: [{ content: 'a', status: 'completed' }] }],
    ['Task', { subagent_type: 'Explore', description: 'd' }],
    ['NotebookEdit', { notebook_path: '/n.ipynb', cell_number: 1 }],
  ] as const) {
    const { container } = show(name, input)
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    assert.deepEqual(res.violations.map(v => v.id), [], name)
    cleanup()
  }
})
