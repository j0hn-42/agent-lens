// #373: the controls the top bar owns (its own literals, not the glossary names) follow the interface language.
// The rest of the bar (panel names, counts, connection state, finished-sessions toggle, attention counter) is still
// English: it stays under the page language (en) and is listed in docs/reading-the-ui.md. A translated control declares
// its own lang.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { setLocaleChoice } from '@/lib/locale'
import { LOCALES, MESSAGES, type Locale, type MessageKey } from '@/lib/messages'

afterEach(() => {
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
