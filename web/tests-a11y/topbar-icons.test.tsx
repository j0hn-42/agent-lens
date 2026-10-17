// #523: the seven panel buttons of the top bar (Files, Conversation, Context, System, Cost, Timeline, Stats) show an icon
// under 1280 px wide and their name from 1280 px. The name is the same at every width (WCAG 2.5.3, 4.1.2): the visible
// label stays in the button (visually hidden by CSS under 1280 px, measured in e2e/topbar-layout.e2e.ts) and the icon
// is an aria-hidden SVG. Each button has a role=tooltip linked by aria-describedby, shown on hover and on focus,
// hoverable, and closed by Escape even when it was opened by hover with the focus elsewhere (1.4.13). The bar folds
// behind More under 1024 px (a query apart from the 768 px mobile view): there, Commands stays in the bar and a panel
// button folds More again.
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
  onToggleHideInactive: noop, onOpenSettings: noop, onToggleFullscreen: noop, onOpenPalette: noop,
  notifyState: 'off', onToggleNotify: noop, attention: { waiting: 1, errors: 0 }, onJumpToAttention: noop,
}

const PANELS = ['files', 'conversation', 'context', 'system', 'cost', 'timeline', 'stats'] as const
/** The accessible names the buttons had before #523, unchanged */
const EN_NAMES: Record<(typeof PANELS)[number], string> = {
  files: 'Files', conversation: 'Conversation (C)', context: 'Context (P)', system: 'System (Y)', cost: '$Cost', timeline: 'Timeline', stats: 'Stats',
}
const FR_NAMES: Record<(typeof PANELS)[number], string> = {
  files: 'Fichiers', conversation: 'Conversation (C)', context: 'Contexte (P)', system: 'Système (Y)', cost: 'Coût', timeline: 'Chronologie', stats: 'Statistiques',
}
const nameKey = (p: string) => `topbar.panel.${p}.name` as MessageKey
const tipKey = (p: string) => `topbar.panel.${p}.tooltip` as MessageKey

const tooltipOf = (button: HTMLElement) => {
  const ids = (button.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
  return ids.map(id => document.getElementById(id)).find(el => el?.getAttribute('role') === 'tooltip') ?? null
}
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
      assert.match(label!.className, /\bmax-xl:sr-only\b/)
      assert.match(svg!.getAttribute('class') ?? '', /\bmax-xl:block\b/)
      assert.equal(button.closest('[lang]')?.getAttribute('lang'), locale, `${p}: declares its language`)
    }
  })
}

test('each panel button has a role=tooltip linked by aria-describedby and no native title (no double bubble)', () => {
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
  const files = view.getByRole('button', { name: 'Files' })
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

test('opened by the keyboard focus alone, Escape hides the tooltip and still reaches the page (closing panels one by one)', () => {
  const view = render(<TopBar {...base} />)
  const files = view.getByRole('button', { name: 'Files' })
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
  for (const name of ['Files', 'Stats']) {
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

test('one DOM order: row 1 (Sessions, connection, attention, filters) then row 2 (agent counts, panels, tools)', () => {
  const view = render(<TopBar {...base} />)
  const header = view.container.querySelector('header')!
  const stops = tabStops(header)
  const at = (re: RegExp) => { const i = stops.findIndex(s => re.test(s)); assert.ok(i >= 0, `${re} in ${stops.join(' | ')}`); return i }
  const order = [/^Sessions/, /needs you/, /^Notifications$/, /^Hide inactive agents$/, /^Files$/, /^Conversation/, /^Context/, /^System/, /^\$Cost$/, /^Timeline$/, /^Stats$/, /sound effects/, /full screen/, /^Commands$/, /^Settings$/, /^Keyboard shortcuts$/]
  const idx = order.map(at)
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, `tab order: ${stops.join(' | ')}`)
  // The groups: identity and filters (row 1), agent counts, panels and tools (row 2)
  const groups = Array.from(header.querySelectorAll('[data-topbar-group]')).map(g => g.getAttribute('data-topbar-group'))
  assert.deepEqual(groups, ['identity', 'filters', 'status', 'panels', 'tools'])
  const row = (n: string) => header.querySelector(`[data-topbar-row="${n}"]`)!
  for (const g of ['identity', 'filters']) assert.ok(row('1').contains(header.querySelector(`[data-topbar-group="${g}"]`)), `${g} in row 1`)
  for (const g of ['status', 'panels', 'tools']) assert.ok(row('2').contains(header.querySelector(`[data-topbar-group="${g}"]`)), `${g} in row 2`)
  assert.ok(row('2').querySelector('[data-testid="topbar-agent-counts"]'), 'the agent counts open row 2')
  // No group clips the focus ring
  for (const g of Array.from(header.querySelectorAll<HTMLElement>('[data-topbar-group], [data-topbar-row]'))) assert.doesNotMatch(g.className, /overflow-/)
})

test('the DOM order is the same with icons (1100 px) and labels (1440 px)', () => {
  const wide = render(<TopBar {...base} />)
  const a = tabStops(wide.container.querySelector('header')!)
  cleanup()
  setViewportWidth(1100)
  const icons = render(<TopBar {...base} />)
  assert.deepEqual(tabStops(icons.container.querySelector('header')!), a)
  assert.equal(icons.container.querySelector(`#${TOPBAR_MORE_ID}`), null, 'not folded at 1100 px')
})

test('768 to 1023 px: the bar folds behind More, Commands stays in the bar, no 44 px target and no mobile branch', async () => {
  setViewportWidth(900)
  const view = render(<TopBar {...base} />)
  const header = view.container.querySelector('header')!
  const more = view.getByRole('button', { name: /^More/ })
  assert.equal(more.id, TOPBAR_MORE_ID)
  assert.equal(more.getAttribute('aria-expanded'), 'false')
  assert.ok(view.getByRole('button', { name: 'Commands' }), 'Commands stays in the folded bar')
  assert.equal(view.queryByRole('button', { name: 'Files' }), null, 'the panel buttons fold')
  assert.equal(view.queryByRole('button', { name: 'Hide inactive agents' }), null, 'the filters fold')
  // The 44 px classes only act under 768 px (max-md); they are the same classes as before
  for (const b of Array.from(header.querySelectorAll('button'))) assert.ok(b.className.includes(TOUCH_TARGET))
  const results = await axe.run(view.container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
  assert.deepEqual(results.violations.map(v => v.id), [])
})

test('768 to 1023 px: More shows every control; a panel button folds More again and leaves the focus on More', () => {
  setViewportWidth(900)
  const toggled: string[] = []
  const view = render(<TopBar {...base} onTogglePanel={p => toggled.push(p)} onToggleTimeline={() => toggled.push('timeline')} />)
  const more = view.getByRole('button', { name: /^More/ })
  for (const [name, id] of [['Files', 'files'], ['Conversation (C)', 'conversation'], ['Timeline', 'timeline']] as const) {
    fireEvent.click(more)
    assert.equal(more.getAttribute('aria-expanded'), 'true')
    for (const n of ['Hide inactive agents', 'Stats', 'Settings', 'Keyboard shortcuts', 'Commands']) assert.ok(view.getByRole('button', { name: n }), `${n} shown`)
    const button = view.getByRole('button', { name })
    button.focus()
    fireEvent.click(button)
    assert.equal(toggled.at(-1), id)
    assert.equal(more.getAttribute('aria-expanded'), 'false', `${name} folds More`)
    assert.equal(document.activeElement, more, `the focus waits on More after ${name}`)
  }
  assert.equal(view.getAllByRole('button', { name: 'Commands' }).length, 1, 'one Commands button')
})

test('crossing 1024 px keeps the focus: on Commands it stays on Commands, on a panel button More opens, on More it goes to the bar', () => {
  const view = render(<TopBar {...base} />)
  const commands = view.getByRole('button', { name: 'Commands' })
  commands.focus()
  setViewportWidth(900)
  assert.equal(document.activeElement, commands, 'the same Commands button keeps the focus')
  assert.equal(view.getByRole('button', { name: /^More/ }).getAttribute('aria-expanded'), 'false', 'More stays folded')
  setViewportWidth(1440)
  view.getByRole('button', { name: 'Files' }).focus()
  setViewportWidth(900)
  assert.equal(document.activeElement?.id, PANEL_BUTTON_IDS.files)
  assert.equal(view.getByRole('button', { name: /^More/ }).getAttribute('aria-expanded'), 'true')
  fireEvent.click(view.getByRole('button', { name: /^More/ }))
  view.getByRole('button', { name: /^More/ }).focus()
  setViewportWidth(1100)
  assert.ok(document.activeElement && document.activeElement !== document.body, 'the focus is not dropped on <body>')
  assert.ok(view.container.querySelector('header')!.contains(document.activeElement), 'it stays in the bar')
})

test('under 768 px Commands is not drawn and its focus goes to More (unchanged)', () => {
  setViewportWidth(900)
  const view = render(<TopBar {...base} />)
  view.getByRole('button', { name: 'Commands' }).focus()
  setMobileView(true)
  assert.equal(view.queryByRole('button', { name: 'Commands' }), null)
  assert.equal(document.activeElement?.id, TOPBAR_MORE_ID)
})
