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
import { PermissionRequests } from '@/components/agent-visualizer/permission-requests'
import { formatPermissionTime } from '@/lib/permission-requests'

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

test('Approuver and Refuser differ by more than colour: an icon and a border style (#374)', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request() })
  const approve = r.getByRole('button', { name: /^Approuver Bash/ })
  const deny = r.getByRole('button', { name: /^Refuser Bash/ })
  assert.ok(approve.querySelector('svg[aria-hidden="true"]'), 'approve carries a decorative icon')
  assert.ok(deny.querySelector('svg[aria-hidden="true"]'), 'deny carries a decorative icon')
  assert.notEqual(approve.querySelector('svg')?.innerHTML, deny.querySelector('svg')?.innerHTML, 'not the same icon')
  assert.notEqual(approve.style.borderStyle, deny.style.borderStyle, 'not the same border')
})

test('the deadline carries a countdown "dans 42 s" next to the absolute time (#374)', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  const expiresAt = Date.now() + 42_500
  await post({ type: 'permission-request', request: request({ expiresAt, requestedAt: expiresAt - 60_000 }) })
  const row = r.getByRole('group', { name: /^Bash, session/ })
  assert.match(row.textContent ?? '', /dans (41|42|43) s/)
  assert.ok((row.textContent ?? '').includes(formatPermissionTime(expiresAt, 'fr')), 'the absolute time stays')
  assert.equal(row.querySelector('[aria-live]'), null, 'a ticking value is never a live region')
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

test('leaving the panel on a non focusable area never brings the focus back to Approuver', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request() })
  const approve = r.getByRole('button', { name: /^Approuver Bash/ })
  approve.focus()
  assert.equal(document.activeElement, approve)
  // click on a non focusable area: focusout with relatedTarget null, the focus goes to the body
  ;(document.activeElement as HTMLElement).blur()
  assert.equal(document.activeElement, document.body)
  r.rerender(<PermissionRequests sessionLabel={(id: string) => labels(id)} />)
  await post({ type: 'permission-request', request: request({ nonce: NONCE2, toolUseId: 'toolu_02' }) })
  assert.equal(document.activeElement, document.body, 'no focus taken back after the user left')
  posted = []
  fireEvent.keyDown(document.body, { key: 'Enter' })
  assert.deepEqual(decisions(), [], 'nothing decided')
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

// ─── Redirect (#387): a deny that carries the operator's text, from a modal dialog ─────────────────────────────

const REDIRECT_NAME = 'Rediriger Bash : npm test, session fix login'
const WRITE = { nonce: NONCE2, toolUseId: null, toolName: 'Write', inputPreview: '{"file_path":"/x"}' }
const toolEnd = (over: Record<string, unknown> = {}, event: Record<string, unknown> = {}) => post({
  type: 'agent-event',
  event: { time: 3, type: 'tool_call_end', sessionId: 'sess-1', payload: { agent: 'main', tool: 'Bash', result: 'use pnpm instead', toolUseId: 'toolu_01', isError: true, ...over }, ...event },
})

async function openRedirect(r: ReturnType<typeof render>, req = request()) {
  await post({ type: 'permission-request', request: req })
  const trigger = r.getByRole('button', { name: new RegExp(`^Rediriger ${req.toolName}`) })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = r.getByRole('dialog', { name: new RegExp(`^Rediriger ${req.toolName}`) })
  const field = r.getByRole('textbox', { name: /^Message pour Claude/ }) as HTMLTextAreaElement
  return { trigger, dialog, field }
}

async function sendRedirect(r: ReturnType<typeof render>, text = 'use pnpm instead', req = request()) {
  const opened = await openRedirect(r, req)
  fireEvent.change(opened.field, { target: { value: text } })
  fireEvent.click(r.getByRole('button', { name: /^Envoyer la redirection/ }))
  return opened
}

test('Rediriger is a third native button, named like the others, that opens a dialog', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request() })
  const b = r.getByRole('button', { name: REDIRECT_NAME })
  assert.equal(b.tagName, 'BUTTON')
  assert.equal(b.getAttribute('type'), 'button')
  assert.equal(b.textContent, 'Rediriger', 'the accessible name starts with the visible label (WCAG 2.5.3)')
  assert.equal(b.getAttribute('aria-haspopup'), 'dialog')
  assert.equal(r.queryByRole('dialog'), null, 'no dialog before the click')
})

test('the dialog is modal, names the request, puts the focus in the text field; axe-clean', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  posted = []
  const { dialog, field } = await openRedirect(r)
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  assert.equal(document.activeElement, field, 'focus in the text field')
  assert.equal(field.tagName, 'TEXTAREA')
  assert.equal(field.getAttribute('aria-required'), 'true')
  assert.equal(field.maxLength, 2000)
  assert.match(dialog.textContent ?? '', /npm test/, 'the request is recalled in the dialog')
  assert.match(dialog.textContent ?? '', /sess-1/)
  assert.deepEqual(decisions(), [], 'opening sends nothing')
  assert.deepEqual(await violations(document.body), [])
})

test('an empty or blank text is not sent: the field says why, politely, and the dialog stays open', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  const { dialog, field } = await openRedirect(r)
  posted = []
  for (const text of ['', '   \n', '\u200b']) {
    fireEvent.change(field, { target: { value: text } })
    fireEvent.click(r.getByRole('button', { name: /^Envoyer la redirection/ }))
    assert.deepEqual(decisions(), [], `nothing sent for ${JSON.stringify(text)}`)
    assert.ok(dialog.isConnected, 'still open')
    assert.equal(field.getAttribute('aria-invalid'), 'true')
    const ids = (field.getAttribute('aria-describedby') ?? '').split(' ')
    const error = ids.map(id => document.getElementById(id)).find(el => /obligatoire/i.test(el?.textContent ?? ''))
    assert.ok(error, 'the error is tied to the field')
    assert.ok(error!.closest('[aria-live="polite"]'), 'and announced politely')
  }
  assert.equal(document.activeElement, field, 'focus kept in the field')
  assert.deepEqual(await violations(document.body), [])
})

test('Échap closes the dialog without sending and gives the focus back to Rediriger', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  const { trigger, field } = await openRedirect(r)
  posted = []
  fireEvent.change(field, { target: { value: 'not sent' } })
  fireEvent.keyDown(field, { key: 'Escape' })
  assert.equal(r.queryByRole('dialog'), null)
  assert.deepEqual(decisions(), [])
  assert.equal(document.activeElement, trigger)
  // Reopened, the dialog does not keep the abandoned text
  fireEvent.click(trigger)
  assert.equal((r.getByRole('textbox', { name: /^Message pour Claude/ }) as HTMLTextAreaElement).value, '')
})

test('Annuler closes the dialog without sending and gives the focus back to Rediriger', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  const { trigger } = await openRedirect(r)
  posted = []
  fireEvent.click(r.getByRole('button', { name: 'Annuler' }))
  assert.equal(r.queryByRole('dialog'), null)
  assert.deepEqual(decisions(), [])
  assert.equal(document.activeElement, trigger)
})

test('Tab and Maj+Tab stay inside the dialog', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  const { dialog } = await openRedirect(r)
  const tabbables = Array.from(dialog.querySelectorAll<HTMLElement>('textarea, button, [tabindex="0"]'))
  assert.ok(tabbables.length >= 3)
  const first = tabbables[0]
  const last = tabbables[tabbables.length - 1]
  last.focus()
  fireEvent.keyDown(last, { key: 'Tab' })
  assert.equal(document.activeElement, first, 'Tab from the last control goes to the first')
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  assert.equal(document.activeElement, last, 'Maj+Tab from the first control goes to the last')
})

test('a text sends exactly one redirect with it; the row says sent, never applied, and keeps no text', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  posted = []
  const { trigger } = await sendRedirect(r, '  use pnpm instead  ')
  assert.deepEqual(decisions(), [{ type: 'permission-decision', sessionId: 'sess-1', toolUseId: 'toolu_01', nonce: NONCE, action: 'redirect', message: 'use pnpm instead' }])
  assert.equal(r.queryByRole('dialog'), null, 'the dialog closes once sent')
  assert.equal(document.activeElement, trigger, 'focus back on Rediriger')
  fireEvent.click(trigger)
  assert.equal(r.queryByRole('dialog'), null, 'no second dialog while the decision is on its way')
  assert.equal(decisions().length, 1, 'one decision per request')
  await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: 'toolu_01', outcome: 'sent' })
  const row = r.getByRole('group', { name: /^Bash, session/ })
  assert.match(row.textContent ?? '', /envoyée : rediriger/)
  assert.doesNotMatch(document.body.textContent ?? '', /appliqu/)
  assert.doesNotMatch(document.body.textContent ?? '', /use pnpm instead/, 'the text is not kept on screen')
  assert.ok(r.container.contains(document.activeElement), 'focus stays in the panel when the buttons go')
})

test('message-required from the extension: the request can be redirected again', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await sendRedirect(r, 'x')
  await post({ type: 'permission-result', nonce: NONCE, ok: false, reason: 'message-required' })
  assert.match(r.getByRole('status').textContent ?? '', /message est requis/)
  assert.ok(r.getByRole('button', { name: REDIRECT_NAME }), 'buttons back')
})

test('a request that closes while the dialog is open closes it, and the focus stays in the panel', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await openRedirect(r)
  posted = []
  await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: 'toolu_01', outcome: 'expired' })
  assert.equal(r.queryByRole('dialog'), null)
  assert.deepEqual(decisions(), [])
  assert.ok(r.container.contains(document.activeElement), 'focus not dropped on the page')
  assert.match(r.getByRole('status').textContent ?? '', /échéance/i)
})

test('a request answered from another panel while the dialog is open closes it too', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await openRedirect(r)
  await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: 'toolu_01', outcome: 'sent' })
  assert.equal(r.queryByRole('dialog'), null)
  assert.ok(r.container.contains(document.activeElement), 'focus not dropped on the page')
})

test('applied only once the refusal is observed: an error end of that very call, seen live after the decision', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await sendRedirect(r)
  await toolEnd()
  await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: 'toolu_01', outcome: 'sent' })
  assert.doesNotMatch(document.body.textContent ?? '', /appliqu/, 'an end seen before the extension said sent proves nothing')
  // None of these is the refusal of this call
  await toolEnd({ toolUseId: 'toolu_02' })
  await toolEnd({}, { sessionId: 'sess-2' })
  await toolEnd({ isError: false })
  await toolEnd({ isError: undefined })
  await toolEnd({ outcome: 'cancelled' })
  await toolEnd({}, { replayed: true })
  await toolEnd({}, { imported: true })
  // An error end that does not carry the refusal text: the tool may have run and failed, or been refused by someone else
  await toolEnd({ result: 'Exit code 1: npm ERR!' })
  await toolEnd({ result: 'The user doesn\'t want to proceed with this tool use.' })
  // The hook's PostToolUseFailure ([FAILED] prefix) is a call that ran and failed, whatever its text
  await toolEnd({ result: '[FAILED] use pnpm instead' })
  await post({ type: 'agent-event', event: { time: 3, type: 'tool_call_start', sessionId: 'sess-1', payload: { toolUseId: 'toolu_01', isError: true } } })
  const row = r.getByRole('group', { name: /^Bash, session/ })
  assert.doesNotMatch(row.textContent ?? '', /appliqu/)
  await toolEnd()
  assert.match(row.textContent ?? '', /Redirection appliquée/)
  assert.match(r.getByRole('status').textContent ?? '', /appliquée/)
  assert.deepEqual(await violations(r.container), [])
})

test('a long redirect text is found even when the result only keeps its beginning, spaces collapsed', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  const text = 'Do not run the whole suite.\n\nRun only   the permission tests, then report back what failed and why, in detail.'
  await sendRedirect(r, text)
  await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: 'toolu_01', outcome: 'sent' })
  await toolEnd({ result: 'Do not run the whole suite. Run only the permission' })
  assert.match(r.getByRole('group', { name: /^Bash, session/ }).textContent ?? '', /Redirection appliquée/)
})

test('a deny is applied the same way, on the text the extension sends with it', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request() })
  fireEvent.click(r.getByRole('button', { name: /^Refuser Bash/ }))
  await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: 'toolu_01', outcome: 'sent' })
  await toolEnd()
  assert.doesNotMatch(document.body.textContent ?? '', /appliqu/, 'another error text is not this refusal')
  await toolEnd({ result: 'Denied by the operator from Agent Lens.' })
  assert.match(r.getByRole('group', { name: /^Bash, session/ }).textContent ?? '', /Refus appliqué/)
})

test('an approval, a call that is not identified or a decision from another panel is never shown applied', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request() })
  fireEvent.click(r.getByRole('button', { name: /^Approuver Bash/ }))
  await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: 'toolu_01', outcome: 'sent' })
  await toolEnd({ isError: false })
  await toolEnd()
  await sendRedirect(r, 'no', request(WRITE))
  await post({ type: 'permission-closed', nonce: NONCE2, sessionId: 'sess-1', toolUseId: null, outcome: 'sent' })
  await toolEnd({ toolUseId: undefined, tool: 'Write', result: 'no' })
  assert.doesNotMatch(document.body.textContent ?? '', /appliqu/)
})

test('a request answered from another panel is never shown applied, even with a matching end', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  await post({ type: 'permission-request', request: request() })
  await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: 'toolu_01', outcome: 'sent' })
  assert.match(r.getByRole('group', { name: /^Bash, session/ }).textContent ?? '', /autre panneau/)
  await toolEnd({ result: 'Denied by the operator from Agent Lens.' })
  await toolEnd()
  assert.doesNotMatch(document.body.textContent ?? '', /appliqu/)
})

test('a click on the backdrop keeps the focus in the dialog, so Échap still closes it', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  const { dialog, field, trigger } = await openRedirect(r)
  const backdrop = dialog.parentElement!
  const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  backdrop.dispatchEvent(md)
  assert.equal(md.defaultPrevented, true, 'the mousedown does not move the focus out')
  assert.equal(document.activeElement, field)
  fireEvent.keyDown(field, { key: 'Escape' })
  assert.equal(r.queryByRole('dialog'), null)
  assert.equal(document.activeElement, trigger)
})

test('the dialog is described by its intro, and a second invalid send is announced again', async () => {
  const r = render(<PermissionRequests sessionLabel={labels} />)
  const { dialog } = await openRedirect(r)
  const described = document.getElementById(dialog.getAttribute('aria-describedby') ?? '')
  assert.match(described?.textContent ?? '', /refusera cet appel/)
  const send = r.getByRole('button', { name: /^Envoyer la redirection/ })
  const live = dialog.querySelector('[aria-live="polite"]')!
  fireEvent.click(send)
  const first = live.firstElementChild
  assert.match(first?.textContent ?? '', /obligatoire/)
  fireEvent.click(send)
  const second = live.firstElementChild
  assert.match(second?.textContent ?? '', /obligatoire/)
  assert.notEqual(second, first, 'a new node at each attempt, so the same text is read again')
})
