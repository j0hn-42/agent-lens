// #523, one-line bar (owner request, 2026-10-21): the seven panel buttons of the top bar (Files, Conversation, Context,
// System, Cost, Timeline, Stats) show an icon at every width. The name is the same at every width (WCAG 2.5.3, 4.1.2): the
// label stays in the button, visually hidden, and the icon is an aria-hidden SVG. Each button has a role=tooltip linked by aria-describedby, shown on hover and on focus,
// hoverable, and closed by Escape even when it was opened by hover with the focus elsewhere (1.4.13). What does not fit
// on the line is behind More at fixed widths (lib/mobile-view.ts): a panel button of More closes it again.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import axe from 'axe-core'
import { TopBar, PANEL_BUTTON_IDS, TOPBAR_MORE_ID, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { setLocaleChoice } from '@/lib/locale'
import { MESSAGES, translate, type MessageKey } from '@/lib/messages'
import { TOOLTIP_CLOSE_DELAY_MS } from '@/lib/chrome-utils'
import { TOUCH_TARGET } from '@/lib/mobile-view'
import { COST_LABELS } from '@/lib/ui-glossary'
import { setMobileView, setViewportWidth } from './mobile-media'
import { openMore } from './topbar-more'

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
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, showStats: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, onToggleMute: noop, onOpenShortcuts: noop,
  onChangeShowMode: noop, onOpenSettings: noop, onToggleFullscreen: noop, onOpenPalette: noop,
  notifyState: 'off', onToggleNotify: noop, attention: { waiting: 1, errors: 0 }, onJumpToAttention: noop,
}

const PANELS = ['files', 'conversation', 'context', 'system', 'cost', 'timeline', 'stats'] as const
/** The accessible names the buttons had before #523, unchanged */
const EN_NAMES: Record<(typeof PANELS)[number], string> = {
  files: 'Files & repeats', conversation: 'Conversation (C)', context: 'Context (P)', system: 'System (Y)', cost: 'Cost', timeline: 'Timeline', stats: 'Stats',
}
const FR_NAMES: Record<(typeof PANELS)[number], string> = {
  files: 'Fichiers et répétitions', conversation: 'Conversation (C)', context: 'Contexte (P)', system: 'Système (Y)', cost: 'Coût', timeline: 'Chronologie', stats: 'Statistiques',
}
const nameKey = (p: string) => `topbar.panel.${p}.name` as MessageKey
const tipKey = (p: string) => `topbar.panel.${p}.tooltip` as MessageKey

/** The role=tooltip drawn next to the button (in its hover box), linked or not by aria-describedby. */
const tooltipOf = (button: HTMLElement) => button.parentElement?.querySelector<HTMLElement>('[role="tooltip"]') ?? null
/** The tooltip linked by aria-describedby (read after the name), or null. */
const describedTooltipOf = (button: HTMLElement) => {
  const ids = (button.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
  return ids.map(id => document.getElementById(id)).find(el => el?.getAttribute('role') === 'tooltip') ?? null
}
/** The panels whose tooltip adds something to the name (the shortcut counts: aria-keyshortcuts is not spoken by every screen
 *  reader); only Conversation, whose tooltip is exactly its name, is not linked. */
const DESCRIBED = new Set(['files', 'context', 'system', 'cost', 'timeline', 'stats'])
const shown = (tip: HTMLElement | null) => !!tip && !tip.hidden

test('messages: the names and tooltips of the seven panels exist in English and French; English names are the former ones', () => {
  for (const p of PANELS) {
    assert.equal(MESSAGES.en[nameKey(p)], EN_NAMES[p], `${p} en name`)
    assert.equal(MESSAGES.fr[nameKey(p)], FR_NAMES[p], `${p} fr name`)
    assert.ok(MESSAGES.en[tipKey(p)], `${p} en tooltip`)
    assert.ok(MESSAGES.fr[tipKey(p)], `${p} fr tooltip`)
  }
  // The cost method was the tooltip of the top bar cost, gone with it (#523): the Cost button's tooltip gives it now
  assert.ok(MESSAGES.en[tipKey('cost')].endsWith(COST_LABELS.method), MESSAGES.en[tipKey('cost')])
  assert.match(MESSAGES.fr[tipKey('cost')], /pas une facture/)
})

for (const locale of ['en', 'fr'] as const) {
  test(`each panel button keeps its accessible name, an aria-hidden SVG icon and its visible label (${locale})`, () => {
    setLocaleChoice(locale)
    const view = render(<TopBar {...base} />)
    for (const p of PANELS) {
      const name = translate(locale, nameKey(p))
      const button = view.getByRole('button', { name })
      assert.equal(button.id, PANEL_BUTTON_IDS[p], `${p}: the same button`)
      const svg = button.querySelector('svg')
      assert.ok(svg, `${p}: an icon`)
      assert.equal(svg!.getAttribute('aria-hidden'), 'true', `${p}: the icon is hidden from assistive technology`)
      assert.equal(svg!.getAttribute('focusable'), 'false')
      const label = button.querySelector('[data-panel-label]')
      assert.ok(label, `${p}: the visible label stays in the DOM`)
      assert.ok(name.startsWith(label!.textContent ?? '\u0000'), `${p}: the visible label "${label!.textContent}" starts the name "${name}" (2.5.3)`)
      // Hidden by CSS under 1280 px (sr-only keeps it in the accessibility tree), the icon drawn there only
      // An icon at every width (one-line bar): the label is visually hidden, the icon always drawn
      assert.match(label!.className, /(^| )sr-only\b/)
      assert.doesNotMatch(svg!.getAttribute('class') ?? '', /\bhidden\b/)
      assert.equal(button.closest('[lang]')?.getAttribute('lang'), locale, `${p}: declares its language`)
    }
  })
}

for (const locale of ['en', 'fr'] as const) {
  test(`a tooltip identical to the name is not read a second time; one that adds the shortcut or more is linked (aria-describedby, ${locale})`, () => {
    setLocaleChoice(locale)
    const view = render(<TopBar {...base} />)
    for (const p of PANELS) {
      const button = view.getByRole('button', { name: (locale === 'en' ? EN_NAMES : FR_NAMES)[p] })
      const described = describedTooltipOf(button)
      if (DESCRIBED.has(p)) {
        assert.ok(described, `${p}: its tooltip says what the panel shows, linked by aria-describedby`)
        assert.equal(described!.textContent, MESSAGES[locale][tipKey(p)])
      } else {
        assert.equal(button.getAttribute('aria-describedby'), null, `${p}: "${tooltipOf(button)?.textContent}" is exactly "${button.getAttribute('aria-label')}"`)
        assert.ok(tooltipOf(button), `${p}: the tooltip is still drawn on hover and focus`)
      }
    }
  })
}

test('each panel button has a role=tooltip and no native title (no double bubble)', () => {
  const view = render(<TopBar {...base} />)
  for (const p of PANELS) {
    const button = view.getByRole('button', { name: EN_NAMES[p] })
    const tip = tooltipOf(button)
    assert.ok(tip, `${p}: tooltip`)
    assert.equal(tip!.textContent, MESSAGES.en[tipKey(p)])
    assert.equal(button.getAttribute('title'), null, `${p}: no title`)
    assert.ok(!shown(tip), `${p}: closed at rest`)
  }
})

test('the tooltip opens on focus and on hover, stays while hovered, closes after the pointer leaves', async () => {
  const view = render(<TopBar {...base} />)
  const files = view.getByRole('button', { name: 'Files & repeats' })
  const tip = tooltipOf(files)!
  act(() => files.focus())
  assert.ok(shown(tip), 'focus opens it')
  act(() => files.blur())
  assert.ok(!shown(tip), 'blur closes it')
  const hoverBox = files.parentElement!
  fireEvent.mouseEnter(hoverBox)
  assert.ok(shown(tip), 'hover opens it')
  assert.ok(hoverBox.contains(tip), 'the tooltip is inside what is hovered (the pointer can move onto it)')
  fireEvent.mouseLeave(hoverBox)
  assert.ok(shown(tip), 'still open right after the pointer leaves')
  await act(async () => { await new Promise(r => setTimeout(r, TOOLTIP_CLOSE_DELAY_MS + 50)) })
  assert.ok(!shown(tip), 'closed after the delay')
})

test('Escape closes a tooltip opened by hover while the focus is elsewhere, and does nothing else', () => {
  const view = render(<TopBar {...base} />)
  const stats = view.getByRole('button', { name: 'Stats' })
  act(() => stats.focus())
  const context = view.getByRole('button', { name: 'Context (P)' })
  const tip = tooltipOf(context)!
  fireEvent.mouseEnter(context.parentElement!)
  assert.ok(shown(tip))
  let reached = false
  const late = () => { reached = true }
  document.addEventListener('keydown', late)
  try {
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  } finally {
    document.removeEventListener('keydown', late)
  }
  assert.ok(!shown(tip), 'Escape closed it')
  assert.equal(reached, false, 'the global Escape did not also run')
  assert.equal(document.activeElement, stats, 'the focus did not move')
  // Closed, Escape is left to the page
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
})

test('a click on the button closes its tooltip (it would cover the panel it opens) and the next Escape reaches the page', async () => {
  for (const press of [(el: HTMLElement) => fireEvent.pointerDown(el), (el: HTMLElement) => fireEvent.click(el)]) {
    const view = render(<TopBar {...base} />)
    const timeline = view.getByRole('button', { name: 'Timeline' })
    const tip = tooltipOf(timeline)!
    const hoverBox = timeline.parentElement!
    fireEvent.mouseEnter(hoverBox)
    assert.ok(shown(tip), 'hover opens it')
    press(timeline)
    // The click focuses the button: still hidden, the pointer has not left
    act(() => timeline.focus())
    assert.ok(!shown(tip), 'the click closed it, the pointer still on the button')
    let reached = false
    const late = () => { reached = true }
    document.addEventListener('keydown', late)
    try {
      fireEvent.keyDown(timeline, { key: 'Escape' })
    } finally {
      document.removeEventListener('keydown', late)
    }
    assert.equal(reached, true, 'one Escape reaches the page (closes the panel just opened)')
    // The pointer leaves and comes back: the tooltip shows again
    act(() => timeline.blur())
    fireEvent.mouseLeave(hoverBox)
    await act(async () => { await new Promise(r => setTimeout(r, TOOLTIP_CLOSE_DELAY_MS + 50)) })
    fireEvent.mouseEnter(hoverBox)
    assert.ok(shown(tip), 'the next hover shows it again')
    cleanup()
  }
})

test('opened by the keyboard focus alone, Escape hides the tooltip and still reaches the page (closing panels one by one)', () => {
  const view = render(<TopBar {...base} />)
  const files = view.getByRole('button', { name: 'Files & repeats' })
  const tip = tooltipOf(files)!
  act(() => files.focus())
  assert.ok(shown(tip))
  let reached = false
  const late = () => { reached = true }
  document.addEventListener('keydown', late)
  try {
    fireEvent.keyDown(files, { key: 'Escape' })
  } finally {
    document.removeEventListener('keydown', late)
  }
  assert.ok(!shown(tip), 'hidden')
  assert.equal(reached, true, 'the page Escape ran too')
  assert.equal(document.activeElement, files, 'the focus did not move')
})

test('an active panel button has a non-colour cue that works on an icon: a bottom bar', () => {
  const view = render(<TopBar {...base} showFileAttention showStats />)
  for (const name of ['Files & repeats', 'Stats']) {
    const b = view.getByRole('button', { name })
    assert.equal(b.getAttribute('aria-pressed'), 'true')
    assert.match(b.style.boxShadow, /inset 0(px)? -2px 0(px)?/, `${name}: bottom bar`)
  }
  assert.equal(view.getByRole('button', { name: 'Timeline' }).style.boxShadow, '', 'inactive: no bar')
})

test('in VS Code the Context tooltip says why the panel is unavailable', () => {
  const view = render(<TopBar {...base} isVSCode />)
  const tip = tooltipOf(view.getByRole('button', { name: 'Context (P)' }))!
  assert.match(tip.textContent ?? '', /standalone relay.*not available in VS Code/i)
})

/** Tab stops of the bar, in DOM order (what Tab follows: no tabindex above 0, no CSS order) */
const tabStops = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('button, [tabindex="0"], select'))
  .map(el => el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName)

test('one DOM order on one line: Sessions, connection, attention, filters, panels, Commands, More, then what More holds', () => {
  const view = render(<TopBar {...base} />)
  const header = view.container.querySelector('header')!
  const closed = tabStops(header)
  const at = (stops: string[], re: RegExp) => { const i = stops.findIndex(s => re.test(s)); assert.ok(i >= 0, `${re} in ${stops.join(' | ')}`); return i }
  const barOrder = [/^Sessions/, /needs you/, /^Notifications$/, /^Hide inactive: agents and sessions$/, /^Files & repeats$/, /^Conversation/, /^Context/, /^System/, /^Cost$/, /^Timeline$/, /^Stats$/, /^Commands$/, /^More/]
  const idx = barOrder.map(re => at(closed, re))
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, `tab order: ${closed.join(' | ')}`)
  assert.match(closed.at(-1)!, /^More/, 'More closes the bar; nothing of it is a Tab stop while closed')
  // More open: its overlay comes right after it in the DOM (Tab goes from More into it)
  openMore()
  const open = tabStops(header)
  const menuOrder = [/^More/, /sound effects/, /full screen/, /^Settings$/, /^Keyboard shortcuts$/]
  const mIdx = menuOrder.map(re => at(open, re))
  assert.deepEqual([...mIdx].sort((a, b) => a - b), mIdx, `tab order with More open: ${open.join(' | ')}`)
  const menu = header.querySelector('[data-topbar-menu]')!
  assert.equal(menu.id, header.querySelector('#topbar-more')!.getAttribute('aria-controls'))
  assert.deepEqual(Array.from(menu.querySelectorAll('[data-topbar-group]')).map(g => g.getAttribute('data-topbar-group')), ['tools'])
  // #523: no counts drawn (they are in the Sessions panel header); the totals are read by screen readers
  assert.equal(header.querySelector('[data-testid="topbar-agent-counts"]'), null, 'no agent counts drawn in the bar')
  assert.ok(header.querySelector('[data-testid="topbar-spoken-totals"].sr-only'), 'the spoken totals stay in the bar')
  // No box of the bar clips a focus ring or the overlay
  assert.doesNotMatch(header.className, /overflow-/)
  for (const g of Array.from(header.querySelectorAll<HTMLElement>('[data-topbar-group]'))) assert.doesNotMatch(g.className, /overflow-/)
})

test('the filters are in the bar when it has room (jsdom measures none: every width but mobile), in More under 768 px', () => {
  for (const [w, inBar] of [[1440, true], [1100, true], [900, true], [375, false]] as const) {
    setViewportWidth(w)
    const view = render(<TopBar {...base} />)
    const header = view.container.querySelector('header')!
    for (const id of ['topbar-notify', 'topbar-hide-inactive']) {
      assert.equal(!!header.querySelector(`#${id}`), inBar, `${w} px: ${id} ${inBar ? 'in the bar' : 'not in the bar'}`)
    }
    openMore()
    for (const id of ['topbar-notify', 'topbar-hide-inactive']) {
      assert.equal(header.querySelectorAll(`[id="${id}"]`).length, 1, `${w} px: ${id} once, in the bar or in More`)
    }
    assert.equal(!!header.querySelector('[data-topbar-menu] [data-topbar-group="filters"]'), !inBar, `${w} px: the filters group of More`)
    view.unmount()
  }
})

test('fixed widths: what the bar draws at 1440, 1100, 900 and 375 px (the rest is in More)', () => {
  const cases: Array<[number, { panels: boolean; commands: boolean }]> = [
    [1440, { panels: true, commands: true }], [1100, { panels: true, commands: false }],
    [900, { panels: false, commands: true }], [375, { panels: false, commands: false }],
  ]
  for (const [w, want] of cases) {
    setViewportWidth(w)
    const view = render(<TopBar {...base} />)
    const header = view.container.querySelector('header')!
    assert.equal(!!header.querySelector(`#${PANEL_BUTTON_IDS.files}`), want.panels, `${w} px: panels ${want.panels ? 'in the bar' : 'in More'}`)
    assert.equal(!!header.querySelector('#topbar-commands'), want.commands, `${w} px: Commands ${want.commands ? 'in the bar' : 'in More'}`)
    openMore()
    // Open, More holds the rest: every control is reachable at every width, once
    for (const id of [PANEL_BUTTON_IDS.files, PANEL_BUTTON_IDS.stats, 'topbar-commands', 'topbar-settings', 'topbar-shortcuts', 'topbar-mute']) {
      assert.equal(header.querySelectorAll(`[id="${id}"]`).length, 1, `${w} px: ${id} once`)
    }
    cleanup()
  }
})

test('768 to 1023 px: no 44 px target and no mobile branch; axe passes with More closed and open', async () => {
  setViewportWidth(900)
  const view = render(<TopBar {...base} />)
  const header = view.container.querySelector('header')!
  // The 44 px classes only act under 768 px (max-md); they are the same classes as before
  for (const b of Array.from(header.querySelectorAll('button'))) assert.ok(b.className.includes(TOUCH_TARGET))
  const run = async () => (await axe.run(view.container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.map(v => v.id)
  assert.deepEqual(await run(), [])
  openMore()
  for (const b of Array.from(header.querySelectorAll('button'))) assert.ok(b.className.includes(TOUCH_TARGET), `${b.getAttribute('aria-label') ?? b.textContent}`)
  assert.deepEqual(await run(), [])
})

test('768 to 1023 px: a panel button of More closes it and leaves the focus on More', () => {
  setViewportWidth(900)
  const toggled: string[] = []
  const view = render(<TopBar {...base} onTogglePanel={p => toggled.push(p)} onToggleTimeline={() => toggled.push('timeline')} />)
  const more = view.getByRole('button', { name: /^More/ })
  for (const [name, id] of [['Files & repeats', 'files'], ['Conversation (C)', 'conversation'], ['Timeline', 'timeline']] as const) {
    fireEvent.click(more)
    assert.equal(more.getAttribute('aria-expanded'), 'true')
    for (const n of ['Hide inactive: agents and sessions', 'Stats', 'Settings', 'Keyboard shortcuts']) assert.ok(view.getByRole('button', { name: n }), `${n} shown`)
    const button = view.getByRole('button', { name })
    button.focus()
    fireEvent.click(button)
    assert.equal(toggled.at(-1), id)
    assert.equal(more.getAttribute('aria-expanded'), 'false', `${name} closes More`)
    assert.equal(document.activeElement, more, `the focus waits on More after ${name}`)
  }
  assert.equal(view.getAllByRole('button', { name: 'Commands' }).length, 1, 'one Commands button')
})

test('More: Escape closes it and gives the focus back to More; the app Escape waits; a click outside closes it', () => {
  const view = render(<><TopBar {...base} /><button type="button">outside</button></>)
  const more = openMore()
  const settings = view.getByRole('button', { name: 'Settings' })
  settings.focus()
  let reached = false
  const late = () => { reached = true }
  window.addEventListener('keydown', late)
  try {
    fireEvent.keyDown(settings, { key: 'Escape' })
  } finally { window.removeEventListener('keydown', late) }
  assert.equal(more.getAttribute('aria-expanded'), 'false')
  assert.equal(document.activeElement, more, 'the focus is back on More (2.4.3)')
  assert.equal(reached, false, 'the app Escape (close a panel, clear the selection) did not also run')
  openMore()
  fireEvent.pointerDown(view.getByRole('button', { name: 'outside' }))
  assert.equal(more.getAttribute('aria-expanded'), 'false', 'a click outside the bar closes it')
})

test('crossing a width keeps the focus: a control that moves behind More opens More and keeps it, one that comes back keeps it too', () => {
  const view = render(<TopBar {...base} />)
  const header = view.container.querySelector('header')!
  const menu = () => header.querySelector('[data-topbar-menu]')!
  const more = () => view.getByRole('button', { name: /^More/ })
  // Commands: in the bar at 1440 px, in More at 1100 px
  view.getByRole('button', { name: 'Commands' }).focus()
  setViewportWidth(1100)
  assert.equal(document.activeElement?.id, 'topbar-commands', 'Commands keeps the focus')
  assert.ok(menu().contains(document.activeElement), 'More opened to show it')
  assert.equal(more().getAttribute('aria-expanded'), 'true')
  fireEvent.click(more())
  // A panel button: in the bar at 1100 px, in More at 900 px
  view.getByRole('button', { name: 'Files & repeats' }).focus()
  setViewportWidth(900)
  assert.equal(document.activeElement?.id, PANEL_BUTTON_IDS.files)
  assert.ok(menu().contains(document.activeElement))
  // Back to 1440 px: the button is in the bar again and keeps the focus
  setViewportWidth(1440)
  assert.equal(document.activeElement?.id, PANEL_BUTTON_IDS.files)
  assert.ok(!menu().contains(document.activeElement), 'the one in the bar')
  // More itself never moves
  more().focus()
  setViewportWidth(375)
  assert.equal(document.activeElement, more())
})

test('under 768 px Commands is in More and keeps the focus when the window narrows', () => {
  setViewportWidth(900)
  const view = render(<TopBar {...base} />)
  view.getByRole('button', { name: 'Commands' }).focus()
  setMobileView(true)
  assert.equal(document.activeElement?.id, 'topbar-commands')
  assert.ok(view.container.querySelector('[data-topbar-menu]')!.contains(document.activeElement))
})

// PR #631 review: "Notifications blocked" was drawn in the bar from 1024 px before the one-line bar; it is behind More now,
// so More signals it: the warning triangle (a shape, not a colour alone) and a description that names the blocked
// notifications. The accessible name of More still contains its visible text (2.5.3).
const describedText = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')
test('blocked notifications are signalled on More: warning mark and description, at every width, in both languages', () => {
  for (const [label, mobile] of [['375 px', true]] as const) {
    setMobileView(mobile)
    const view = render(<TopBar {...base} notifyState="denied" />)
    const more = document.getElementById(TOPBAR_MORE_ID)!
    assert.equal(view.container.querySelector('[data-more-mark]')?.getAttribute('data-more-mark'), 'alert', `${label}: warning triangle`)
    assert.match(describedText(more), /Notifications blocked/, `${label}: ${describedText(more)}`)
    const name = more.getAttribute('aria-label') ?? ''
    // Visible text: what is not aria-hidden, and not hidden under 768 px (max-md:hidden) at 375 px
    const visible = [...more.querySelectorAll('span')]
      .filter(s => !s.closest('[aria-hidden="true"]') && !(mobile && s.classList.contains('max-md:hidden')))
      .map(s => s.textContent).join('').trim()
    assert.ok(name.includes(visible), `${label}: name "${name}" contains the visible text "${visible}"`)
    view.unmount()
  }
  setMobileView(false)
  const off = render(<TopBar {...base} notifyState="off" />)
  assert.equal(off.container.querySelector('[data-more-mark]'), null, 'notifications not blocked: no mark')
  off.unmount()
  setLocaleChoice('fr')
  setMobileView(true)
  render(<TopBar {...base} notifyState="denied" />)
  assert.match(describedText(document.getElementById(TOPBAR_MORE_ID)!), /Notifications bloquées/)
  cleanup()
  setMobileView(false)
  // While the filters are in the bar the blocked state is the label of its button: More holds nothing to signal
  const wide = render(<TopBar {...base} notifyState="denied" />)
  assert.equal(wide.container.querySelector('[data-more-mark]'), null)
  assert.ok(wide.container.querySelector('header #topbar-notify'))
})
