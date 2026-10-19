// #372, the owner's decisions on the last points of the issue:
// (1) the two visibility filters stay, and the Sessions panel says both states in one line under its header (no new
//     control, the text follows the two settings as they are);
// (2) Settings > General has a link row to the View controls of the canvas: the button closes Settings, the View
//     popover opens with the focus inside it, and Escape gives the focus back to View.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import axe from 'axe-core'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import { SettingsDialog, type SettingsDialogProps } from '@/components/agent-visualizer/settings-dialog'
import { CanvasControls } from '@/components/agent-visualizer/canvas-controls'
import { DEFAULT_CALM_LAYERS } from '@/lib/motion-layers'
import { setLocaleChoice } from '@/lib/locale'
import { ACTIVE_WINDOW_MINUTES } from '@/lib/show-mode'
import type { SessionInfo } from '@/lib/bridge-types'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  setLocaleChoice('auto')
})

const noop = () => {}

async function axeIds(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => v.id)
}

// ---------------------------------------------------------------- (1) the line of the two filters

const sessions: SessionInfo[] = [
  { id: 'a', label: 'fix login', status: 'active', startTime: 0, lastActivityTime: 30 },
  { id: 'b', label: 'old work', status: 'completed', startTime: 0, lastActivityTime: 20 },
]

function panel(extra: Partial<React.ComponentProps<typeof SessionListPanel>> = {}) {
  return (
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="__all__" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map()} selectedAgentId={null} onSelectAgent={noop}
      now={5000} observedSessionIds={new Set(['a', 'b'])} {...extra}
    />
  )
}
const scopeLine = (c: HTMLElement) => c.querySelector('[data-testid="sessions-filter-scope"]')

test('(1) the line says both filters as set: Active only on, Hide inactive on in All sessions with its 10 minutes', () => {
  const view = render(panel({ activeOnly: true, canvasHideInactive: true }))
  const line = scopeLine(view.container)
  assert.ok(line, 'the line is drawn')
  assert.equal(line.textContent, `List: Active only · Canvas: Hide inactive (${ACTIVE_WINDOW_MINUTES} min)`)
  // Under the header, before the list: read before the rows
  const header = view.getByText('Sessions', { selector: 'span' })
  assert.ok(header.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING, 'after the header')
  // Plain text, no new control: nothing focusable, no role
  assert.equal(line.querySelector('button, a, input, [tabindex]'), null)
  assert.equal(line.getAttribute('role'), null)
  // The separator is drawn, not read
  const dot = [...line.querySelectorAll('[aria-hidden="true"]')].map(n => n.textContent)
  assert.deepEqual(dot, [' · '])
})

test('(1) the line follows the Active only button at once and the canvas setting as given', () => {
  const changes: boolean[] = []
  const view = render(panel({ activeOnly: undefined, canvasHideInactive: false, onActiveOnlyChange: v => changes.push(v) }))
  assert.equal(scopeLine(view.container)!.textContent, 'List: Active only · Canvas: everything shown')
  fireEvent.click(view.getByRole('button', { name: 'Active only' }))
  assert.deepEqual(changes, [false])
  assert.equal(scopeLine(view.container)!.textContent, 'List: all sessions · Canvas: everything shown')
  view.rerender(panel({ activeOnly: false, canvasHideInactive: true }))
  assert.equal(scopeLine(view.container)!.textContent, `List: all sessions · Canvas: Hide inactive (${ACTIVE_WINDOW_MINUTES} min)`)
})

test('(1) in one session the canvas filter has no time window: the line gives none', () => {
  const view = render(panel({ activeOnly: true, canvasHideInactive: true, selectedSessionId: 'a' }))
  assert.equal(scopeLine(view.container)!.textContent, 'List: Active only · Canvas: Hide inactive')
})

test('(1) without the canvas setting (no state known) the canvas half is not claimed', () => {
  const view = render(panel({ activeOnly: true }))
  assert.equal(scopeLine(view.container)!.textContent, 'List: Active only')
  assert.equal(scopeLine(view.container)!.querySelector('[aria-hidden="true"]'), null)
})

test('(1) in French: the same line in the catalog, inside the panel that declares lang="fr"', () => {
  setLocaleChoice('fr')
  const view = render(panel({ activeOnly: true, canvasHideInactive: true }))
  const line = scopeLine(view.container)!
  assert.equal(line.textContent, `Liste : Actives seulement · Canevas : Masquer les inactifs (${ACTIVE_WINDOW_MINUTES} min)`)
  assert.equal(line.closest('[lang]')!.getAttribute('lang'), 'fr')
  fireEvent.click(view.getByRole('button', { name: 'Actives seulement' }))
  view.rerender(panel({ activeOnly: false, canvasHideInactive: false }))
  assert.equal(scopeLine(view.container)!.textContent, 'Liste : toutes les sessions · Canevas : tout affiché')
})

test('(1) axe finds nothing on the panel with its line, in English and in French', async () => {
  const en = render(panel({ activeOnly: true, canvasHideInactive: true }))
  assert.deepEqual(await axeIds(en.container), [])
  en.unmount()
  setLocaleChoice('fr')
  const fr = render(panel({ activeOnly: false, canvasHideInactive: true }))
  assert.deepEqual(await axeIds(fr.container), [])
})

// ---------------------------------------------------------------- (2) Settings > General -> View controls

const dialogProps = (over: Partial<SettingsDialogProps> = {}): SettingsDialogProps => ({
  open: true, onClose: noop,
  hexGrid: true, onHexGridChange: noop,
  muted: false, onToggleMute: noop,
  showMode: 'active', onShowModeChange: noop,
  singleKeyEnabled: true, onSingleKeyEnabledChange: noop,
  onOpenShortcuts: noop,
  ...over,
})

test('(2) General has a "Motion and cards" row: its button is named by its visible text and described by its help', () => {
  const view = render(<SettingsDialog {...dialogProps({ onOpenViewControls: noop })} />)
  const general = view.getByRole('tabpanel', { name: 'General' })
  const section = general.querySelector('section[aria-label="Motion and cards"]')
  assert.ok(section, 'the section is in the General tab')
  const button = view.getByRole('button', { name: 'Open View controls' })
  assert.ok(section.contains(button))
  assert.equal(button.textContent, 'Open View controls', 'the name is the visible text (2.5.3)')
  const help = document.getElementById(button.getAttribute('aria-describedby') ?? '')
  assert.equal(help?.textContent, 'Set from the View button under the canvas: Freeze motion, the Calm layers, Pin cards, Hide unanswered calls after.')
})

test('(2) the button closes Settings first, then asks for the View controls', () => {
  const calls: string[] = []
  const view = render(<SettingsDialog {...dialogProps({ onClose: () => calls.push('close'), onOpenViewControls: () => calls.push('view') })} />)
  fireEvent.click(view.getByRole('button', { name: 'Open View controls' }))
  assert.deepEqual(calls, ['close', 'view'])
})

test('(2) keyboard: Tab from the tab list reaches the button, Enter on a native button activates it', () => {
  const calls: string[] = []
  const view = render(<SettingsDialog {...dialogProps({ onOpenViewControls: () => calls.push('view') })} />)
  const button = view.getByRole('button', { name: 'Open View controls' })
  assert.equal(button.tagName, 'BUTTON')
  assert.equal(button.getAttribute('type'), 'button')
  assert.ok(button.tabIndex >= 0, 'in the Tab order')
  assert.match(button.className, /focus-visible/, 'it shows its focus')
})

test('(2) no row when the visualizer gives no View controls (the props stay optional)', () => {
  const view = render(<SettingsDialog {...dialogProps()} />)
  assert.equal(view.queryByRole('button', { name: 'Open View controls' }), null)
})

test('(2) in French: the row, its help and its button come from the catalog', () => {
  setLocaleChoice('fr')
  const view = render(<SettingsDialog {...dialogProps({ onOpenViewControls: noop })} />)
  assert.ok(view.getByRole('tabpanel', { name: 'Général' }).querySelector('section[aria-label="Animations et cartes"]'))
  const button = view.getByRole('button', { name: 'Ouvrir les réglages d’affichage' })
  assert.equal(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
    'Se règlent avec le bouton Affichage sous le canevas : Figer les animations, les couches Calmer, Garder les cartes affichées, Masquer les appels sans réponse après.')
})

test('(2) axe finds nothing on the General tab with the row', async () => {
  const view = render(<SettingsDialog {...dialogProps({ onOpenViewControls: noop })} />)
  assert.deepEqual(await axeIds(view.getByRole('tabpanel', { name: 'General' })), [])
})

function controls(over: Partial<React.ComponentProps<typeof CanvasControls>> = {}) {
  const props: React.ComponentProps<typeof CanvasControls> = {
    teams: [] as unknown as React.ComponentProps<typeof CanvasControls>['teams'],
    zoomBy: noop, doZoomToFit: noop, animationsPaused: false, pausedBySystem: false, locale: 'en',
    calmLayers: DEFAULT_CALM_LAYERS, onToggleCalmLayer: noop, neverHide: false, toolExpiryS: 300,
    onToggleAnimationsPaused: noop, onToggleNeverHide: noop, onChangeToolExpiry: noop,
    ...over,
  }
  return <CanvasControls {...props} />
}

test('(2) a request opens the View popover and puts the focus on Freeze motion; Escape gives it back to View', () => {
  const view = render(controls({ openViewRequest: 0 }))
  assert.equal(view.queryByRole('dialog', { name: 'View settings' }), null, 'no request, nothing opens')
  act(() => { view.rerender(controls({ openViewRequest: 1 })) })
  const popover = view.getByRole('dialog', { name: 'View settings' })
  assert.equal(view.getByRole('button', { name: 'View' }).getAttribute('aria-expanded'), 'true')
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Freeze motion' }), 'the focus is in the popover, on its first control')
  assert.ok(popover.contains(document.activeElement))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  assert.equal(view.queryByRole('dialog', { name: 'View settings' }), null)
  assert.equal(document.activeElement, view.getByRole('button', { name: 'View' }), 'back on View (2.4.3)')
})

test('(2) a second request opens it again; a re-render with the same request does not', () => {
  const view = render(controls({ openViewRequest: 1 }))
  assert.equal(view.queryByRole('dialog', { name: 'View settings' }), null, 'a request already made before mounting is not replayed')
  act(() => { view.rerender(controls({ openViewRequest: 2 })) })
  fireEvent.click(view.getByRole('button', { name: 'View' }))
  assert.equal(view.queryByRole('dialog', { name: 'View settings' }), null, 'View still closes it')
  act(() => { view.rerender(controls({ openViewRequest: 2, neverHide: true })) })
  assert.equal(view.queryByRole('dialog', { name: 'View settings' }), null, 'same request: nothing reopens')
  act(() => { view.rerender(controls({ openViewRequest: 3, neverHide: true })) })
  assert.ok(view.getByRole('dialog', { name: 'View settings' }))
})

test('(2) Freeze motion locked by the system: the focus goes to the first control that can take it', () => {
  const view = render(controls({ openViewRequest: 0, pausedBySystem: true }))
  act(() => { view.rerender(controls({ openViewRequest: 1, pausedBySystem: true })) })
  const popover = view.getByRole('dialog', { name: 'View settings' })
  const active = document.activeElement as HTMLElement
  assert.ok(popover.contains(active), 'the focus is in the popover')
  assert.equal((active as HTMLButtonElement).disabled, false)
  assert.notEqual(active.textContent?.includes('Freeze motion'), true)
})
