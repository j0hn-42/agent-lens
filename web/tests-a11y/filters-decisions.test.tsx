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
import { PanelDock } from '@/components/agent-visualizer/panel-dock'
import { DEFAULT_CALM_LAYERS } from '@/lib/motion-layers'
import { FOCUS_RING } from '@/lib/focus-ring'
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
  const title = document.getElementById('session-list-title')!
  assert.ok(title.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING, 'after the header')
  const firstRow = view.container.querySelector('[data-closable-id]')!
  assert.ok(line.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING, 'before the rows')
  // Plain text, no new control: nothing focusable, no role
  assert.equal(line.querySelector('button, a, input, [tabindex]'), null)
  assert.equal(line.getAttribute('role'), null)
  // The separator is drawn, not read
  const dot = [...line.querySelectorAll('[aria-hidden="true"]')].map(n => n.textContent)
  assert.deepEqual(dot, [' · '])
})

test('(1) during the guided tour, which shows the inactive agents for a moment, the line says the filter is paused, not on (#613)', () => {
  const view = render(panel({ activeOnly: true, canvasHideInactive: true, canvasHidePausedByTour: true }))
  assert.equal(scopeLine(view.container)!.textContent, 'List: Active only · Canvas: Hide inactive paused during the tour')
  view.rerender(panel({ activeOnly: true, canvasHideInactive: true, canvasHidePausedByTour: false }))
  assert.equal(scopeLine(view.container)!.textContent, `List: Active only · Canvas: Hide inactive (${ACTIVE_WINDOW_MINUTES} min)`, 'the tour over: the setting again')
  // The setting off: nothing is paused, the line says off
  view.rerender(panel({ activeOnly: true, canvasHideInactive: false, canvasHidePausedByTour: true }))
  assert.equal(scopeLine(view.container)!.textContent, 'List: Active only · Canvas: Hide inactive off')
  cleanup()
  setLocaleChoice('fr')
  const fr = render(panel({ activeOnly: true, canvasHideInactive: true, canvasHidePausedByTour: true }))
  assert.match(scopeLine(fr.container)!.textContent ?? '', /Canevas : Masquer les inactifs suspendu pendant la visite$/)
})

test('(1) wiring: PanelDock tells the Sessions panel that the tour pauses the canvas filter (#613)', () => {
  const ref = () => ({ current: null })
  const dock = (tourShowsInactive: boolean) => ({
    panels: {
      panelRefs: { files: ref(), sessions: ref(), context: ref(), system: ref(), timeline: ref() },
      showFileAttention: false, showSessions: true, showContext: false, showSystem: false, showTimeline: false,
      setShowFileAttention: noop, setShowSessions: noop, setShowContext: noop, setShowSystem: noop, setShowTimeline: noop,
    },
    sim: { fileAttention: new Map(), waste: undefined, agents: new Map(), timelineEntries: new Map(), currentTime: 0 },
    bridge: {
      sessions, selectedSessionId: '__all__', sessionsWithActivity: new Set(), sessionModels: new Map(),
      selectSession: noop, renameSession: noop, useMockData: true, isVSCode: false, connectionStatus: 'connected',
      teams: new Map(), teamWorking: new Map(), teamSummaries: new Map(), teamMemberCounts: new Map(), relayScope: null,
      systemStats: [], quota: null, eventLoss: null, replayLost: 0,
    },
    selection: { selectedAgentId: null, handleAgentClick: noop },
    attention: undefined, health: { bySession: undefined },
    sessionActions: { handleCloseSession: noop, handleExportSession: noop, canExportSession: () => false },
    uiPrefs: { prefs: { sessionListActiveOnly: false, show: 'active' }, setPref: noop },
    allSessionCount: 2, agentCounts: { active: 0, done: 0, stale: 0, idle: 0, error: 0 }, listAgents: new Map(), agentLabel: (k: string) => k, openFile: noop,
    fetchContext: async () => null, contextOrigin: '', tourShowsInactive,
  }) as unknown as React.ComponentProps<typeof PanelDock>
  const view = render(<PanelDock {...dock(true)} />)
  assert.match(scopeLine(view.container)?.textContent ?? '', /Canvas: Hide inactive paused during the tour$/)
  view.rerender(<PanelDock {...dock(false)} />)
  assert.match(scopeLine(view.container)?.textContent ?? '', /Canvas: Hide inactive \(\d+ min\)$/)
})

test('(1) the line follows the Active only button at once and the canvas setting as given', () => {
  const changes: boolean[] = []
  const view = render(panel({ activeOnly: undefined, canvasHideInactive: false, onActiveOnlyChange: v => changes.push(v) }))
  assert.equal(scopeLine(view.container)!.textContent, 'List: Active only · Canvas: Hide inactive off')
  fireEvent.click(view.getByRole('button', { name: 'Active only' }))
  assert.deepEqual(changes, [false])
  assert.equal(scopeLine(view.container)!.textContent, 'List: all sessions · Canvas: Hide inactive off')
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
  assert.equal(scopeLine(view.container)!.textContent, 'Liste : toutes les sessions · Canevas : Masquer les inactifs désactivé')
})

// The line never says "all sessions" while a filter of the list is on (docs/reading-the-ui.md: no state that cannot be proven)
const filterSessions: SessionInfo[] = [
  { id: 'a', label: 'fix login', status: 'active', startTime: 0, lastActivityTime: 30, projectId: 'p1', projectName: 'one', runtime: 'claude', branch: 'main' },
  { id: 'b', label: 'old work', status: 'completed', startTime: 0, lastActivityTime: 20, projectId: 'p2', projectName: 'two', runtime: 'codex', branch: 'dev' },
]
const filtered = (extra: Partial<React.ComponentProps<typeof SessionListPanel>>) =>
  panel({ sessions: filterSessions, canvasHideInactive: false, ...extra })

const FILTER_CASES: Array<[string, Partial<React.ComponentProps<typeof SessionListPanel>>]> = [
  ['project', { filterProject: 'p1' }],
  ['runtime', { filterRuntime: 'claude' }],
  ['branch', { filterBranch: 'main' }],
]

for (const [name, props] of FILTER_CASES) {
  test(`(1) a ${name} filter on, Active only off: the list half says filtered, never all sessions (en, fr)`, () => {
    const view = render(filtered({ activeOnly: false, ...props }))
    assert.equal(scopeLine(view.container)!.textContent, 'List: filtered · Canvas: Hide inactive off')
    view.unmount()
    setLocaleChoice('fr')
    const fr = render(filtered({ activeOnly: false, ...props }))
    assert.equal(scopeLine(fr.container)!.textContent, 'Liste : filtrée · Canevas : Masquer les inactifs désactivé')
  })
  test(`(1) a ${name} filter on with Active only on: both are said`, () => {
    const view = render(filtered({ activeOnly: true, ...props }))
    assert.equal(scopeLine(view.container)!.textContent, 'List: Active only, filtered · Canvas: Hide inactive off')
    view.unmount()
    setLocaleChoice('fr')
    const fr = render(filtered({ activeOnly: true, ...props }))
    assert.equal(scopeLine(fr.container)!.textContent, 'Liste : Actives seulement, filtrée · Canevas : Masquer les inactifs désactivé')
  })
}

test('(1) a search on: the list half says filtered; clearing the search brings back "all sessions"', () => {
  const view = render(filtered({ activeOnly: false }))
  assert.equal(scopeLine(view.container)!.textContent, 'List: all sessions · Canvas: Hide inactive off')
  fireEvent.change(view.getByRole('searchbox'), { target: { value: 'login' } })
  assert.equal(scopeLine(view.container)!.textContent, 'List: filtered · Canvas: Hide inactive off')
  fireEvent.change(view.getByRole('searchbox'), { target: { value: '  ' } })
  assert.equal(scopeLine(view.container)!.textContent, 'List: all sessions · Canvas: Hide inactive off')
})

test('(1) a filter naming a project no session has any more is ignored, so nothing is filtered: all sessions', () => {
  const view = render(filtered({ activeOnly: false, filterProject: 'gone' }))
  assert.equal(scopeLine(view.container)!.textContent, 'List: all sessions · Canvas: Hide inactive off')
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
  assert.equal(help?.textContent, 'Set from the View button under the canvas: Freeze motion, Calm by layer, Pin cards, Hide unanswered calls after.')
})

test('(2) the button closes Settings first, then asks for the View controls', () => {
  const calls: string[] = []
  const view = render(<SettingsDialog {...dialogProps({ onClose: () => calls.push('close'), onOpenViewControls: () => calls.push('view') })} />)
  fireEvent.click(view.getByRole('button', { name: 'Open View controls' }))
  assert.deepEqual(calls, ['close', 'view'])
})

/**
 * The sequential focus order of the document as a browser builds it for Tab (jsdom has no Tab): focusable elements in
 * tree order, without a negative tabindex, a disabled control, or a hidden / inert ancestor. No positive tabindex is used
 * in the dialog, so tree order is the order.
 */
function tabOrder(root: ParentNode = document): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex]'))
  return all.filter(el => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest('[hidden], [inert]'))
}

test('(2) keyboard: Tab from the tab list reaches the button, Enter on a native button activates it', () => {
  const calls: string[] = []
  const view = render(<SettingsDialog {...dialogProps({ onOpenViewControls: () => calls.push('view') })} />)
  const button = view.getByRole('button', { name: 'Open View controls' })
  assert.equal(button.tagName, 'BUTTON')
  assert.equal(button.getAttribute('type'), 'button')
  assert.ok(button.tabIndex >= 0, 'in the Tab order')
  assert.match(button.className, /focus-visible/, 'it shows its focus')
  // #613: the Tab sequence from the selected tab (the one tab of the roving tab list in the order) reaches the button,
  // and only through controls of the General panel (nothing of a hidden tab panel in between)
  const order = tabOrder()
  const selectedTab = view.getByRole('tab', { selected: true })
  const from = order.indexOf(selectedTab)
  const to = order.indexOf(button)
  assert.ok(from >= 0 && to > from, `the button comes after the tab list in the Tab order (${from} -> ${to})`)
  const general = view.getByRole('tabpanel', { name: 'General' })
  for (const el of order.slice(from + 1, to)) assert.ok(general.contains(el), `only General controls in between, not ${el.outerHTML.slice(0, 80)}`)
  assert.equal(order.filter(el => el.getAttribute('role') === 'tab').length, 1, 'one tab of the list in the order (roving tabindex)')
})

test('(2) the "View keyboard shortcuts" link row shows its focus like the View one (#613)', () => {
  const view = render(<SettingsDialog {...dialogProps({ onOpenViewControls: noop })} />)
  fireEvent.click(view.getByRole('tab', { name: 'Keyboard and preferences' }))
  const shortcuts = view.getByRole('button', { name: 'View keyboard shortcuts' })
  for (const token of FOCUS_RING.split(/\s+/).filter(Boolean)) assert.ok(shortcuts.classList.contains(token), `focus ring class ${token}`)
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
    'Se règlent avec le bouton Affichage sous le canevas : Figer les animations, Calmer par couche, Garder les cartes affichées, Masquer les appels sans réponse après.')
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

test('(2) a press outside on a spot that takes no focus closes the popover and gives the focus back to View, not <body> (#613)', async () => {
  const view = render(controls({ openViewRequest: 0 }))
  act(() => { view.rerender(controls({ openViewRequest: 1 })) })
  assert.ok(view.getByRole('dialog', { name: 'View settings' }).contains(document.activeElement), 'precondition: the focus is in the popover')
  await act(async () => {
    fireEvent.mouseDown(document.body)
    await new Promise(r => setTimeout(r, 0))
  })
  assert.equal(view.queryByRole('dialog', { name: 'View settings' }), null, 'closed')
  assert.equal(document.activeElement, view.getByRole('button', { name: 'View' }), 'back on View (2.4.3)')
})

test('(2) a press outside on a control that takes the focus leaves the focus there (#613)', async () => {
  const outside = document.createElement('button')
  outside.textContent = 'elsewhere'
  document.body.appendChild(outside)
  const view = render(controls({ openViewRequest: 0 }))
  act(() => { view.rerender(controls({ openViewRequest: 1 })) })
  assert.ok(view.getByRole('dialog', { name: 'View settings' }).contains(document.activeElement), 'precondition: the focus is in the popover')
  await act(async () => {
    fireEvent.mouseDown(outside)
    outside.focus()
    await new Promise(r => setTimeout(r, 0))
  })
  assert.equal(view.queryByRole('dialog', { name: 'View settings' }), null, 'closed')
  assert.equal(document.activeElement, outside, 'the focus stays on what the user pressed')
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

test('(2) popover already open when the request arrives: the focus goes in, and is not stolen later', () => {
  const view = render(controls({ openViewRequest: 0 }))
  fireEvent.click(view.getByRole('button', { name: 'View' }))
  ;(document.activeElement as HTMLElement | null)?.blur()
  assert.ok(document.activeElement === document.body)
  act(() => { view.rerender(controls({ openViewRequest: 1 })) })
  // assert.ok on an identity: a failing assert.equal on two jsdom elements makes the runner hang while it prints them
  assert.ok(document.activeElement === view.getByRole('button', { name: 'Freeze motion' }), 'the focus went into the open popover')
  fireEvent.click(view.getByRole('button', { name: 'View' }))
  ;(document.activeElement as HTMLElement | null)?.blur()
  fireEvent.click(view.getByRole('button', { name: 'View' }))
  assert.ok(document.activeElement !== view.getByRole('button', { name: 'Freeze motion' }), 'a later opening by hand does not move the focus')
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
