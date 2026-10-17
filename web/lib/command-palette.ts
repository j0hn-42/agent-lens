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
import { HIERARCHY_TERMS, PANEL_NAMES, SESSIONS_LIST_NAME } from './ui-glossary'

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
  /** Extra search terms (never displayed) */
  keywords: readonly string[]
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
  themes?: { current: string; options: ReadonlyArray<{ id: string; label: string }>; set: (id: string) => void }
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

/** What the session list recorded about a session, nothing inferred. */
export function sessionDetail(s: SessionInfo): string {
  const parts: string[] = []
  const runtime = runtimeBadge(s.runtime)
  if (runtime) parts.push(runtime.label)
  const project = cleanLine(s.projectName, MAX_LABEL)
  if (project) parts.push(project)
  const branch = cleanLine(s.branch, MAX_LABEL)
  if (branch) parts.push(branch)
  if (s.imported) parts.push(SESSION_IMPORTED_TEXT)
  else if (s.indexedOnly) parts.push(SESSION_INDEXED_TEXT)
  else if (s.status === 'completed') parts.push('finished')
  return parts.join(', ')
}

const KIND_TEXT = {
  main: HIERARCHY_TERMS.main,
  subagent: HIERARCHY_TERMS.subagent,
  teammate: HIERARCHY_TERMS.teammate,
} as const

/** Role and session of an agent. Its state is left out: it may be older than the screen. */
export function agentDetail(a: PaletteAgent): string {
  const parts: string[] = []
  const kind = a.kind ?? (a.isMain ? 'main' : undefined)
  if (kind) parts.push(KIND_TEXT[kind])
  const session = cleanLine(a.sessionLabel, MAX_LABEL)
  if (session) parts.push(`session ${session}`)
  return parts.join(', ')
}

export function buildPaletteItems(src: PaletteSource): PaletteItem[] {
  const items: PaletteItem[] = []
  const { actions: act } = src
  const action = (id: string, label: string, run: () => void, key: string | undefined, keywords: string[] = [], movesFocus = false, detail?: string) => {
    items.push({ id: `action:${id}`, group: 'Actions', label, detail, shortcut: key ? shortcutOf(key, src.singleKeyEnabled) : undefined, keywords, movesFocus, sensitive: false, run })
  }
  // What needs the user comes first; its detail is the top bar counter text, nothing more (#377)
  if (src.attention) {
    action('next-attention', 'Go to the next agent that needs you', src.attention.run, undefined,
      ['waiting', 'permission', 'blocked', 'error', 'attention', 'answer'], src.attention.movesFocus, src.attention.detail || undefined)
  }
  action('play', 'Play / pause', act.togglePlayPause, ' ', ['resume', 'review', 'live'])
  action('fit', 'Zoom to fit all agents', act.zoomToFit, 'F', ['view', 'center'])
  action('fullscreen', 'Toggle full screen', act.toggleFullscreen, 'z', ['immersive'], true)
  if (act.togglePresentation) action('presentation', 'Toggle presentation mode', act.togglePresentation, 'v', ['present', 'demo', 'mask', 'subtitles', 'screen share'])
  action('grid', 'Toggle hex grid', act.toggleHexGrid, 'g', ['background'])
  action('mute', 'Mute / unmute audio', act.toggleMute, 'm', ['sound'])
  if (act.exportSession) action('export', 'Export this session as an HTML replay', act.exportSession, undefined, ['download', 'save', 'share', 'replay', 'file'])
  if (act.clearHistory) action('clear-history', 'Clear history', act.clearHistory, undefined, ['reset', 'forget', 'restart', 'timeline'])
  if (src.notifications) {
    action('notifications', src.notifications.on ? 'Turn notifications off' : 'Turn notifications on', src.notifications.run, undefined,
      ['notify', 'alert', 'browser'])
  }
  if (src.tour) action('tour', src.tour.label, src.tour.run, undefined, ['tour', 'onboarding', 'help', 'learn', 'legend', 'guide'], true)
  action('shortcuts', 'Show keyboard shortcuts', act.openShortcuts, '?', ['help', 'keys'])
  action('settings', 'Open settings', act.openSettings, ',', ['preferences', 'theme', 'notifications'])

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
        id: `launch:${a.sessionId}:${role}`, group: 'Actions', label: `Launch an agent on an issue labelled agent:${role}`,
        detail: `from the card of ${name}${session ? `, session ${session}` : ''}`,
        keywords: ['launch', 'start', 'run', 'spawn', 'issue', 'new agent'], movesFocus: true, sensitive: true, run: () => src.selectAgent(a.id),
      })
    }
  }

  const panel = (id: PalettePanel, label: string, key: string | undefined, keywords: string[] = []) => {
    items.push({
      id: `panel:${id}`, group: 'Panels', label, shortcut: key ? shortcutOf(key, src.singleKeyEnabled) : undefined,
      keywords, movesFocus: true, sensitive: false, run: () => src.togglePanel(id),
    })
  }
  panel('sessions', `Toggle ${SESSIONS_LIST_NAME} list`, 'l', ['agents'])
  panel('files', `Toggle ${PANEL_NAMES.files} panel`, 'f', ['conflicts', 'edits', 'repeated reads and calls', 'waste'])
  panel('conversation', `Toggle ${PANEL_NAMES.conversation} panel`, 'c', ['messages', 'chat'])
  panel('timeline', `Toggle ${PANEL_NAMES.timeline} panel`, 't', ['events'])
  panel('context', `Toggle ${PANEL_NAMES.context} panel`, 'p', ['claude.md', 'memory', 'issues'])
  panel('system', `Toggle ${PANEL_NAMES.system} panel`, 'y', ['cpu', 'memory', 'ram', 'swap', 'disk', 'load', 'machine'])
  panel('stats', `Toggle ${PANEL_NAMES.stats} panel`, 's', ['statistics'])
  panel('cost', `Toggle ${PANEL_NAMES.cost} overlay`, '$', ['tokens', 'spend'])

  items.push({
    id: `session:${ALL_SESSIONS_ID}`, group: 'Sessions', label: 'All sessions', keywords: ['union', 'fleet'],
    detail: src.selectedSessionId === ALL_SESSIONS_ID ? 'current view' : undefined,
    movesFocus: false, sensitive: false, run: () => src.selectSession(ALL_SESSIONS_ID),
  })
  for (const s of src.sessions) {
    const label = cleanLine(s.label, MAX_LABEL) || cleanLine(s.id, MAX_LABEL)
    if (!label) continue
    const detail = [sessionDetail(s), s.id === src.selectedSessionId ? 'current view' : ''].filter(Boolean).join(', ')
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
      id: `agent:${a.id}`, group: 'Agents', label, detail: agentDetail(a) || undefined,
      keywords: [], movesFocus: true, sensitive: true, run: () => src.selectAgent(a.id),
    })
  }

  if (src.themes) {
    const { current, set } = src.themes
    for (const t of src.themes.options) {
      items.push({
        id: `theme:${t.id}`, group: 'Themes', label: `Theme: ${t.label}`, detail: t.id === current ? 'current theme' : undefined,
        keywords: ['appearance', 'colors', 'colours'], movesFocus: false, sensitive: false, run: () => set(t.id),
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

function terms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** 0 exact label, 1 label prefix, 2 label word start, 3 label contains, 4 detail or keyword only. */
function rank(item: PaletteItem, query: string): number {
  const q = query.trim().toLowerCase()
  const label = item.label.toLowerCase()
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
          const hay = [i.label, i.detail ?? '', ...i.keywords].join('\n').toLowerCase()
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
export function paletteStatus(sections: ReadonlyArray<PaletteSection>): string {
  const shown = sections.reduce((n, s) => n + s.items.length, 0)
  const hidden = sections.reduce((n, s) => n + s.hidden, 0)
  if (shown === 0) return 'No matching commands'
  const noun = shown === 1 ? 'result' : 'results'
  return hidden === 0 ? `${shown} ${noun}` : `${shown} ${noun} shown, ${hidden} more: keep typing to narrow`
}
