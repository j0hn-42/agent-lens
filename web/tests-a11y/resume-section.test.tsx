// "Copy resume command" in the Context panel (#240, PR 1): shown only when provable, copied with copyText,
// the outcome announced in a polite status line, a native named button, axe-clean.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import axe from 'axe-core'

import { ProjectContextPanel } from '@/components/agent-visualizer/project-context-panel'
import type { SessionInfo } from '@/lib/bridge-types'

const ID = '0f6c3a1e-58b2-4c1d-9a0e-2b7d4e5f6a7b'
const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: ID, label: 'fix login', status: 'active', startTime: 1, lastActivityTime: 2,
  runtime: 'claude', cwd: "/home/me/l'app web", ...over,
})

let copied: string[] = []
let clipboardFails = false
beforeEach(() => {
  copied = []; clipboardFails = false
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t: string) => { if (clipboardFails) throw new Error('denied'); copied.push(t) } },
  })
})
afterEach(() => { cleanup(); document.body.replaceChildren() })

const noop = () => {}
const never = () => new Promise<never>(() => {})
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

const show = (s: SessionInfo | undefined, extra: Partial<React.ComponentProps<typeof ProjectContextPanel>> = {}) =>
  render(<ProjectContextPanel visible sessionId={s?.id ?? ID} session={s} fetchContext={never} onClose={noop} {...extra} />)

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)
}

test('a resumable session shows the command and a named, keyboard-reachable Copy button', () => {
  const r = show(session())
  const expected = `cd '/home/me/l'\\''app web' && claude --resume ${ID}`
  assert.ok(r.getByText(expected), 'the command is shown as text, so it can be read before copying')
  const btn = r.getByRole('button', { name: 'Copy resume command' })
  assert.equal(btn.tagName, 'BUTTON')
  assert.equal(btn.getAttribute('type'), 'button')
  assert.notEqual(btn.getAttribute('tabindex'), '-1')
})

test('Copy puts the exact command on the clipboard and announces it politely', async () => {
  const r = show(session())
  const status = r.getByTestId('resume-copy-feedback')
  assert.equal(status.getAttribute('role'), 'status')
  const btn = r.getByRole('button', { name: 'Copy resume command' })
  btn.focus()
  fireEvent.click(btn)
  await flush()
  assert.deepEqual(copied, [`cd '/home/me/l'\\''app web' && claude --resume ${ID}`])
  assert.match(status.textContent ?? '', /Resume command copied/)
  // assert.ok, not assert.equal: a failing equal would print the whole jsdom tree
  assert.ok(document.activeElement === btn, 'focus stays on the button')
})

test('a refused clipboard is announced as a failure, never as a success', async () => {
  clipboardFails = true
  const exec = (document as unknown as { execCommand?: unknown }).execCommand
  ;(document as unknown as { execCommand: unknown }).execCommand = () => false
  try {
    const r = show(session())
    fireEvent.click(r.getByRole('button', { name: 'Copy resume command' }))
    await flush()
    const text = r.getByTestId('resume-copy-feedback').textContent ?? ''
    assert.match(text, /Copy failed/)
    assert.doesNotMatch(text, /copied/)
  } finally {
    ;(document as unknown as { execCommand: unknown }).execCommand = exec
  }
})

test('no button, and the reason, for an imported session, another runtime, an unknown cwd or an invalid id', () => {
  const cases: Array<[Partial<SessionInfo>, RegExp]> = [
    [{ imported: true }, /imported transcript/i],
    [{ runtime: 'codex' }, /only Claude Code sessions/i],
    [{ runtime: undefined }, /only Claude Code sessions/i],
    [{ cwd: undefined }, /working directory .* unknown/i],
    [{ cwd: '/a\nb' }, /working directory/i],
    [{ id: 'a;b' }, /session id/i],
  ]
  for (const [over, reason] of cases) {
    const r = show(session(over))
    assert.equal(r.queryByRole('button', { name: /resume command/i }), null, JSON.stringify(over))
    assert.match(r.container.textContent ?? '', reason)
    assert.doesNotMatch(r.container.textContent ?? '', /claude --resume [^\s]/)
    cleanup()
  }
})

test('it is offered inside VS Code too: it needs no relay', () => {
  const r = show(session(), { unavailableReason: 'vscode' })
  assert.ok(r.getByRole('button', { name: 'Copy resume command' }))
})

test('nothing is shown for the All view or without session info', () => {
  const all = render(<ProjectContextPanel visible sessionId={null} session={session()} fetchContext={never} onClose={noop} />)
  assert.equal(all.queryByRole('button', { name: /resume command/i }), null)
  cleanup()
  const none = show(undefined)
  assert.equal(none.queryByRole('button', { name: /resume command/i }), null)
})

test('the resume block is axe-clean, available or not', async () => {
  const ok = show(session())
  assert.deepEqual(await violations(ok.container), [])
  cleanup()
  const no = show(session({ imported: true }))
  assert.deepEqual(await violations(no.container), [])
})

// "Go to terminal" (#240, PR 2): VS Code only, it asks the extension for a terminal in the session's directory.
test('without a VS Code bridge there is no terminal button', () => {
  const r = show(session())
  assert.equal(r.queryByRole('button', { name: /terminal/i }), null)
})

test('inside VS Code a named button asks for a terminal of this session and says only that it asked', () => {
  const asked: string[] = []
  const r = show(session(), { onOpenTerminal: (id: string) => { asked.push(id) } })
  const btn = r.getByRole('button', { name: 'Go to terminal: open a terminal in the session directory' })
  assert.equal(btn.tagName, 'BUTTON')
  assert.equal(btn.getAttribute('type'), 'button')
  btn.focus()
  fireEvent.click(btn)
  assert.deepEqual(asked, [ID], 'only the session id is sent, never the directory')
  const status = r.getByTestId('resume-copy-feedback')
  assert.match(status.textContent ?? '', /Asked VS Code to open a terminal/)
  assert.doesNotMatch(status.textContent ?? '', /\bopened\b/)
  assert.ok(document.activeElement === btn, 'focus stays on the button')
})

test('the terminal button name contains its visible text (WCAG 2.5.3 Label in Name)', () => {
  const r = show(session(), { onOpenTerminal: () => {} })
  const btn = r.getByRole('button', { name: /terminal/i })
  const visible = (btn.textContent ?? '').trim()
  assert.ok(visible.length > 0)
  assert.ok((btn.getAttribute('aria-label') ?? '').toLowerCase().includes(visible.toLowerCase()), 'the accessible name starts from the visible label')
  assert.ok((btn.getAttribute('aria-label') ?? '').toLowerCase().startsWith(visible.toLowerCase()))
})

test('the terminal button needs a known directory, also for a session that cannot be resumed', () => {
  const noCwd = show(session({ cwd: undefined }), { onOpenTerminal: () => {} })
  assert.equal(noCwd.queryByRole('button', { name: /terminal/i }), null)
  cleanup()
  const codex = show(session({ runtime: 'codex' }), { onOpenTerminal: () => {} })
  assert.ok(codex.getByRole('button', { name: 'Go to terminal: open a terminal in the session directory' }))
  assert.equal(codex.queryByRole('button', { name: /resume command/i }), null)
  cleanup()
  const imported = show(session({ imported: true }), { onOpenTerminal: () => {} })
  assert.equal(imported.queryByRole('button', { name: /terminal/i }), null)
})

test('the block with the terminal button is axe-clean', async () => {
  const r = show(session(), { onOpenTerminal: () => {} })
  assert.deepEqual(await violations(r.container), [])
})
