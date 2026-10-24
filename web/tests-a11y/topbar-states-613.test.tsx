// #613 (lot): two states of the top bar drawn without being readable otherwise.
// - The mute button's name flips (Mute / Unmute), so it carries no aria-pressed and draws no bar for "sound on": a visible state
//   that a screen reader did not get, and a bar that read "muted" under the name "Mute".
// - Under 1440 px the attention counter is a number: waiting and error differ by the border colour alone (WCAG 1.4.1), so the
//   shape of the mark (! for waiting, a cross for an error) tells them apart.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { setLocaleChoice } from '@/lib/locale'
import { TOPBAR_ATTENTION_SHORT_QUERY } from '@/lib/mobile-view'
import { setMobileView } from './mobile-media'
import { openMore } from './topbar-more'

const realMatchMedia = window.matchMedia
/** The shared helper does not know the 1440 px query of the attention counter: answer it here */
function attentionShort(on: boolean) {
  window.matchMedia = (q: string) => (q === TOPBAR_ATTENTION_SHORT_QUERY ? ({ matches: on, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } as unknown as MediaQueryList) : realMatchMedia(q))
}

afterEach(() => {
  window.matchMedia = realMatchMedia
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
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, showStats: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, onToggleMute: noop, onOpenShortcuts: noop,
  onChangeShowMode: noop, onOpenSettings: noop, onToggleFullscreen: noop, onOpenPalette: noop,
  notifyState: 'off', onToggleNotify: noop, attention: { waiting: 0, errors: 0 }, onJumpToAttention: noop,
}

for (const isMuted of [false, true]) {
  test(`mute button (${isMuted ? 'muted' : 'sound on'}): no aria-pressed and no bar drawn, the name says the action`, () => {
    const view = render(<TopBar {...base} isMuted={isMuted} />)
    openMore()
    const b = view.container.querySelector<HTMLElement>('#topbar-mute')!
    assert.equal(b.hasAttribute('aria-pressed'), false, 'a name that flips must not come with aria-pressed')
    assert.equal(b.style.boxShadow, '', 'no bar: it would read "muted" under the name "Mute"')
    assert.doesNotMatch(b.className, /font-bold/)
  })
}

test('attention counter under 1440 px: the mark differs by shape, not only by colour', () => {
  attentionShort(true)
  const mark = (attention: TopBarProps['attention']) => {
    const view = render(<TopBar {...base} attention={attention} />)
    const text = view.getByTestId('attention-counter').textContent
    view.unmount()
    return text
  }
  assert.equal(mark({ waiting: 3, errors: 0 }), '! 3')
  assert.equal(mark({ waiting: 0, errors: 2 }), '✕ 2')
  assert.equal(mark({ waiting: 1, errors: 2 }), '!✕ 3')
})

test('attention counter at 1440 px and more keeps its words', () => {
  attentionShort(false)
  const view = render(<TopBar {...base} attention={{ waiting: 0, errors: 2 }} />)
  assert.match(view.getByTestId('attention-counter').textContent ?? '', /2 agents in error/)
})
