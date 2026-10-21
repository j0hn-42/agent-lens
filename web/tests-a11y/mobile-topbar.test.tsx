// #476 (mobile view), one-line bar: below 768 px the top bar is the Sessions button, the connection state, the attention
// counter and More; More shows the panel buttons, the filters and the tools. Every control of the bar is 44x44 px there
// (the classes are checked here, the sizes in tests-a11y/e2e/topbar-layout.e2e.ts and mobile-view.e2e.ts).
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React, { useRef, useState } from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import axe from 'axe-core'
import { TopBar, TOPBAR_MORE_ID, PANEL_BUTTON_IDS, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { useFocusReturn } from '@/hooks/use-focus-return'
import { TOUCH_TARGET } from '@/lib/mobile-view'
import { setMobileView } from './mobile-media'

afterEach(() => {
  setMobileView(false)
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}
const base: TopBarProps = {
  sessions: [{ id: 's1', label: 'one', status: 'active', startTime: 1, lastActivityTime: 2 }],
  selectedSessionId: 's1', sessionsWithActivity: new Set(),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 1, doneAgentCount: 0, totalTokens: 33000, totalCost: 0.312,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, showStats: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, onToggleMute: noop, onOpenShortcuts: noop,
  onOpenSettings: noop, onToggleFullscreen: noop, onChangeShowMode: noop,
  attention: { waiting: 1, errors: 0 }, onJumpToAttention: noop,
}

const buttonNames = (root: HTMLElement) => Array.from(root.querySelectorAll('button')).map(b => b.getAttribute('aria-label') || b.textContent?.trim())

test('1024 px and wider: the panel buttons are in the bar, More holds the filters and the tools', () => {
  const view = render(<TopBar {...base} />)
  assert.ok(view.container.querySelector(`#${TOPBAR_MORE_ID}`), 'More is drawn at every width')
  assert.ok(view.getByRole('button', { name: 'Files & repeats' }))
  assert.ok(view.getByRole('toolbar', { name: 'View controls' }))
})

test('under 768 px, folded: Sessions, the attention counter and More only; no hidden Tab stop', async () => {
  setMobileView(true)
  const view = render(<TopBar {...base} />)
  const header = view.container.querySelector('header')!
  const names = buttonNames(header)
  assert.equal(names.length, 3, `buttons of the folded bar: ${names.join(' | ')}`)
  assert.match(String(names[0]), /^Sessions/)
  assert.match(String(names[1]), /needs you|waiting/)
  const more = view.getByRole('button', { name: /^More/ })
  assert.equal(more.id, TOPBAR_MORE_ID)
  assert.equal(more.getAttribute('aria-expanded'), 'false')
  assert.equal(view.queryByRole('toolbar'), null, 'the panel buttons are not rendered while folded')
  // The connection state stays drawn (text, never colour alone); the totals stay for screen readers
  assert.match(header.textContent ?? '', /Live|Connected|connected/i)
  assert.match(header.textContent ?? '', /tokens in context/)
  const results = await axe.run(view.container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
  assert.deepEqual(results.violations.map(v => v.id), [])
})

test('under 768 px: More shows the panel buttons, the filters and the tools', () => {
  setMobileView(true)
  const view = render(<TopBar {...base} />)
  const more = view.getByRole('button', { name: /^More/ })
  fireEvent.click(more)
  assert.equal(more.getAttribute('aria-expanded'), 'true')
  // More controls its overlay: every id names a rendered element
  const regions = more.getAttribute('aria-controls')!.split(' ').map(id => document.getElementById(id))
  assert.ok(regions.length > 0 && regions.every(Boolean), 'aria-controls names rendered elements')
  for (const name of ['Files & repeats', 'Timeline', 'Hide inactive: agents', 'Settings', 'Keyboard shortcuts']) {
    assert.ok(view.getByRole('button', { name }), `${name} is shown`)
  }
  assert.ok(regions.some(r => r!.contains(view.getByRole('toolbar', { name: 'View controls' }))), 'the panel buttons are what More controls')
  assert.ok(regions.some(r => r!.contains(view.getByRole('button', { name: 'Hide inactive: agents' }))), 'the filters are what More controls')
})

test('under 768 px: a panel button folds More again and leaves the focus on More (the drawer takes it next)', () => {
  setMobileView(true)
  const toggled: string[] = []
  const view = render(<TopBar {...base} onTogglePanel={p => toggled.push(p)} onToggleTimeline={() => toggled.push('timeline')} />)
  const more = view.getByRole('button', { name: /^More/ })
  for (const [name, id] of [['Files & repeats', 'files'], ['Timeline', 'timeline']] as const) {
    fireEvent.click(more)
    const button = view.getByRole('button', { name })
    button.focus()
    fireEvent.click(button)
    assert.equal(toggled.at(-1), id)
    assert.equal(more.getAttribute('aria-expanded'), 'false', `${name} folds More`)
    assert.equal(document.activeElement, more, `the focus is not dropped on <body> after ${name}`)
  }
})

test('under 768 px: a filter keeps More open (several can be changed in a row)', () => {
  setMobileView(true)
  const view = render(<TopBar {...base} />)
  const more = view.getByRole('button', { name: /^More/ })
  fireEvent.click(more)
  fireEvent.click(view.getByRole('button', { name: 'Hide inactive: agents' }))
  assert.equal(more.getAttribute('aria-expanded'), 'true')
})

test('every control of the top bar takes the 44 px target classes (folded and expanded)', () => {
  setMobileView(true)
  const view = render(<TopBar {...base} connectionStatus="disconnected" connectionDetail="attempt 2" onRetryConnection={noop} />)
  const check = (when: string) => {
    for (const b of Array.from(view.container.querySelectorAll('header button'))) {
      for (const cls of TOUCH_TARGET.split(' ')) {
        assert.ok(b.classList.contains(cls), `${when}: "${b.getAttribute('aria-label') || b.textContent?.trim()}" lacks ${cls}`)
      }
    }
  }
  check('folded')
  fireEvent.click(view.getByRole('button', { name: /^More/ }))
  check('expanded')
})

test('crossing 768 px with the focus on a panel button keeps it (More opens to keep the button)', () => {
  const view = render(<TopBar {...base} />)
  const files = view.getByRole('button', { name: 'Files & repeats' })
  files.focus()
  setMobileView(true)
  assert.equal(document.activeElement?.id, PANEL_BUTTON_IDS.files)
  assert.equal(view.getByRole('button', { name: /^More/ }).getAttribute('aria-expanded'), 'true')
})

// The panels give the focus back to their top bar button; folded under 768 px it is not rendered: More takes it
function Panel({ fallbacks }: { fallbacks: string[] }) {
  const [open, setOpen] = useState(true)
  const ref = useRef<HTMLDivElement>(null)
  useFocusReturn(open, ref, fallbacks)
  return <div ref={ref}>{open && <button type="button" onClick={() => setOpen(false)}>Close panel</button>}</div>
}

test('useFocusReturn: the first rendered fallback takes the focus when the trigger is gone', async () => {
  const more = document.createElement('button')
  more.id = TOPBAR_MORE_ID
  document.body.appendChild(more)
  const view = render(<Panel fallbacks={[PANEL_BUTTON_IDS.files, TOPBAR_MORE_ID]} />)
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  fireEvent.click(view.getByRole('button', { name: 'Close panel' }))
  assert.equal(document.activeElement, more)
})
