// #373, #500, #501: every control of the top bar follows the interface language (buttons, tooltips, accessible names,
// connection state, attention counter, scope, finished sessions, More, the totals read by screen readers). Each declares
// its lang. What the relay wrote in English (an unknown connection detail, a runtime problem) keeps lang=en.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { setLocaleChoice } from '@/lib/locale'
import { setMobileView } from './mobile-media'
import { fireEvent } from '@testing-library/react'
import { LOCALES, MESSAGES, type Locale, type MessageKey } from '@/lib/messages'
import { attentionAriaLabel, attentionCounterText, attentionTooltip } from '@/lib/top-bar-text'
import { reconnectDetail } from '@/lib/reconnect'
import { parseRelayScopeState } from '@/lib/relay-scope'

afterEach(() => {
  setMobileView(false)
  cleanup()
  document.body.replaceChildren()
  setLocaleChoice('auto')
  window.localStorage.clear()
})

const noop = () => {}
const base: TopBarProps = {
  sessions: [{ id: 's1', label: 'one', status: 'active', startTime: 1, lastActivityTime: 2 }],
  selectedSessionId: ALL_SESSIONS_ID, sessionsWithActivity: new Set(),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 1, doneAgentCount: 0, totalTokens: 10, totalCost: 0,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, showStats: false, onToggleMute: noop, onOpenShortcuts: noop,
  onToggleHideInactive: noop, onOpenSettings: noop, onToggleFullscreen: noop, onOpenPalette: noop, notifyState: 'off', onToggleNotify: noop,
}

const T = (locale: Locale, key: MessageKey) => MESSAGES[locale][key]
const titled = (container: HTMLElement, title: string) =>
  Array.from(container.querySelectorAll('[title]')).find(e => (e.getAttribute('title') ?? '').startsWith(title))

for (const locale of LOCALES) {
  test(`the top bar controls it owns speak ${locale}, each declaring lang=${locale}`, () => {
    setLocaleChoice(locale)
    const view = render(<TopBar {...base} />)
    const names: MessageKey[] = ['topbar.hideInactive', 'topbar.notify', 'topbar.mute', 'topbar.fullscreen', 'topbar.commands', 'settings.title', 'topbar.shortcuts']
    for (const key of names) {
      const button = view.getByRole('button', { name: T(locale, key) })
      assert.equal(button.closest('[lang]')?.getAttribute('lang'), locale, `${key} declares lang=${locale}`)
    }
    // Same wording as Settings for the same setting
    assert.equal(T(locale, 'topbar.hideInactive'), T(locale, 'settings.hideInactive'))
    for (const key of ['topbar.hideInactive.title', 'topbar.notify.title', 'topbar.mute.title', 'topbar.fullscreen.title', 'topbar.commands.title', 'topbar.settings.title', 'topbar.shortcuts.title'] as MessageKey[]) {
      assert.ok(titled(view.container, T(locale, key)), `${key} is a tooltip`)
    }
  })
}

test('the denied and the muted states are translated as well', () => {
  setLocaleChoice('fr')
  const view = render(<TopBar {...base} notifyState="denied" isMuted />)
  assert.ok(view.getByRole('button', { name: MESSAGES.fr['topbar.notify.blocked'] }))
  assert.ok(view.getByRole('button', { name: MESSAGES.fr['topbar.unmute'] }))
  assert.ok(titled(view.container, MESSAGES.fr['topbar.notify.blocked.title']))
  assert.ok(titled(view.container, MESSAGES.fr['topbar.unmute.title']))
})

// Under 768 px More names the filters that are on; the name uses the same wording as the filter button it hides, and the
// passage declares its own language (a screen reader must not hear one control under two names)
for (const locale of LOCALES) {
  test(`under 768 px, More names "Hide inactive" as the button does (${locale})`, () => {
    setLocaleChoice(locale)
    setMobileView(true)
    const view = render(<TopBar {...base} hideInactive />)
    const label = T(locale, 'topbar.hideInactive')
    const more = view.getByRole('button', { name: new RegExp(`^${T(locale, 'topbar.more')}`) })
    const name = more.getAttribute('aria-labelledby')
      ? more.getAttribute('aria-labelledby')!.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')
      : more.getAttribute('aria-label') ?? ''
    assert.ok(name.startsWith(T(locale, 'topbar.more.nameBefore.one').replace('{n}', '1')), name)
    assert.ok(name.includes(`(${label})`), `More names the filter "${label}": ${name}`)
    if (locale !== 'en') {
      const passage = Array.from(document.querySelectorAll('[lang]')).find(e => e.textContent === label && e.closest('header') && e.getAttribute('lang') === locale && more.getAttribute('aria-labelledby')?.split(' ').some(id => document.getElementById(id)?.contains(e)))
      assert.ok(passage, `the filter name inside More's name declares lang=${locale}`)
    }
    fireEvent.click(more)
    assert.ok(view.getByRole('button', { name: label }), 'the button that opens has the very same name')
  })
}

// ---- #500, #501: the rest of the bar

const langOf = (el: Element) => el.closest('[lang]')?.getAttribute('lang')
const scopeState = parseRelayScopeState({
  relayVersion: '1', workspace: '/home/me/code/alpha', runtimes: ['claude'], hooksConfigured: true, disable1MContext: false,
  sessionCount: 1, allWorkspaces: false, skippedSessions: { watchLimit: 0, sizeLimit: 0, fileLimit: 2 },
  discovery: { projectDirsCapped: false, maxProjectDirs: 200, maxFilesPerDir: 500 },
})!

for (const locale of LOCALES) {
  test(`the Sessions button, its count, the unobserved sessions and the activity cue speak ${locale}`, () => {
    setLocaleChoice(locale)
    const view = render(<TopBar {...base} sessionsWithActivity={new Set(['other'])} />)
    const button = view.getByRole('button', { name: new RegExp(`^${T(locale, 'topbar.sessions.button').split('{label}')[0]}`) })
    assert.equal(langOf(button), locale)
    assert.equal(button.getAttribute('title'), T(locale, 'topbar.sessions.title'))
    assert.ok(button.textContent?.includes(T(locale, 'sessions.allSessions')), button.textContent ?? '')
    assert.ok(button.textContent?.includes(T(locale, 'topbar.sessions.newActivity')))
    assert.ok(Array.from(view.container.querySelectorAll('[title]')).some(e => (e.textContent ?? '').includes(T(locale, 'topbar.sessions.unobserved.one').replace('{n}', '1'))), 'one listed session nobody has heard from')
  })

  test(`the scope selector speaks ${locale}: group, select, options, summary, ceilings, and keeps relay text in its own language`, () => {
    setLocaleChoice(locale)
    const scope = { state: { ...scopeState, runtimeProblems: [{ runtime: 'opencode', message: 'OpenCode: database not found.' }] } as never, sessions: [], projectId: null, pending: false, error: 'The relay refused the change of scope (500)', onChoose: noop }
    const view = render(<TopBar {...base} scope={scope} />)
    const group = view.getByRole('group', { name: T(locale, 'scope.group') })
    assert.equal(langOf(group), locale)
    const select = view.getByRole('combobox', { name: T(locale, 'scope.select') }) as HTMLSelectElement
    assert.equal(select.getAttribute('title'), T(locale, 'scope.title'))
    assert.deepEqual(Array.from(select.options).map(o => o.textContent), [T(locale, 'scope.option.workspace'), T(locale, 'scope.option.all')])
    assert.ok(group.textContent?.includes(T(locale, 'scope.summary').replace('{name}', 'alpha')))
    assert.ok(group.textContent?.includes(T(locale, 'scope.notice.fileLimit.other').replace('{n}', '2').replace('{max}', '500')))
    for (const text of ['OpenCode: database not found.', 'The relay refused the change of scope (500)']) {
      const span = Array.from(group.querySelectorAll('span')).find(e => e.textContent?.trim() === text)
      assert.equal(span?.getAttribute('lang'), 'en', `${text} keeps lang=en`)
    }
  })

  test(`the connection state and its buttons speak ${locale}`, () => {
    setLocaleChoice(locale)
    const live = render(<TopBar {...base} connectionStatus="watching" />)
    assert.ok(live.getByText(T(locale, 'topbar.connection.watching')))
    assert.equal(langOf(live.getByText(T(locale, 'topbar.connection.watching'))), locale)
    cleanup()
    const off = render(<TopBar {...base} connectionStatus="disconnected" connectionDetail={reconnectDetail(2, 10_000)} onRetryConnection={noop} />)
    assert.ok(off.getByText(T(locale, 'topbar.connection.offline')))
    assert.equal(off.getByTestId('connection-detail').textContent, T(locale, 'topbar.connection.reconnecting').replace('{attempt}', '2').replace('{seconds}', '10'))
    assert.equal(langOf(off.getByTestId('connection-detail')), locale)
    assert.equal(off.getByTestId('retry-connection').textContent, T(locale, 'topbar.connection.retry'))
    cleanup()
    const demo = render(<TopBar {...base} isDemo onExitDemo={noop} />)
    assert.ok(demo.getByText(T(locale, 'topbar.connection.demo')))
    assert.equal(demo.getByTestId('exit-demo').textContent, T(locale, 'topbar.connection.exitDemo'))
  })

  test(`an unknown connection detail never lands in the ${locale} tooltip unless it is in ${locale} (WCAG 3.1.2)`, () => {
    setLocaleChoice(locale)
    const view = render(<TopBar {...base} connectionStatus="disconnected" connectionDetail="proxy refused" onRetryConnection={noop} />)
    // The detail stays visible beside the badge, declaring lang=en
    assert.equal(view.getByTestId('connection-detail').textContent, 'proxy refused')
    assert.equal(langOf(view.getByTestId('connection-detail')), 'en')
    // A title attribute cannot declare its language: it inherits the page's
    const badge = Array.from(view.container.querySelectorAll('[title]')).find(e => (e.getAttribute('title') ?? '').startsWith(locale === 'fr' ? 'Relais hors ligne' : 'Relay offline'))!
    assert.ok(badge, 'the badge has a tooltip')
    if (locale === 'fr') assert.equal(badge.getAttribute('title'), T('fr', 'topbar.connection.offline.help'))
    else assert.equal(badge.getAttribute('title'), T('en', 'topbar.connection.offline.detail').replace('{detail}', 'proxy refused'))
  })

  test(`the attention counter is spelled out in ${locale}, with an aria-label and a title that agree`, () => {
    setLocaleChoice(locale)
    const view = render(<TopBar {...base} attention={{ waiting: 1, errors: 2 }} onJumpToAttention={noop} />)
    const counter = view.getByTestId('attention-counter')
    assert.equal(langOf(counter), locale)
    assert.equal(counter.textContent?.replace(/^! /, ''), attentionCounterText(locale, 1, 2))
    assert.equal(counter.getAttribute('aria-label'), attentionAriaLabel(locale, 1, 2))
    assert.equal(counter.getAttribute('title'), attentionTooltip(locale, 1, 2, false))
    // The accessible name starts with the visible text (WCAG 2.5.3)
    assert.ok((counter.getAttribute('aria-label') ?? '').startsWith(attentionCounterText(locale, 1, 2)))
  })

  test(`the finished sessions button and the folded filter name speak ${locale}`, () => {
    setLocaleChoice(locale)
    const view = render(<TopBar {...base} finishedSessionCount={3} onToggleShowFinished={noop} />)
    const button = view.getByRole('button', { name: T(locale, 'topbar.finished.label').replace('{n}', '3') })
    assert.equal(langOf(button), locale)
    assert.equal(button.getAttribute('title'), T(locale, 'topbar.finished.title'))
    cleanup()
    setMobileView(true)
    const folded = render(<TopBar {...base} finishedSessionCount={3} onToggleShowFinished={noop} />)
    const more = folded.getByRole('button', { name: new RegExp(`^${T(locale, 'topbar.more')}`) })
    assert.equal(more.textContent, T(locale, 'topbar.more.withFilters.one').replace('{n}', '1'))
    const name = more.getAttribute('aria-labelledby')!.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')
    assert.ok(name.includes(T(locale, 'topbar.finished.hidden').replace('{n}', '3')), name)
  })

  test(`the toolbar, the side panels group and the totals read by screen readers speak ${locale}`, () => {
    setLocaleChoice(locale)
    const view = render(<TopBar {...base} selectedSessionId="s1" unattributedCost={0.5} totalCost={1} />)
    assert.equal(langOf(view.getByRole('toolbar', { name: T(locale, 'topbar.toolbar') })), locale)
    assert.ok(view.getByRole('group', { name: T(locale, 'topbar.sidePanels') }))
    const spoken = view.getByTestId('topbar-spoken-totals')
    assert.equal(langOf(spoken), locale)
    assert.ok(spoken.textContent?.includes(T(locale, 'topbar.context.unattributed').replace('{cost}', '$0.500')), spoken.textContent ?? '')
    assert.ok(spoken.textContent?.includes(T(locale, 'topbar.counts.active.one').replace('{n}', '1')), spoken.textContent ?? '')
  })

  test(`the Context tooltip inside VS Code speaks ${locale}`, () => {
    setLocaleChoice(locale)
    const view = render(<TopBar {...base} isVSCode />)
    const context = view.container.querySelector('#topbar-toggle-context') as HTMLElement
    const tip = document.getElementById(context.getAttribute('aria-describedby') ?? '')
    assert.equal(tip?.textContent, T(locale, 'topbar.context.vscode'))
    assert.equal(tip?.getAttribute('lang'), locale)
  })
}
