// #518 (option B): the Files & repeats panel. Its name is the same in its title and its scroll region (WCAG 2.4.6, 3.2.4), and
// "Repeated reads and calls" is a native disclosure (Enter / Space, state announced by the browser) whose summary keeps the count,
// from the same data as the list and with its qualifiers under loss. Folded while files are listed, open when none is.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import axe from 'axe-core'

import { FileAttentionPanel } from '@/components/agent-visualizer/file-attention-panel'
import { emptyWasteLedger, recordToolStart, type WasteLedger } from '@/lib/waste'
import type { FileAttention } from '@/lib/agent-types'
import { setLocaleChoice } from '@/lib/locale'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'

afterEach(() => { cleanup(); document.body.replaceChildren(); act(() => setLocaleChoice('auto')) })

const noop = () => {}

function repeats(count: number, extra: Partial<WasteLedger> = {}): WasteLedger {
  let l = emptyWasteLedger()
  let n = 0
  for (let r = 0; r < count; r++) for (let i = 0; i < 2; i++) {
    const id = `t${++n}`
    l = recordToolStart(l, { sessionId: 's', agentId: 's:a', toolName: 'Read', inputData: { file_path: `/repo/f${r}.ts` }, toolUseId: id, toolCallId: id, time: n })
  }
  return { ...l, ...extra }
}

const FILE: FileAttention = { path: '/repo/src/a.ts', reads: 1, edits: 0, totalTokens: 1200, lastAccessed: 1, agents: ['s:a'] }
const files = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`/repo/src/${i}.ts`, { ...FILE, path: `/repo/src/${i}.ts` }]))

const panel = (waste: WasteLedger, fileCount = 1, extra: Partial<React.ComponentProps<typeof FileAttentionPanel>> = {}) =>
  render(<FileAttentionPanel visible fileAttention={files(fileCount)} waste={waste} onClose={noop} {...extra} />)

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(x => x.html).join(' | ')}`)
}

const summaryOf = (c: HTMLElement) => c.querySelector('details > summary') as HTMLElement

test('the panel title and its scroll region carry the one name of the panel, in English and in French', () => {
  const en = panel(repeats(1))
  assert.ok(en.getByText('FILES & REPEATS'))
  assert.ok(en.getByRole('region', { name: 'Files & repeats observed' }))
  cleanup()
  act(() => setLocaleChoice('fr'))
  const fr = panel(repeats(1))
  assert.ok(fr.getByText('FICHIERS ET RÉPÉTITIONS'))
  assert.ok(fr.getByRole('region', { name: 'Fichiers et répétitions observés' }))
})

test('the repeats are a native disclosure, folded while files are listed, with the count in its summary', () => {
  const { container, getByRole } = panel(repeats(5), 8)
  const details = container.querySelector('details') as HTMLDetailsElement
  assert.ok(details, 'a details element')
  assert.equal(details.open, false, 'folded: the file list comes first')
  const summary = summaryOf(container)
  assert.equal(summary.textContent, 'Repeated reads and calls: 5 observed')
  // 2.5.3: the summary has no aria-label, its name is its visible text
  assert.equal(summary.getAttribute('aria-label'), null)
  // The section stays reachable by headings (1.3.1): an h3 outside the summary names it
  const section = getByRole('region', { name: 'Repeated reads and calls' })
  assert.equal(section.querySelector('summary h3, summary [role="heading"]'), null, 'no heading inside the summary')
  assert.ok(section.querySelector('h3'), 'the heading is kept, before the disclosure')
})

test('open when no file is listed, so the section is not hidden behind an empty list', () => {
  const { container } = panel(repeats(2), 0)
  assert.equal((container.querySelector('details') as HTMLDetailsElement).open, true)
})

test('opening and closing: a click on the summary (Enter and Space on a native summary) toggles the list', () => {
  const { container } = panel(repeats(3), 4)
  const details = container.querySelector('details') as HTMLDetailsElement
  const summary = summaryOf(container)
  assert.ok(summary.tabIndex >= 0 || summary.matches('details > summary:first-of-type'), 'focusable by the browser')
  summary.focus()
  assert.equal(document.activeElement, summary, 'the summary takes the focus')
  fireEvent.click(summary)
  assert.equal(details.open, true, 'opened')
  assert.equal(details.querySelectorAll('li').length, 3, 'the three findings are listed')
  fireEvent.click(summary)
  assert.equal(details.open, false, 'closed again')
})

test('the summary draws the focus ring of the repo and a 24 px target', () => {
  const summary = summaryOf(panel(repeats(1), 2).container)
  for (const cls of FOCUS_RING_INSET.split(/\s+/).filter(Boolean)) assert.ok(summary.classList.contains(cls), cls)
  assert.ok(summary.classList.contains('min-h-6'))
})

test('the count is the number of findings, the list shows 20 and counts the rest', () => {
  const { container } = panel(repeats(25), 1)
  assert.equal(summaryOf(container).textContent, 'Repeated reads and calls: 25 observed')
  const details = container.querySelector('details')!
  assert.equal(details.querySelectorAll('li').length, 20)
  assert.match(details.textContent ?? '', /5 more not shown/)
})

test('under loss the summary keeps the qualifiers of the list: "at least", "incomplete", calls not compared', () => {
  assert.equal(summaryOf(panel(repeats(2), 1, { replayLost: 3 }).container).textContent, 'Repeated reads and calls: at least 2 observed')
  cleanup()
  assert.equal(summaryOf(panel(repeats(2, { limitReached: true }), 1).container).textContent, 'Repeated reads and calls: at least 2 observed')
  cleanup()
  assert.equal(summaryOf(panel(repeats(0), 1, { replayLost: 3 }).container).textContent, 'Repeated reads and calls: none observed (incomplete)')
  cleanup()
  assert.equal(summaryOf(panel(repeats(0, { uncompared: 2 }), 1).container).textContent, 'Repeated reads and calls: none observed, 2 calls not compared')
  cleanup()
  act(() => setLocaleChoice('fr'))
  assert.equal(summaryOf(panel(repeats(0), 1, { replayLost: 3 }).container).textContent, 'Lectures et appels répétés : aucun observé (incomplet)')
})

test('axe finds nothing, folded and unfolded, in both languages', async () => {
  for (const locale of ['en', 'fr'] as const) {
    act(() => setLocaleChoice(locale))
    const { container } = panel(repeats(3), 3, { onOpenFile: noop })
    assert.deepEqual(await violations(container), [], `${locale} folded`)
    fireEvent.click(summaryOf(container))
    assert.deepEqual(await violations(container), [], `${locale} unfolded`)
    cleanup()
  }
})
