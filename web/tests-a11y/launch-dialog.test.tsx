// Launch an agent on an issue (#229): the button of the inspector, the confirmation dialog (modal, focus on
// "Annuler", focus trap, Escape, focus back to the button), the token field (password, never persisted, cleared on
// close) and the states announced in a role=status region. jsdom, axe and keyboard.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent, within } from '@testing-library/react'
import axe from 'axe-core'

import { AgentDetailCard } from '@/components/agent-visualizer/agent-detail-card'
import { LaunchDialog } from '@/components/agent-visualizer/launch-dialog'
import { createFreshnessClock } from '@/hooks/use-freshness-clock'
import type { LaunchView } from '@/lib/bridge-types'
import { setLocaleChoice } from '@/lib/locale'

const g = globalThis as unknown as Record<string, unknown>
const realFetch = g.fetch
const TOKEN = 'f'.repeat(64)
let calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = []
let launchAnswer: { ok: boolean; status: number; body: unknown } = { ok: true, status: 202, body: {} }

const NOW = 1_700_000_000_000
const clock = createFreshnessClock({ now: () => NOW, isHidden: () => true })
let roleSeq = 0
const agent = (role: string) => ({
  state: 'thinking' as const, tokensUsed: 1, tokensMax: 10, toolCalls: 0, timeAlive: 1,
  id: 's1:w', name: 'worker', lastEventAt: NOW, freshnessSource: 'live' as const, subagentType: role,
})
const view = (over: Partial<LaunchView> = {}): LaunchView => ({
  id: '0123456789abcdef', repo: 'o/r', issue: 7, role: 'r', worktree: 'issue-7-r',
  sessionId: '0f6c3a1e-58b2-4c1d-9a0e-2b7d4e5f6a7b', state: 'requested', requestedAt: 1, outputBytes: 0, outputDroppedBytes: 0, ...over,
})
const links = [
  { kind: 'issue', number: 7, title: 'Titre <b>7</b>', state: 'open', url: 'https://github.com/o/r/issues/7' },
  { kind: 'issue', number: 8, title: 'Fermée', state: 'closed', url: 'https://github.com/o/r/issues/8' },
  { kind: 'pr', number: 9, title: 'PR', state: 'open', url: 'https://github.com/o/r/pull/9' },
]

beforeEach(() => {
  act(() => { setLocaleChoice('fr') }) // the wording under test is the French one; English is checked last
  calls = []
  launchAnswer = { ok: true, status: 202, body: view() }
  g.fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, init })
    if (url.includes('/issue-links')) return { ok: true, status: 200, json: async () => ({ links }) }
    return { ok: launchAnswer.ok, status: launchAnswer.status, json: async () => launchAnswer.body }
  }
})
afterEach(() => {
  cleanup()
  act(() => { setLocaleChoice('auto') })
  document.body.replaceChildren()
  g.fetch = realFetch
})

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)) })

const showCard = async (launch: { maxConcurrent: number; launches: ReadonlyMap<string, LaunchView> } | null) => {
  const role = `launch-role-${++roleSeq}` // the links cache is per role
  const v = render(<AgentDetailCard agent={agent(role)} toolErrors={0} onClose={() => {}} freshnessClock={clock} relayOrigin="" launch={launch} />)
  await flush()
  return { v, role }
}

async function violations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)
}

test('the button is rendered only when status.launch is present, and only for an open issue', async () => {
  const off = await showCard(null)
  assert.ok(off.v.getByTestId('issue-links'), 'the links are there')
  assert.equal(off.v.queryByRole('button', { name: /Lancer un agent/ }), null, 'no button without status.launch')
  cleanup()
  const on = await showCard({ maxConcurrent: 1, launches: new Map() })
  const buttons = on.v.getAllByRole('button', { name: /Lancer un agent sur l'issue #\d+/ })
  assert.deepEqual(buttons.map(b => b.textContent), ["Lancer un agent sur l'issue #7"], 'not for a closed issue nor a PR')
  assert.equal(buttons[0].tagName, 'BUTTON')
})

test('the dialog opens as a labelled modal, focus on "Annuler", Tab is trapped, Escape closes and focus returns to the button', async () => {
  const { v } = await showCard({ maxConcurrent: 1, launches: new Map() })
  assert.equal(v.queryByRole('dialog', { name: /Lancer un agent/ }), null, 'no launch dialog before the click')
  const button = v.getByRole('button', { name: "Lancer un agent sur l'issue #7" })
  button.focus()
  await act(async () => { fireEvent.click(button) })
  const dialog = within(document.body).getByRole('dialog', { name: "Lancer un agent sur l'issue #7" })
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  const cancel = within(dialog).getByRole('button', { name: 'Annuler' })
  assert.equal(document.activeElement, cancel, 'initial focus on Annuler')

  // Focus trap: Tab from the last control goes back to the first, Shift+Tab from the first to the last
  const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button, input'))
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  last.focus()
  fireEvent.keyDown(last, { key: 'Tab' })
  assert.equal(document.activeElement, first)
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  assert.equal(document.activeElement, last)

  await act(async () => { fireEvent.keyDown(dialog, { key: 'Escape' }) })
  assert.equal(within(document.body).queryByTestId('launch-dialog'), null)
  assert.ok(v.getByTestId('issue-links'), 'Escape closed the launch dialog only, not the inspector')
  assert.equal(document.activeElement, v.getByRole('button', { name: "Lancer un agent sur l'issue #7" }), 'focus back on the button')
})

test('the dialog does not reopen by itself when the launch surface goes away and comes back (WCAG 3.2)', async () => {
  const on = { maxConcurrent: 1, launches: new Map<string, LaunchView>() }
  const role = `launch-role-${++roleSeq}`
  const el = (launch: typeof on | null) => <AgentDetailCard agent={agent(role)} toolErrors={0} onClose={() => {}} freshnessClock={clock} relayOrigin="" launch={launch} />
  const v = render(el(on))
  await flush()
  await act(async () => { fireEvent.click(v.getByRole('button', { name: "Lancer un agent sur l'issue #7" })) })
  assert.ok(within(document.body).getByTestId('launch-dialog'), 'open')
  v.rerender(el(null)) // the relay link dropped: the hook sets launch to null
  await flush()
  assert.equal(within(document.body).queryByTestId('launch-dialog'), null, 'unmounted during the outage')
  v.rerender(el({ maxConcurrent: 1, launches: new Map() })) // reconnected
  await flush()
  assert.equal(within(document.body).queryByTestId('launch-dialog'), null, 'not reopened without a click')
  assert.ok(v.getByRole('button', { name: "Lancer un agent sur l'issue #7" }), 'the button is back')
})

test('the dialog shows repository, issue, role, escaped title, command and caps as text', async () => {
  const { v, role } = await showCard({ maxConcurrent: 2, launches: new Map() })
  await act(async () => { fireEvent.click(v.getByRole('button', { name: "Lancer un agent sur l'issue #7" })) })
  const dialog = within(document.body).getByTestId('launch-dialog')
  const text = dialog.textContent ?? ''
  for (const needle of ['o/r', '#7', `agent:${role}`, 'Titre <b>7</b>', '2 lancement(s) simultané(s) au plus', '60 min']) {
    assert.ok(text.includes(needle), `shows ${needle}`)
  }
  assert.equal(dialog.querySelector('b'), null, 'the title is text, never markup')
  assert.match(within(dialog).getByTestId('launch-command').textContent ?? '', new RegExp(`^claude -p --worktree issue-7-${role} `))
  assert.deepEqual(await violations(document.body), [])
})

test('the token field is a password, never persisted (no storage, no URL), and cleared on close', async () => {
  const before = window.location.href
  const { v, role } = await showCard({ maxConcurrent: 1, launches: new Map() })
  const button = v.getByRole('button', { name: "Lancer un agent sur l'issue #7" })
  await act(async () => { fireEvent.click(button) })
  const field = within(document.body).getByLabelText('Jeton du relais') as HTMLInputElement
  assert.equal(field.type, 'password')
  assert.equal(field.getAttribute('autocomplete'), 'off')
  fireEvent.change(field, { target: { value: TOKEN } })
  await act(async () => { fireEvent.click(within(document.body).getByRole('button', { name: 'Lancer' })) })
  await flush()
  const post = calls.find(c => c.url === '/launch')
  assert.ok(post, 'POST /launch on the same origin')
  assert.equal(post!.init?.method, 'POST')
  assert.equal(post!.init?.headers?.Authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(JSON.parse(post!.init!.body!), { repo: 'o/r', issue: 7, role })
  for (const c of calls) assert.ok(!c.url.includes(TOKEN), 'never in a URL')
  assert.equal(window.location.href, before)
  for (let i = 0; i < window.localStorage.length; i++) assert.ok(!(window.localStorage.getItem(window.localStorage.key(i)!) ?? '').includes(TOKEN))
  for (let i = 0; i < window.sessionStorage.length; i++) assert.ok(!(window.sessionStorage.getItem(window.sessionStorage.key(i)!) ?? '').includes(TOKEN))

  await act(async () => { fireEvent.click(within(document.body).getByRole('button', { name: 'Annuler' })) })
  await act(async () => { fireEvent.click(v.getByRole('button', { name: "Lancer un agent sur l'issue #7" })) })
  assert.equal((within(document.body).getByLabelText('Jeton du relais') as HTMLInputElement).value, '', 'a reopened dialog starts empty')
})

test('states and refusals are announced in a role=status region, in words', async () => {
  launchAnswer = { ok: false, status: 401, body: { error: 'Titre hostile <script>' } }
  const fetchCalls: string[] = []
  const v = render(
    <LaunchDialog repo="o/r" issue={7} role="r" title="t" maxConcurrent={1} launches={new Map()} origin="" onClose={() => {}}
      fetchFn={async (url) => { fetchCalls.push(url); return { ok: false, status: 401, json: async () => ({ error: 'Titre hostile' }) } }} />,
  )
  await flush()
  const dialog = within(document.body).getByRole('dialog')
  const status = within(dialog).getByRole('status')
  // Without a token, nothing is sent and the region says why
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Lancer' })) })
  assert.equal(fetchCalls.length, 0)
  assert.match(status.textContent ?? '', /jeton/i)
  fireEvent.change(within(dialog).getByLabelText('Jeton du relais'), { target: { value: TOKEN } })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Lancer' })) })
  await flush()
  assert.match(status.textContent ?? '', /Jeton refusé/)
  assert.ok(!(status.textContent ?? '').includes('hostile'), 'the answer body is never shown')

  // A running launch: its state in words, and a Stop button instead of Lancer
  const running = new Map([['0123456789abcdef', view({ state: 'started', pid: 42 })]])
  v.rerender(<LaunchDialog repo="o/r" issue={7} role="r" title="t" maxConcurrent={1} launches={running} origin="" onClose={() => {}} />)
  assert.match(within(dialog).getByRole('status').textContent ?? '', /Démarré \(pid 42\)/)
  assert.equal(within(dialog).queryByRole('button', { name: 'Lancer' }), null)
  assert.ok(within(dialog).getByRole('button', { name: 'Arrêter' }))

  // Ended: the worktree path is shown
  const ended = new Map([['0123456789abcdef', view({ state: 'exited', pid: 42, exitCode: 0, endedAt: 9, worktreePath: '/w/.claude/worktrees/issue-7-r' })]])
  v.rerender(<LaunchDialog repo="o/r" issue={7} role="r" title="t" maxConcurrent={1} launches={ended} origin="" onClose={() => {}} />)
  const text = within(dialog).getByRole('status').textContent ?? ''
  assert.match(text, /Terminé \(code 0\)/)
  assert.ok(text.includes('/w/.claude/worktrees/issue-7-r'))
  assert.ok(within(dialog).getByRole('button', { name: 'Lancer' }), 'an ended launch can be launched again')
  assert.deepEqual(await violations(document.body), [])
})

test('Arrêter sends POST /launch/<id>/stop with the token', async () => {
  const sent: Array<{ url: string; auth?: string }> = []
  const running = new Map([['0123456789abcdef', view({ state: 'started', pid: 42 })]])
  render(
    <LaunchDialog repo="o/r" issue={7} role="r" title="t" maxConcurrent={1} launches={running} origin="" onClose={() => {}}
      fetchFn={async (url, init) => { sent.push({ url, auth: init.headers.Authorization }); return { ok: true, status: 202, json: async () => view({ state: 'started', pid: 42, stopRequestedAt: 3 }) } }} />,
  )
  await flush()
  const dialog = within(document.body).getByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('Jeton du relais'), { target: { value: TOKEN } })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Arrêter' })) })
  await flush()
  assert.deepEqual(sent, [{ url: '/launch/0123456789abcdef/stop', auth: `Bearer ${TOKEN}` }])
  assert.match(within(dialog).getByRole('status').textContent ?? '', /Arrêt demandé/)
})

test('in English the same controls carry English names', async () => {
  act(() => { setLocaleChoice('en') })
  const { v } = await showCard({ maxConcurrent: 1, launches: new Map() })
  const button = v.getByRole('button', { name: 'Launch an agent on issue #7' })
  await act(async () => { fireEvent.click(button) })
  const dialog = within(document.body).getByRole('dialog', { name: 'Launch an agent on issue #7' })
  assert.equal(dialog.getAttribute('lang'), 'en')
  assert.equal(document.activeElement, within(dialog).getByRole('button', { name: 'Cancel' }))
  assert.equal((within(dialog).getByLabelText('Relay token') as HTMLInputElement).type, 'password')
  assert.deepEqual(await violations(document.body), [])
})
