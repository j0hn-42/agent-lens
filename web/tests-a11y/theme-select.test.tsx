// Theme selector: accessible name, announced state, keyboard operation, persistence, and COLORS following the theme.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { ThemeSelect } from '@/components/agent-visualizer/theme-select'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { COLORS } from '@/lib/colors'
import { getTheme, setTheme, THEME_STORAGE_KEY } from '@/lib/theme'
import { DEFAULT_THEME, TOKENS } from '@/lib/theme-tokens'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  window.localStorage.clear()
  act(() => { setTheme(DEFAULT_THEME) })
  window.localStorage.clear()
})

test('the selector is a named combobox listing the nine dark themes, Catppuccin Macchiato selected by default', () => {
  const { getByRole } = render(<ThemeSelect />)
  const select = getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement
  assert.deepEqual(Array.from(select.options).map(o => o.value), ['catppuccin-macchiato', 'catppuccin-mocha', 'catppuccin-frappe', 'midnight', 'graphite', 'neon', 'ember', 'anthropic', 'contrast'])
  assert.deepEqual(Array.from(select.options).map(o => o.textContent), ['Catppuccin Macchiato', 'Catppuccin Mocha', 'Catppuccin Frappe', 'Midnight', 'Graphite', 'Neon', 'Ember', 'Anthropic', 'High contrast'])
  assert.equal(select.value, 'catppuccin-macchiato')
  assert.ok(select.title)
})

test('choosing a theme switches the document, persists the choice and repaints COLORS', () => {
  const { getByRole } = render(<ThemeSelect />)
  const select = getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement

  for (const id of ['graphite', 'midnight', 'ember', 'anthropic', 'contrast', 'catppuccin-mocha', 'catppuccin-frappe'] as const) {
    fireEvent.change(select, { target: { value: id } })
    assert.equal(select.value, id, 'the announced value follows the choice')
    assert.equal(document.documentElement.dataset.theme, id)
    assert.equal(document.documentElement.classList.contains('dark'), true, `${id}: every theme is dark`)
    assert.equal(document.documentElement.style.colorScheme, 'dark')
    assert.equal(window.localStorage.getItem(THEME_STORAGE_KEY), id)
    assert.equal(COLORS.void, TOKENS[id].void)
  }

  fireEvent.change(select, { target: { value: 'neon' } })
  assert.equal(document.documentElement.dataset.theme, 'neon')
  assert.equal(document.documentElement.classList.contains('dark'), true)
  assert.equal(window.localStorage.getItem(THEME_STORAGE_KEY), 'neon')
  assert.equal(COLORS.void, '#050510')
  assert.equal(getTheme(), 'neon')
})

test('an unknown value is ignored', () => {
  const { getByRole } = render(<ThemeSelect />)
  const select = getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'ember' } })
  setTheme('purple' as never)
  setTheme('paper' as never)
  assert.equal(getTheme(), 'ember', 'the removed paper theme is not selectable any more')
  assert.equal(window.localStorage.getItem(THEME_STORAGE_KEY), 'ember')
})

test('a theme set from elsewhere updates the selector (shared store)', () => {
  const { getByRole } = render(<ThemeSelect />)
  act(() => { setTheme('neon') })
  assert.equal((getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement).value, 'neon')
})

test('the top bar repaints with the new theme colours', () => {
  const noop = () => {}
  const props: TopBarProps = {
    sessions: [{ id: 's1', label: 'one', status: 'active', startTime: 1, lastActivityTime: 2 }],
    selectedSessionId: ALL_SESSIONS_ID, sessionsWithActivity: new Set(),
    showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
    activeAgentCount: 1, doneAgentCount: 0, totalTokens: 10, totalCost: 0,
    showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, showStats: false, isMuted: false,
    onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, onToggleMute: noop, onOpenShortcuts: noop,
  }
  const { getByRole, container } = render(<TopBar {...props} />)
  const select = getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement
  const toolbar = container.querySelector('[role="toolbar"]')!
  assert.ok(toolbar.contains(select), 'the selector sits in the view controls toolbar')
  const border = () => (toolbar.querySelector('#topbar-toggle-timeline') as HTMLElement).style.border
  const before = border()
  fireEvent.change(select, { target: { value: 'contrast' } })
  assert.notEqual(border(), before, 'a memoized top bar button repaints')
})
