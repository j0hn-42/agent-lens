// Waste section of the Files panel (#234): honest wording, keyboard operation, accessible names, axe-clean.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { FileAttentionPanel } from '@/components/agent-visualizer/file-attention-panel'
import { emptyWasteLedger, recordToolStart, recordToolEnd, MAX_WASTE_TRACKED, type WasteLedger } from '@/lib/waste'
import type { Agent } from '@/lib/agent-types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const noop = () => {}
const AGENT = 'default:main'
let n = 0

function reads(ledger: WasteLedger, path: string, count: number, cost?: number): WasteLedger {
  for (let i = 0; i < count; i++) {
    const id = `tc${++n}`
    ledger = recordToolStart(ledger, { sessionId: 'default', agentId: AGENT, toolName: 'Read', inputData: { file_path: path }, toolUseId: id, toolCallId: id, time: n })
    if (cost !== undefined) ledger = recordToolEnd(ledger, id, cost, 'reported')
  }
  return ledger
}

const named = new Map<string, Agent>([[AGENT, { id: AGENT, displayName: 'Orchestrator' } as unknown as Agent]])

const panel = (waste: WasteLedger, extra: Partial<React.ComponentProps<typeof FileAttentionPanel>> = {}) =>
  render(<FileAttentionPanel visible fileAttention={new Map()} waste={waste} agents={named} onClose={noop} {...extra} />)

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(x => x.html).join(' | ')}`)
}

test('nothing repeated: the section says "none observed", not "none", and names its blind spot', () => {
  const { getByRole } = panel(emptyWasteLedger())
  const section = getByRole('region', { name: 'Repeated reads and calls' })
  assert.match(section.textContent ?? '', /No repeat observed/)
  assert.match(section.textContent ?? '', /Edits made through Bash are not seen/)
})

test('a repeated read is listed with its agent, its count and the cost of the repeats only', () => {
  const { getByRole } = panel(reads(reads(emptyWasteLedger(), '/src/a.ts', 1, 900), '/src/a.ts', 2, 150))
  const item = getByRole('region', { name: 'Repeated reads and calls' }).querySelector('li')!
  assert.match(item.textContent ?? '', /Orchestrator/)
  assert.match(item.textContent ?? '', /read again 2 times, no edit seen in between/)
  assert.match(item.textContent ?? '', /300 tokens/, 'the 900 of the first read is not waste')
})

test('a repeat with no reported cost says "not reported", never 0; a partial cost says "at least"', () => {
  const none = panel(reads(emptyWasteLedger(), '/a.ts', 2))
  assert.match(none.container.textContent ?? '', /tokens not reported/)
  assert.doesNotMatch(none.container.textContent ?? '', /\b0 tokens/)
  cleanup()
  let l = reads(emptyWasteLedger(), '/a.ts', 1)
  l = reads(l, '/a.ts', 1, 400)
  l = reads(l, '/a.ts', 1)
  const some = panel(l)
  assert.match(some.container.textContent ?? '', /at least 400 tokens/)
})

test('an agent unknown to the view is shown by its key, not invented', () => {
  const { container } = panel(reads(emptyWasteLedger(), '/a.ts', 2), { agents: new Map() })
  assert.match(container.textContent ?? '', /default:main/)
})

test('an absolute path opens through a real button with an accessible name, reachable by keyboard', () => {
  const opened: string[] = []
  const { getByRole } = panel(reads(emptyWasteLedger(), '/src/deep/a.ts', 2), { onOpenFile: p => opened.push(p) })
  const btn = getByRole('button', { name: /^Open Read .*src\/deep\/a\.ts$/ }) as HTMLButtonElement
  assert.ok(btn.tabIndex >= 0, 'in the tab order')
  btn.focus()
  assert.equal(document.activeElement, btn)
  fireEvent.click(btn)   // Enter and Space on a native button dispatch a click
  assert.deepEqual(opened, ['/src/deep/a.ts'])
})

test('without a way to open files, or for a relative path, the target is text, not a dead button', () => {
  const noOpen = panel(reads(emptyWasteLedger(), '/src/a.ts', 2))
  assert.equal(noOpen.queryByRole('button', { name: /Open/ }), null)
  cleanup()
  const rel = panel(reads(emptyWasteLedger(), 'src/a.ts', 2), { onOpenFile: noop })
  assert.equal(rel.queryByRole('button', { name: /Open/ }), null)
})

test('a command or a pattern is never offered as a file to open', () => {
  let l = emptyWasteLedger()
  for (let i = 0; i < 2; i++) {
    const id = `c${++n}`
    l = recordToolStart(l, { sessionId: 'default', agentId: AGENT, toolName: 'Bash', inputData: { command: '/usr/bin/ls' }, toolUseId: id, toolCallId: id, time: n })
  }
  const { queryByRole, container } = panel(l, { onOpenFile: noop })
  assert.equal(queryByRole('button', { name: /Open/ }), null)
  assert.match(container.textContent ?? '', /same Bash command run again 1 time, right after itself/)
})

test('calls that could not be compared and a reached limit are said out loud', () => {
  let l = emptyWasteLedger()
  l = recordToolStart(l, { sessionId: 'default', agentId: AGENT, toolName: 'Read', toolUseId: 'x1', toolCallId: 'x1', time: 1 })
  const a = panel(l)
  assert.match(a.container.textContent ?? '', /1 call had no input details and was not compared/)
  cleanup()
  for (let i = 0; i < MAX_WASTE_TRACKED + 1; i++) l = recordToolStart(l, { sessionId: 'default', agentId: AGENT, toolName: 'Read', inputData: { file_path: `/f${i}` }, toolUseId: `y${i}`, toolCallId: `y${i}`, time: i })
  const b = panel(l)
  assert.match(b.container.textContent ?? '', /Tracking limit reached: this list is a lower bound/)
})

test('only the first rows are drawn, and the rest is counted', () => {
  let l = emptyWasteLedger()
  for (let i = 0; i < 25; i++) l = reads(l, `/f${i}.ts`, 2)
  const { getByRole } = panel(l)
  const section = getByRole('region', { name: 'Repeated reads and calls' })
  assert.equal(section.querySelectorAll('li').length, 20)
  assert.match(section.textContent ?? '', /5 more not shown/)
})

test('axe: empty and filled sections have no violation', async () => {
  const empty = panel(emptyWasteLedger(), { onOpenFile: noop })
  assert.deepEqual(await violations(empty.container), [])
  cleanup()
  const filled = panel(reads(reads(emptyWasteLedger(), '/src/a.ts', 3, 50), '/src/b.ts', 2), { onOpenFile: noop })
  assert.deepEqual(await violations(filled.container), [])
})

test('the panel still renders without a ledger (older callers)', () => {
  const { container } = render(<FileAttentionPanel visible fileAttention={new Map()} onClose={noop} />)
  assert.ok(container.querySelector('[data-dock-panel="files"]'))
})
