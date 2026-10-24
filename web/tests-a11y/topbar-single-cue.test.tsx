// An active button of the top bar draws ONE stroke, never two: the 2 px bar under the button (inset box-shadow) is the
// active cue, so the text is not underlined as well (the owner saw the underline doubled under Files, Conversation...).
// The other non-colour cues stay: bold text and aria-pressed (WCAG 1.4.1). Sessions and More carry the bar too, so the
// stroke does not depend on how their text wraps. e2e/topbar-layout.e2e.ts measures the single stroke in a real browser.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { TopBar, PANEL_BUTTON_IDS, TOPBAR_MORE_ID, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { setLocaleChoice } from '@/lib/locale'
import { setMobileView, setViewportWidth } from './mobile-media'

afterEach(() => {
  setMobileView(false)
  setViewportWidth(1440)
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
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, showStats: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, onToggleMute: noop, onOpenShortcuts: noop,
  onChangeShowMode: noop, onOpenSettings: noop, onToggleFullscreen: noop, onOpenPalette: noop,
  notifyState: 'off', onToggleNotify: noop, attention: { waiting: 1, errors: 0 }, onJumpToAttention: noop,
}

const UNDERLINED = /(^|\s)(underline|decoration-\S+|underline-offset-\S+)(\s|$)/
const hasBar = (el: HTMLElement) => /inset\s+0px\s+-2px|inset 0 -2px|0px -2px 0px 0px inset/.test(el.getAttribute('style') ?? '') || /inset/.test(el.style.boxShadow)

/** Active: one bar, no text underline, still bold, still announced */
function assertSingleCue(el: HTMLElement, what: string, pressed: boolean) {
  assert.ok(hasBar(el), `${what}: the active cue is the 2 px bar (inset box-shadow)`)
  assert.doesNotMatch(el.className, UNDERLINED, `${what}: no text underline next to the bar (it doubled the stroke)`)
  assert.match(el.className, /(^|\s)font-bold(\s|$)/, `${what}: stays bold (a cue that is not colour)`)
  if (pressed) assert.equal(el.getAttribute('aria-pressed'), 'true', `${what}: aria-pressed`)
}

test('an active panel button has one bar and no underline, bold and aria-pressed kept', () => {
  const { container } = render(<TopBar {...base} showFileAttention showConversation={false} />)
  const files = container.querySelector<HTMLElement>(`#${PANEL_BUTTON_IDS.files}`)!
  assertSingleCue(files, 'Files', true)
  const { container: c2 } = render(<TopBar {...base} showConversation />)
  assertSingleCue(c2.querySelector<HTMLElement>(`#${PANEL_BUTTON_IDS.conversation}`)!, 'Conversation', true)
})

test('the active Sessions button carries the same single bar, not a text underline per wrapped line', () => {
  const { container } = render(<TopBar {...base} showSessions />)
  assertSingleCue(container.querySelector<HTMLElement>(`#${PANEL_BUTTON_IDS.sessions}`)!, 'Sessions', true)
})

test('an inactive button has neither the bar nor an underline', () => {
  const { container } = render(<TopBar {...base} />)
  for (const id of [PANEL_BUTTON_IDS.files, PANEL_BUTTON_IDS.conversation, PANEL_BUTTON_IDS.sessions]) {
    const el = container.querySelector<HTMLElement>(`#${id}`)!
    assert.doesNotMatch(el.className, UNDERLINED)
    assert.equal(hasBar(el), false)
  }
})

test('the open More button has one bar, no underline, bold and aria-expanded', () => {
  setViewportWidth(900)
  const { container } = render(<TopBar {...base} />)
  const more = container.querySelector<HTMLElement>(`#${TOPBAR_MORE_ID}`)!
  fireEvent.click(more)
  assert.equal(more.getAttribute('aria-expanded'), 'true')
  assertSingleCue(more, 'More', false)
})

test('no button of the bar has a text underline, whatever its state', () => {
  const { container } = render(<TopBar {...base} showSessions showFileAttention showConversation showStats showTimeline />)
  for (const b of container.querySelectorAll<HTMLElement>('header button')) {
    assert.doesNotMatch(b.className, UNDERLINED, `${b.getAttribute('aria-label') ?? b.textContent}`)
  }
})
