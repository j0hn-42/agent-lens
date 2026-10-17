/**
 * Command palette (#243): the items it lists and the search over them. Pure (no React).
 * Nothing here states more than the session list or the agent list already proved: a session is never
 * called "active" or "running", an agent never gets a state. The palette finds things; the panels show them.
 * A command that the view cannot run now (no blocked agent, no tour, no events to export) is left out (#377).
 */
import { ALL_SESSIONS_ID, cleanLine, type SessionInfo } from './bridge-types'
import { runtimeBadge } from './chrome-utils'
import { SESSION_IMPORTED_TEXT, SESSION_INDEXED_TEXT } from './session-model'
import { SHORTCUTS } from './shortcuts'
import { HIERARCHY_TERMS, PANEL_NAMES } from './ui-glossary'
import { translate, type Locale, type MessageKey } from './messages'

export const PALETTE_GROUPS = ['Actions', 'Panels', 'Sessions', 'Agents', 'Themes'] as const
export type PaletteGroup = (typeof PALETTE_GROUPS)[number]

/** Panels the palette can toggle (the Sessions list included). */
export type PalettePanel = 'sessions' | 'files' | 'conversation' | 'timeline' | 'context' | 'system' | 'stats' | 'cost'

/** Longest label shown for an untrusted name (session label, agent name). */
const MAX_LABEL = 80

export interface PaletteItem {
  /** Unique and stable: also the DOM id suffix of the option */
  id: string
  group: PaletteGroup
  label: string
  /** Secondary text, only facts the session / agent list carries */
  detail?: string
  /** Key cap(s) of the matching shortcut, only while that shortcut works */
  shortcut?: string
  /** Extra search terms (never displayed). In French they also hold the English name and the English terms (#503) */
  keywords: readonly string[]
  /** Language of the text when it is not the interface's (the tour label comes from the tour, still English): declared with lang (WCAG 3.1.2) */
  lang?: Locale
  /** Free text taken from a session or an agent: presentation mode blurs it (data-sensitive) */
  sensitive: boolean
  /** True when running the item moves focus by itself (a panel opening, an agent card): the palette then leaves focus alone */
  movesFocus: boolean
  run: () => void
}

/** The part of an Agent the palette reads. */
export interface PaletteAgent {
  id: string
  name: string
  sessionId: string
  sessionLabel?: string
  kind?: 'main' | 'subagent' | 'teammate'
  isMain?: boolean
  /** Its agent:<role> label (agentRoleOf), read only for the launch entries */
  role?: string
}

export interface PaletteSource {
  /** Language of the labels and details (default en); the English names stay searchable in every language (#503) */
  locale?: Locale
  /** The "single-key shortcuts" preference: a shortcut that would not work is not advertised */
  singleKeyEnabled: boolean
  selectedSessionId: string | null
  sessions: ReadonlyArray<SessionInfo>
  agents: Iterable<PaletteAgent>
  actions: {
    togglePlayPause: () => void
    zoomToFit: () => void
    toggleFullscreen: () => void
    toggleHexGrid: () => void
    toggleMute: () => void
    openShortcuts: () => void
    openSettings: () => void
    /** The commands below are listed only when given: the view can run them now (#377) */
    togglePresentation?: () => void
    clearHistory?: () => void
    /** Saves the session of the current view; given only while it has events in memory */
    exportSession?: () => void
  }
  /** The tour the legend offers, under the same label; absent while none can start */
  tour?: { label: string; run: () => void }
  /**
   * Next agent waiting for a permission or in error: `detail` is the top bar counter text; absent when none.
   * `movesFocus`: the next one is in this view (its card takes the focus), not in another session
   */
  attention?: { detail: string; movesFocus: boolean; run: () => void }
  /** Browser notifications toggle; absent when unsupported or blocked by the browser */
  notifications?: { on: boolean; run: () => void }
  /** The themes of Settings > Appearance, under the names the theme select gives them */
  themes?: { current: string; options: ReadonlyArray<{ id: string; label: string; alias?: string }>; set: (id: string) => void }
  /** The relay serving this page accepts launches (#229): each role of the view gets a launch entry (#377) */
  launchAvailable?: boolean
  togglePanel: (panel: PalettePanel) => void
  selectSession: (id: string) => void
  selectAgent: (id: string) => void
}

function shortcutOf(key: string, singleKeyEnabled: boolean): string | undefined {
  const s = SHORTCUTS.find(x => x.key === key)
  if (!s || (s.singleKey && !singleKeyEnabled)) return undefined
  return s.display
}

const tr = (locale: Locale, key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)

/** What the session list recorded about a session, nothing inferred. */
export function sessionDetail(s: SessionInfo, locale: Locale = 'en'): string {
  const parts: string[] = []
  const runtime = runtimeBadge(s.runtime)
  if (runtime) parts.push(runtime.label)
  const project = cleanLine(s.projectName, MAX_LABEL)
  if (project) parts.push(project)
  const branch = cleanLine(s.branch, MAX_LABEL)
  if (branch) parts.push(branch)
  if (s.imported) parts.push(locale === 'en' ? SESSION_IMPORTED_TEXT : tr(locale, 'sessions.status.imported'))
  else if (s.indexedOnly) parts.push(locale === 'en' ? SESSION_INDEXED_TEXT : tr(locale, 'sessions.status.indexed'))
  else if (s.status === 'completed') parts.push(tr(locale, 'palette.finished'))
  return parts.join(', ')
}

const KIND_KEY = {
  main: 'palette.kind.main',
  subagent: 'palette.kind.subagent',
  teammate: 'palette.kind.teammate',
} as const satisfies Record<string, MessageKey>

/** Role and session of an agent. Its state is left out: it may be older than the screen. */
export function agentDetail(a: PaletteAgent, locale: Locale = 'en'): string {
  const parts: string[] = []
  const kind = a.kind ?? (a.isMain ? 'main' : undefined)
  if (kind) parts.push(tr(locale, KIND_KEY[kind]))
  const session = cleanLine(a.sessionLabel, MAX_LABEL)
  // "session" is the same word in both languages
  if (session) parts.push(`session ${session}`)
  return parts.join(', ')
}

/** Search terms of an item (never displayed): the English ones, and the ones of the interface language when it is not English (#503). */
function keywordsOf(locale: Locale, id: string): string[] {
  const key = `palette.keywords.${id}` as MessageKey
  const en = translate('en', key).split('|')
  return locale === 'en' ? en : [...translate(locale, key).split('|'), ...en]
}

const PANEL_NAME_KEY = {
  files: 'palette.panelName.files',
  context: 'palette.panelName.context',
  system: 'palette.panelName.system',
  cost: 'palette.panelName.cost',
  timeline: 'palette.panelName.timeline',
  stats: 'palette.panelName.stats',
} as const satisfies Record<string, MessageKey>

/** Name of a panel in the language: Conversation is the same word in both. */
export function panelName(locale: Locale, id: keyof typeof PANEL_NAMES): string {
  return id === 'conversation' ? PANEL_NAMES.conversation : tr(locale, PANEL_NAME_KEY[id])
}

/** Heading of a group; Actions, Sessions and Agents are the same word in both languages. */
export function paletteGroupName(group: PaletteGroup, locale: Locale): string {
  if (group === 'Panels') return tr(locale, 'palette.group.panels')
  if (group === 'Themes') return tr(locale, 'palette.group.themes')
  return group
}

export function buildPaletteItems(src: PaletteSource): PaletteItem[] {
  const items: PaletteItem[] = []
  const { actions: act } = src
  const locale = src.locale ?? 'en'
  const foreign = locale !== 'en'
  // The English name stays searchable in French, next to the English terms; the English interface is searched as before
  const extra = (key: MessageKey, params?: Record<string, string | number>): string[] => (foreign ? [tr('en', key, params)] : [])
  const action = (id: string, key: MessageKey, run: () => void, shortcut: string | undefined, movesFocus = false, detail?: string, kwId = id) => {
    items.push({ id: `action:${id}`, group: 'Actions', label: tr(locale, key), detail, shortcut: shortcut ? shortcutOf(shortcut, src.singleKeyEnabled) : undefined, keywords: [...keywordsOf(locale, kwId), ...extra(key)], movesFocus, sensitive: false, run })
  }
  // What needs the user comes first; its detail is the top bar counter text, nothing more (#377)
  if (src.attention) {
    action('next-attention', 'palette.action.attention', src.attention.run, undefined, src.attention.movesFocus, src.attention.detail || undefined)
  }
  action('play', 'palette.action.play', act.togglePlayPause, ' ')
  action('fit', 'palette.action.fit', act.zoomToFit, 'F')
  action('fullscreen', 'palette.action.fullscreen', act.toggleFullscreen, 'z', true)
  if (act.togglePresentation) action('presentation', 'palette.action.presentation', act.togglePresentation, 'v')
  action('grid', 'palette.action.grid', act.toggleHexGrid, 'g')
  action('mute', 'palette.action.mute', act.toggleMute, 'm')
  if (act.exportSession) action('export', 'palette.action.export', act.exportSession, undefined)
  if (act.clearHistory) action('clear-history', 'palette.action.clear', act.clearHistory, undefined)
  if (src.notifications) {
    action('notifications', src.notifications.on ? 'palette.action.notifyOff' : 'palette.action.notifyOn', src.notifications.run, undefined)
  }
  if (src.tour) {
    // The label comes from the guided tour, which is not translated yet: it declares its own language
    items.push({
      id: 'action:tour', group: 'Actions', label: src.tour.label, shortcut: undefined, lang: foreign ? 'en' : undefined,
      keywords: keywordsOf(locale, 'tour'), movesFocus: true, sensitive: false, run: src.tour.run,
    })
  }
  action('shortcuts', 'palette.action.shortcuts', act.openShortcuts, '?')
  action('settings', 'palette.action.settings', act.openSettings, ',')

  // Launching stays in the agent card (its issues labelled agent:<role>, each with its Launch button and confirmation):
  // these entries open the card of the first agent of each role and session. Nothing says an issue is open (#377)
  const agents = Array.from(src.agents)
  if (src.launchAvailable) {
    const seen = new Set<string>()
    for (const a of agents) {
      const role = cleanLine(a.role, MAX_LABEL)
      const name = cleanLine(a.name, MAX_LABEL)
      const key = `${a.sessionId}\n${role}`
      if (!role || !name || seen.has(key)) continue
      seen.add(key)
      const session = cleanLine(a.sessionLabel, MAX_LABEL)
      items.push({
        id: `launch:${a.sessionId}:${role}`, group: 'Actions', label: tr(locale, 'palette.launch.label', { role }),
        detail: `${tr(locale, 'palette.launch.detail', { name })}${session ? `, session ${session}` : ''}`,
        keywords: [...keywordsOf(locale, 'launch'), ...extra('palette.launch.label', { role })], movesFocus: true, sensitive: true, run: () => src.selectAgent(a.id),
      })
    }
  }

  const panel = (id: PalettePanel, key: MessageKey, name: keyof typeof PANEL_NAMES | 'sessions', shortcut: string) => {
    const params = (l: Locale) => ({ name: name === 'sessions' ? tr(l, 'sessions.title') : panelName(l, name) })
    items.push({
      id: `panel:${id}`, group: 'Panels', label: tr(locale, key, params(locale)), shortcut: shortcutOf(shortcut, src.singleKeyEnabled),
      keywords: [...keywordsOf(locale, id), ...extra(key, params('en'))], movesFocus: true, sensitive: false, run: () => src.togglePanel(id),
    })
  }
  panel('sessions', 'palette.panel.toggleList', 'sessions', 'l')
  panel('files', 'palette.panel.toggle', 'files', 'f')
  panel('conversation', 'palette.panel.toggle', 'conversation', 'c')
  panel('timeline', 'palette.panel.toggle', 'timeline', 't')
  panel('context', 'palette.panel.toggle', 'context', 'p')
  panel('system', 'palette.panel.toggle', 'system', 'y')
  panel('stats', 'palette.panel.toggle', 'stats', 's')
  panel('cost', 'palette.panel.toggleOverlay', 'cost', '$')

  items.push({
    id: `session:${ALL_SESSIONS_ID}`, group: 'Sessions', label: tr(locale, 'sessions.allSessions'),
    keywords: [...keywordsOf(locale, 'all-sessions'), ...extra('sessions.allSessions')],
    detail: src.selectedSessionId === ALL_SESSIONS_ID ? tr(locale, 'palette.currentView') : undefined,
    movesFocus: false, sensitive: false, run: () => src.selectSession(ALL_SESSIONS_ID),
  })
  for (const s of src.sessions) {
    const label = cleanLine(s.label, MAX_LABEL) || cleanLine(s.id, MAX_LABEL)
    if (!label) continue
    const detail = [sessionDetail(s, locale), s.id === src.selectedSessionId ? tr(locale, 'palette.currentView') : ''].filter(Boolean).join(', ')
    items.push({
      id: `session:${s.id}`, group: 'Sessions', label, detail: detail || undefined,
      keywords: [cleanLine(s.workspace, 200), cleanLine(s.cwd, 200), cleanLine(s.teamName), cleanLine(s.memberName)].filter(Boolean),
      movesFocus: false, sensitive: true, run: () => src.selectSession(s.id),
    })
  }

  for (const a of agents) {
    const label = cleanLine(a.name, MAX_LABEL)
    if (!label) continue
    items.push({
      id: `agent:${a.id}`, group: 'Agents', label, detail: agentDetail(a, locale) || undefined,
      keywords: [], movesFocus: true, sensitive: true, run: () => src.selectAgent(a.id),
    })
  }

  if (src.themes) {
    const { current, set } = src.themes
    for (const t of src.themes.options) {
      items.push({
        id: `theme:${t.id}`, group: 'Themes', label: tr(locale, 'palette.theme.name', { label: t.label }), detail: t.id === current ? tr(locale, 'palette.theme.current') : undefined,
        keywords: [...keywordsOf(locale, 'theme'), ...extra('palette.theme.name', { label: t.alias ?? t.label })],
        movesFocus: false, sensitive: false, run: () => set(t.id),
      })
    }
  }
  return items
}

// Search

export interface PaletteSection {
  group: PaletteGroup
  items: PaletteItem[]
  /** Matching items left out by the per-group cap */
  hidden: number
}

export const PALETTE_GROUP_LIMIT = 8

/** Lower case without accents: "evenements" finds "événements" (#503). */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function terms(query: string): string[] {
  return fold(query.trim()).split(/\s+/).filter(Boolean)
}

/** 0 exact label, 1 label prefix, 2 label word start, 3 label contains, 4 detail or keyword only. */
function rank(item: PaletteItem, query: string): number {
  const q = fold(query.trim())
  const label = fold(item.label)
  if (label === q) return 0
  if (label.startsWith(q)) return 1
  if (label.includes(` ${q}`)) return 2
  if (label.includes(q)) return 3
  return 4
}

export function searchPalette(items: ReadonlyArray<PaletteItem>, query: string, perGroup = PALETTE_GROUP_LIMIT): PaletteSection[] {
  const ts = terms(query)
  const sections: PaletteSection[] = []
  for (const group of PALETTE_GROUPS) {
    const inGroup = items.filter(i => i.group === group)
    const matches = ts.length === 0
      ? inGroup
      : inGroup
        .filter(i => {
          const hay = fold([i.label, i.detail ?? '', ...i.keywords].join('\n'))
          return ts.every(t => hay.includes(t))
        })
        .map((item, order) => ({ item, order, score: rank(item, query) }))
        .sort((a, b) => a.score - b.score || a.order - b.order)
        .map(x => x.item)
    if (matches.length === 0) continue
    sections.push({ group, items: matches.slice(0, perGroup), hidden: Math.max(0, matches.length - perGroup) })
  }
  return sections
}

/** The line announced after each search: the real count, and what the cap left out. */
export function paletteStatus(sections: ReadonlyArray<PaletteSection>, locale: Locale = 'en'): string {
  const shown = sections.reduce((n, s) => n + s.items.length, 0)
  const hidden = sections.reduce((n, s) => n + s.hidden, 0)
  if (shown === 0) return tr(locale, 'palette.none')
  // French counts 0 and 1 as singular, as the language does
  const form = new Intl.PluralRules(locale).select(shown) === 'one' ? 'one' : 'other'
  return tr(locale, (hidden === 0 ? `palette.count.${form}` : `palette.shown.${form}`) as MessageKey, { n: shown, hidden })
}
