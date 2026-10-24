/**
 * Guided tour of a REAL session (#244). The demo tour (guided-steps.ts) replays a scripted scenario; here the
 * steps are built from what the canvas proves is on screen (legend-presence.ts), so the tour explains the
 * symbols you can see and never mentions one that is absent. A step has no scenario time: the scene stays live.
 * Runtime imports are relative (the root test runner has no "@/" alias).
 */
import type { TourStep } from './guided-steps'
import { LEGEND_ENTRIES, LEGEND_ENTRY_IDS, type LegendEntryId, type LegendSectionId } from './legend-entries'
import type { LegendPresence } from './legend-presence'
import { translate, type Locale, type MessageKey } from './messages'
import { cleanText } from '../components/agent-visualizer/canvas/team-style'
import { REPEAT_THRESHOLD, CYCLE_THRESHOLD } from './loop-detection'
import { REPEAT_RULE_TEXT } from './repeat-marks'

/** The sentence of a legend entry in a language (catalog keys tour.live.<entry>). It describes the symbol, never the session: the facts come from the presence. */
function liveEntryText(id: LegendEntryId, locale: Locale): string {
  const key = `tour.live.${id}` as MessageKey
  if (id === 'mark-loop') return translate(locale, key, { repeat: REPEAT_THRESHOLD, cycle: CYCLE_THRESHOLD })
  if (id === 'mark-repeated') return translate(locale, key, { rule: locale === 'en' ? REPEAT_RULE_TEXT : translate(locale, 'legend.repeatRule') })
  return translate(locale, key)
}

/** One sentence per legend entry, in English (the language the tests and the docs quote). Each one is written when
 * read: no table is loaded when this module is (#662), the entries load one before their first render. */
export const LIVE_ENTRY_TEXT: Readonly<Record<LegendEntryId, string>> = Object.defineProperties({} as Record<LegendEntryId, string>,
  Object.fromEntries(LEGEND_ENTRY_IDS.map(id => [id, { get: () => liveEntryText(id, 'en'), enumerable: true }])))

/** `title`: a word that is the same in every language (Sessions), so it has no catalog key */
interface Group { id: string; title?: string; entries: readonly LegendEntryId[] }

/** Every legend entry belongs to exactly one group; a group is a step when at least one of its entries is on screen. */
const GROUPS: readonly Group[] = [
  { id: 'agents', entries: ['shape-main', 'orchestrator', 'shape-sub', 'rt-claude', 'rt-codex', 'rt-copilot', 'rt-pi', 'rt-gemini', 'rt-opencode'] },
  { id: 'state-thinking', entries: ['state-thinking'] },
  { id: 'state-tool_calling', entries: ['state-tool_calling'] },
  { id: 'state-waiting_permission', entries: ['state-waiting_permission'] },
  { id: 'state-error', entries: ['state-error'] },
  { id: 'state-paused', entries: ['state-paused'] },
  { id: 'state-idle', entries: ['state-idle'] },
  { id: 'state-complete', entries: ['state-complete'] },
  { id: 'tools', entries: ['shape-tool', 'edge-tool'] },
  { id: 'finished', entries: ['shape-complete', 'team-archived'] },
  { id: 'hierarchy', entries: ['edge-parent', 'edge-unverified', 'particle-dispatch', 'particle-return'] },
  { id: 'folded', entries: ['edge-badge-hidden', 'edge-badge-active'] },
  { id: 'conflicts', entries: ['edge-file-conflict'] },
  { id: 'teams', entries: ['team-ring', 'team-working', 'team-idle', 'team-done', 'team-halo', 'team-row'] },
  { id: 'sessions', title: 'Sessions', entries: ['session-halo'] },
  { id: 'repeats', entries: ['mark-loop', 'mark-repeated'] },
  { id: 'links', entries: ['link-flight', 'link-recent', 'link-error', 'link-quiet', 'link-bubble'] },
  { id: 'context', entries: ['ctx-system', 'ctx-user', 'ctx-tool-results', 'ctx-reasoning', 'ctx-subagent'] },
  { id: 'discoveries', entries: ['shape-discovery', 'disc-file', 'disc-pattern', 'disc-finding', 'disc-code'] },
]

const sectionOf = (id: LegendEntryId): LegendSectionId =>
  (Object.keys(LEGEND_ENTRIES) as LegendSectionId[]).find(section => (LEGEND_ENTRIES[section] as readonly string[]).includes(id))!

/**
 * The steps of the tour of what is on screen now, in a fixed order. Frozen when the tour starts: a step whose
 * entries leave the scene is flagged by the caller (the card says it is no longer on screen), not rewritten.
 */
export function buildLiveTourSteps(presence: LegendPresence, locale: Locale = 'en'): TourStep[] {
  const present = new Set(presence.entries)
  const steps: TourStep[] = []
  for (const group of GROUPS) {
    const covers = group.entries.filter(id => present.has(id))
    if (covers.length === 0) continue
    const example = covers.find(id => presence.agentFor[id] !== undefined)
    const key = example ? presence.agentFor[example] : undefined
    const label = key ? cleanText(presence.labels[key], 40) : ''
    const sentences = covers.map(id => liveEntryText(id, locale)).join(' ')
    steps.push({
      id: group.id,
      title: group.title ?? translate(locale, `tour.group.${group.id}` as MessageKey),
      body: label ? `${sentences} ${translate(locale, 'tour.live.highlighted', { label })}` : sentences,
      covers,
      target: key ? { kind: 'agent-key', key } : { kind: 'dom', id: `legend-${sectionOf(covers[0])}` },
      ...(key ? {} : { opensLegend: true }),
    })
  }
  return steps
}
