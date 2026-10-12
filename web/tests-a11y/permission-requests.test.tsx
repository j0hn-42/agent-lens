// Operator decisions in the VS Code panel (#240, PR 4): a waiting PermissionRequest is shown in full (tool, session,
// input, deadline) with two named buttons; a click sends exactly one permission-decision; the row then says "sent",
// never "applied"; errors and closings are announced politely, without moving the focus; axe-clean.
// The first test runs outside VS Code: the bridge singleton cannot leave VS Code mode once it entered it.
import { test, afterEach, before } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import axe from 'axe-core'

import { vscodeBridge } from '@/lib/vscode-bridge'
import { setLocaleChoice } from '@/lib/locale'
import { PermissionRequests, formatPermissionTime } from '@/components/agent-visualizer/permission-requests'

const NONCE = '0123456789abcdef0123456789abcdef'
const NONCE2 = 'fedcba9876543210fedcba9876543210'
const SHA = 'a'.repeat(64)
const EXPIRES = Date.UTC(2026, 9, 12, 14, 3, 12)

const request = (over: Record<string, unknown> = {}) => ({
  sessionId: 'sess-1', toolUseId: 'toolu_01', nonce: NONCE, toolName: 'Bash',
  inputPreview: '{"command":"npm test","description":"Run the tests"}', inputTruncated: false,
  inputSha256: SHA, requestedAt: EXPIRES - 60_000, expiresAt: EXPIRES, ...over,
})
const post = (data: unknown) => act(() => { vscodeBridge!.dispatch(data) })
const labels = (id: string) => (id === 'sess-1' ? 'fix login' : undefined)

let posted: Array<Record<string, unknown>> = []
const decisions = () => posted.filter(m => m.type === 'permission-decision')

before(() => { setLocaleChoice('fr') })
afterEach(() => { cleanup(); document.body.replaceChildren(); posted = [] })

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)
}

test('outside VS Code nothing is rendered, permission-surface is never sent and requests are ignored', () => {
  const sent: unknown[] = []
  const realPost = window.postMessage.bind(window)
  window.postMessage = ((m: unknown) => { sent.push(m) }) as typeof window.postMessage
  try {
    const r = render(<PermissionRequests sessionLabel={labels} />)
    act(() => { vscodeBridge!.dispatch({ type: 'permission-request', request: request() }) })
    assert.equal(r.container.innerHTML, '', 'no surface outside VS Code')
    r.unmount()
    assert.deepEqual(sent, [], 'nothing posted, permission-surface included')
  } finally {
    window.postMessage = realPost
  }
})

test('enter VS Code', () => {
  vscodeBridge!.configureWebviewApi(msg => posted.push(msg))
  assert.equal(vscodeBridge!.isVSCode, true)
})

test('a request shows the tool, the session, the whole input and the deadline; axe-clean', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  assert.deepEqual(posted, [{ type: 'permission-surface', ready: true }], 'the surface declares itself when mounted')
  await post({ type: 'permission-request', request: request() })
  const row = r.getByRole('group', { name: /^Bash, session/ })
  const text = row.textContent ?? ''
  assert.match(text, /Bash/)
  assert.match(text, /fix login/)
  assert.match(text, /sess-1/, 'the full session id is shown, not only its label')
  assert.ok(r.getByText('{"command":"npm test","description":"Run the tests"}'), 'the whole input is shown as text')
  assert.doesNotMatch(text, /tronquée/)
  assert.ok(text.includes(formatPermissionTime(EXPIRES, 'fr')), 'the deadline is shown')
  const time = row.querySelector('time')
  assert.equal(time?.getAttribute('datetime'), new Date(EXPIRES).toISOString())
  assert.deepEqual(await violations(r.container), [])
})

test('a truncated input says so', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request({ inputPreview: '{"command":"cat big', inputTruncated: true }) })
  assert.match(r.getByRole('group', { name: /^Bash, session/ }).textContent ?? '', /tronquée/)
})

test('two native buttons whose accessible name starts with their visible label (WCAG 2.5.3)', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request() })
  const approve = r.getByRole('button', { name: 'Approuver Bash : npm test, session fix login' })
  const deny = r.getByRole('button', { name: 'Refuser Bash : npm test, session fix login' })
  for (const [b, visible] of [[approve, 'Approuver'], [deny, 'Refuser']] as const) {
    assert.equal(b.tagName, 'BUTTON')
    assert.equal(b.getAttribute('type'), 'button')
    assert.notEqual(b.getAttribute('tabindex'), '-1', 'reachable with Tab')
    assert.equal(b.textContent, visible)
  }
})

test('without a label the session is named by its id', async () => {
  const r = render(<PermissionRequests />)
  await post({ type: 'permission-request', request: request({ inputPreview: '{"file_path":"/a/b.ts"}', toolName: 'Edit' }) })
  assert.ok(r.getByRole('button', { name: 'Approuver Edit : /a/b.ts, session sess-1' }))
})

test('a click sends exactly the decision, toolUseId null kept; the row says sent, never applied', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request({ toolUseId: null }) })
  posted = []
  const approve = r.getByRole('button', { name: /^Approuver Bash/ })
  approve.focus()
  fireEvent.click(approve)
  assert.deepEqual(decisions(), [{ type: 'permission-decision', sessionId: 'sess-1', toolUseId: null, nonce: NONCE, action: 'approve' }])
  // A second click while it is on its way sends nothing more
  const again = r.queryByRole('button', { name: /^Approuver Bash/ })
  if (again) fireEvent.click(again)
  assert.equal(decisions().length, 1, 'one decision per request')
  assert.doesNotMatch(document.body.textContent ?? '', /appliquée/)
  // The extension handed it to Claude Code: closed 'sent', then the result
  await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: null, outcome: 'sent' })
  await post({ type: 'permission-result', nonce: NONCE, ok: true })
  const row = r.getByRole('group', { name: /^Bash, session/ })
  assert.match(row.textContent ?? '', /envoyée/)
  assert.doesNotMatch(document.body.textContent ?? '', /appliquée/)
  assert.equal(r.queryByRole('button', { name: /^Approuver/ }), null, 'no second decision once sent')
  assert.equal(r.getByRole('status').getAttribute('aria-live'), 'polite')
  assert.match(r.getByRole('status').textContent ?? '', /envoyée/)
  assert.deepEqual(await violations(r.container), [])
})

test('Refuser sends a deny with the same fields', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request() })
  posted = []
  fireEvent.click(r.getByRole('button', { name: /^Refuser Bash/ }))
  assert.deepEqual(decisions(), [{ type: 'permission-decision', sessionId: 'sess-1', toolUseId: 'toolu_01', nonce: NONCE, action: 'deny' }])
})

test('a refused decision is announced and the request can be answered again when it still waits', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request() })
  fireEvent.click(r.getByRole('button', { name: /^Approuver Bash/ }))
  await post({ type: 'permission-result', nonce: NONCE, ok: false, reason: 'mismatch' })
  assert.match(r.getByRole('status').textContent ?? '', /\S/, 'the error is announced')
  assert.doesNotMatch(r.getByRole('group', { name: /^Bash, session/ }).textContent ?? '', /envoyée/)
  assert.ok(r.getByRole('button', { name: /^Approuver Bash/ }), 'still waiting: the buttons are back')
})

test('a result without a nonce (control off) is announced', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-result', nonce: null, ok: false, reason: 'disabled' })
  assert.match(r.getByRole('status').textContent ?? '', /allowControl/)
})

for (const [outcome, pattern] of [
  ['expired', /échéance/i], ['answered-elsewhere', /ailleurs/], ['disabled', /désactivé/], ['surface-closed', /panneau/],
] as const) {
  test(`permission-closed ${outcome} removes the request and announces why`, async () => {
    const r = render(<PermissionRequests sessionLabel={labels} />)
    await post({ type: 'permission-request', request: request() })
    await post({ type: 'permission-request', request: request({ nonce: NONCE2, toolName: 'Write', inputPreview: '{"file_path":"/x"}' }) })
    await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: 'toolu_01', outcome })
    assert.equal(r.queryByRole('group', { name: /^Bash, session/ }), null, 'removed')
    assert.ok(r.getByRole('group', { name: /^Write, session/ }), 'the other request stays')
    const status = r.getByRole('status')
    assert.equal(status.getAttribute('aria-live'), 'polite')
    assert.match(status.textContent ?? '', pattern)
    assert.match(status.textContent ?? '', /Bash/)
  })
}

test('announcements never steal the focus, and no global shortcut answers a request', async () => {
  const outside = document.createElement('button')
  outside.textContent = 'ailleurs'
  document.body.appendChild(outside)
  const r = render(<PermissionRequests sessionLabel={labels} />)
  outside.focus()
  await post({ type: 'permission-request', request: request() })
  assert.equal(document.activeElement, outside, 'a new request does not take the focus')
  posted = []
  for (const key of ['Enter', 'y', 'a', 'n', 'Escape']) {
    fireEvent.keyDown(document, { key })
    fireEvent.keyDown(outside, { key })
  }
  assert.deepEqual(decisions(), [], 'no key outside the buttons decides')
  await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: 'toolu_01', outcome: 'expired' })
  assert.equal(document.activeElement, outside, 'a closing does not take the focus')
  r.unmount()
})

test('focus inside a request that closes stays in the panel instead of falling to the page', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request() })
  r.getByRole('button', { name: /^Refuser Bash/ }).focus()
  await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: 'toolu_01', outcome: 'expired' })
  assert.ok(r.container.contains(document.activeElement), 'focus kept in the panel')
})

test('invisible characters of the input are shown as escapes, never interpreted', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request({ inputPreview: '{"command":"rm -rf /tmp/x‮#"}' }) })
  assert.ok(r.getByText('{"command":"rm -rf /tmp/x\\u202e#"}'))
  assert.doesNotMatch(document.body.textContent ?? '', /‮/)
})

test('invalid requests are ignored', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request({ nonce: 'not-a-nonce' }) })
  await post({ type: 'permission-request', request: request({ toolName: 'Ba\u0007sh' }) })
  await post({ type: 'permission-request', request: { ...request(), expiresAt: 'soon' } })
  assert.equal(r.queryByRole('group'), null)
})

test('unmounting withdraws the surface', () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  posted = []
  r.unmount()
  assert.deepEqual(posted, [{ type: 'permission-surface', ready: false }])
})
