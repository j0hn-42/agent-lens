// File tokens in the Files panel (#368): estimated and lower-bound figures are said in words, with or without the editor.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { FileAttentionPanel } from '@/components/agent-visualizer/file-attention-panel'
import { COLORS } from '@/lib/colors'
import type { FileAttention } from '@/lib/agent-types'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}
const base = { reads: 1, edits: 0, lastAccessed: 1, agents: ['main'] }
const est: FileAttention = { ...base, path: '/r/est.ts', totalTokens: 12_000, tokensEstimated: true }
const rep: FileAttention = { ...base, path: '/r/rep.ts', totalTokens: 3_000 }
const part: FileAttention = { ...base, path: '/r/part.ts', totalTokens: 2_000, tokensPartial: true }
const files = new Map([est, rep, part].map(f => [f.path, f]))

test('with the editor, the button name qualifies the figure', () => {
  const { getByRole, queryByRole } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} onOpenFile={noop} />)
  assert.ok(getByRole('button', { name: /est\.ts, 12k estimated tokens/ }))
  assert.ok(getByRole('button', { name: /part\.ts, at least 2k tokens/ }))
  assert.equal(queryByRole('button', { name: /rep\.ts.*(estimated|at least)/ }), null)
})

test('without the editor, the row text says estimated and at least, not only a symbol', () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} />)
  const rows = Array.from(container.querySelectorAll('li')).filter(li => /\.ts/.test(li.textContent ?? ''))
  const text = (name: string) => rows.find(li => (li.textContent ?? '').includes(name))?.textContent ?? ''
  assert.match(text('est.ts'), /12k estimated/)
  assert.match(text('part.ts'), /at least 2k/)
  assert.doesNotMatch(text('rep.ts'), /estimated|at least/)
})

test('the summary is qualified like every other total', () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} />)
  assert.match(container.textContent ?? '', /at least 17k estimated tokens in file reads/)
})

test('a heavy file is never drawn in the error red', () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} />)
  const red = COLORS.error.toLowerCase()
  const html = container.innerHTML.toLowerCase()
  assert.ok(!html.includes(red), 'no element uses the error color when there is no conflict')
})

test('reads and edits observed to succeed are counted apart from the calls started', () => {
  const mixed: FileAttention = {
    ...base, path: '/r/mixed.ts', totalTokens: 100, reads: 3, edits: 2,
    readers: [{ agent: 'main', started: 3, succeeded: 2 }],
    editors: [{ agent: 'main', started: 2, succeeded: 0 }],
  }
  const clean: FileAttention = {
    ...base, path: '/r/clean.ts', totalTokens: 100, reads: 2,
    readers: [{ agent: 'main', started: 2, succeeded: 2 }],
  }
  const { container } = render(<FileAttentionPanel visible fileAttention={new Map([[mixed.path, mixed], [clean.path, clean]])} onClose={noop} />)
  const rows = Array.from(container.querySelectorAll('li'))
  const text = (name: string) => rows.find(li => (li.textContent ?? '').includes(name))?.textContent ?? ''
  assert.match(text('mixed.ts'), /3 reads \(2 succeeded\)/)
  assert.match(text('mixed.ts'), /2 edits \(0 succeeded\)/)
  assert.match(text('clean.ts'), /2 reads/)
  assert.doesNotMatch(text('clean.ts'), /succeeded/)
})

test('a file with no figure at all says "not reported" on screen, not a bare symbol', () => {
  const none: FileAttention = { ...base, path: '/r/none.ts', totalTokens: 0, tokensPartial: true }
  const { container } = render(<FileAttentionPanel visible fileAttention={new Map([[none.path, none]])} onClose={noop} />)
  const row = Array.from(container.querySelectorAll('li')).find(li => (li.textContent ?? '').includes('none.ts'))!
  const visible = Array.from(row.querySelectorAll('span')).filter(s => !s.classList.contains('sr-only') && s.children.length === 0)
    .map(s => s.textContent).join(' ')
  assert.match(visible, /not reported/)
  assert.doesNotMatch(visible, /\?/)
})

test('the spoken figure of a row carries its unit', () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} />)
  const spoken = Array.from(container.querySelectorAll('.sr-only')).map(s => s.textContent ?? '')
  assert.ok(spoken.some(t => /12k estimated tokens/.test(t)), JSON.stringify(spoken))
})

test('the counters row wraps instead of overflowing a narrow panel', () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={files} onClose={noop} />)
  const reads = Array.from(container.querySelectorAll('li span')).find(s => /^\d+ reads?/.test(s.textContent ?? ''))!
  assert.ok(reads.parentElement!.classList.contains('flex-wrap'))
})

test('heavy, medium and light files are drawn in three distinct colours', () => {
  const mk = (name: string, totalTokens: number): FileAttention => ({ ...base, path: `/r/${name}.ts`, totalTokens })
  const heat = new Map([mk('heavy', 1000), mk('medium', 500), mk('light', 100)].map(f => [f.path, f]))
  const { container } = render(<FileAttentionPanel visible fileAttention={heat} onClose={noop} />)
  const colorOf = (name: string) => Array.from(container.querySelectorAll('li span'))
    .find(s => s.textContent === `/r/${name}.ts`)?.getAttribute('style')
  const colors = new Set(['heavy', 'medium', 'light'].map(colorOf))
  assert.equal(colors.size, 3, JSON.stringify([...colors]))
})
