'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { COLORS, SCENE, getDiscoveryTypeColor } from '@/lib/colors'
import { LEGEND_OPEN_KEY, STATE_LABEL_SHORT } from '@/lib/canvas-constants'
import type { AgentState } from '@/lib/agent-types'
import { stateColor, CLAUDE_SPARK_D, OPENAI_LOGO_D, COPILOT_MARK_PATH, COPILOT_MARK_VIEWBOX, PI_MARK_PATH, PI_MARK_VIEWBOX, GEMINI_MARK_PATH, GEMINI_MARK_VIEWBOX, OPENCODE_MARK_PATH, OPENCODE_MARK_VIEWBOX } from './canvas/draw-misc'
import type { A11yTeamItem } from './canvas/a11y-model'
import { LearnMoreLink } from './learn-more-link'
import { LEGEND_ENTRIES, LEGEND_ENTRY_IDS, type LegendEntryId, type LegendSectionId } from '@/lib/legend-entries'
import { FOCUS_RING } from '@/lib/focus-ring'
import { TOUCH_TARGET } from '@/lib/mobile-view'
import { useTourBridge, GUIDED_TOUR_BUTTON_ID } from './guided-tour-context'
import { useTheme } from '@/lib/theme'
import { REPEAT_THRESHOLD, CYCLE_THRESHOLD } from '@/lib/loop-detection'
import { translate, type Locale, type MessageKey } from '@/lib/messages'

const STATES: AgentState[] = ['idle', 'thinking', 'tool_calling', 'waiting_permission', 'error', 'paused', 'complete']

const contextSegmentList = (): Array<{ id: LegendEntryId; color: string }> => [
  { id: 'ctx-system', color: SCENE.contextSystem },
  { id: 'ctx-user', color: SCENE.contextUser },
  { id: 'ctx-tool-results', color: SCENE.contextToolResults },
  { id: 'ctx-reasoning', color: SCENE.contextReasoning },
  { id: 'ctx-subagent', color: SCENE.contextSubagent },
]

const DISCOVERY_TYPES: readonly string[] = ['file', 'pattern', 'finding', 'code']

function hexPoints(r: number, cx: number, cy: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`
  }).join(' ')
}

/** The entries the legend lists; null = all of them (nothing is known about the scene, or the complete reference is asked for) */
const ShownContext = createContext<ReadonlySet<LegendEntryId> | null>(null)
const useShown = (id: LegendEntryId) => { const shown = useContext(ShownContext); return shown === null || shown.has(id) }

function Row({ id, icon, children }: { id: LegendEntryId; icon: ReactNode; children: ReactNode }) {
  if (!useShown(id)) return null
  return (
    <li data-legend-entry={id} className="flex items-center gap-2 min-h-5">
      {/* The icons reproduce what the canvas draws, so they keep the scene colours (the canvas does not follow the theme) on a scene-ground tile that stays legible on a light panel */}
      <span className="flex w-7 shrink-0 items-center justify-center rounded-sm" style={{ background: SCENE.void, color: SCENE.textPrimary }} aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </li>
  )
}

/** A heading and its list, only when at least one entry of the section is listed */
function Section({ section, title, children }: { section: LegendSectionId; title: string; children: ReactNode }) {
  const shown = useContext(ShownContext)
  if (shown !== null && !LEGEND_ENTRIES[section].some(id => shown.has(id))) return null
  return (
    <>
      <h3 data-tour-target={`legend-${section}`} className="mt-2 mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.textMuted }}>{title}</h3>
      <ul>{children}</ul>
    </>
  )
}

/** The loop / repeat badge of the canvas (draw-agents.ts, drawRepeatBadge): same disc, same glyphs (#377) */
function RepeatBadgeIcon({ kind }: { kind: 'loop' | 'repeated' }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" fill={SCENE.cardBgDark} stroke={SCENE.warn} strokeWidth="1.5" />
      {kind === 'loop' ? (
        <>
          <path d="M14.5 7.67 A5 5 0 1 1 9.5 7.67" fill="none" stroke={SCENE.warn} strokeWidth="1.6" strokeLinecap="round" />
          <polygon points="12.1,6.2 10.1,9.7 8.1,6.2" fill={SCENE.warn} />
        </>
      ) : (
        <path d="M8 8.5 L11 12 L8 15.5 M13 8.5 L16 12 L13 15.5" fill="none" stroke={SCENE.warn} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  )
}

function Swatch({ color, round }: { color: string; round?: boolean }) {
  return <span className={`inline-block h-3 w-3 ${round ? 'rounded-full' : 'rounded-sm'}`} style={{ background: color }} />
}

/**
 * Collapsible legend of everything the canvas encodes: states, shapes, edges,
 * context segments, discovery types and runtimes. Lives in the DOM (not the canvas)
 * so it is readable at any zoom and by assistive technology (WCAG 1.4.1, 1.3.3).
 */
export function GraphLegend({ teams = [], present, locale = 'en' }: { teams?: A11yTeamItem[]; present?: readonly LegendEntryId[]; locale?: Locale }) {
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)
  const stateShort = (state: AgentState) => t(`legend.state.${state}.short` as MessageKey)
  const stateLong = (state: AgentState) => t(`legend.state.${state}.long` as MessageKey)
  // "(workflow, 3 agents)" / "(2 members)": the figure is the team's own, "workflow" is the same word in French, and both nouns follow the plural rule of the language
  const teamCount = (team: A11yTeamItem) => {
    const n = team.memberNames.length
    if (team.teamKind === 'workflow') return `workflow, ${t(new Intl.PluralRules(locale).select(n) === 'one' ? 'count.agent.one' : 'count.agent.other', { n })}`
    return t(new Intl.PluralRules(locale).select(n) === 'one' ? 'count.member.one' : 'count.member.other', { n })
  }
  const [open, setOpen] = useState(false)
  // State swatches show the canvas colours, which follow the theme (#381): re-render on a theme switch
  const [theme] = useTheme()
  // Complete reference on demand (not saved): the list otherwise holds the symbols that are on screen
  const [showAll, setShowAll] = useState(false)
  // The guided tour can show the legend without touching the saved preference (only toggle writes it)
  const { legendOpen: tourWantsOpen, legendShowAll, startTour, startTourLabel } = useTourBridge()
  const shown = open || tourWantsOpen
  // Not computed (no scene), asked for, or held complete by the guided demo: every entry
  const filtered = present !== undefined && !legendShowAll
  const listed = useMemo(() => (filtered && !showAll ? new Set(present) : null), [filtered, showAll, present])

  // Restore the preference after mount (keeps server and first client render identical)
  useEffect(() => {
    try {
      if (window.localStorage.getItem(LEGEND_OPEN_KEY) === '1') setOpen(true)
    } catch { /* storage unavailable (private window, blocked data) */ }
  }, [])

  const toggle = () => {
    // Held open by the tour only: a click could not collapse it, so it saves nothing either
    if (tourWantsOpen && !open) return
    setOpen(prev => {
      const next = !prev
      try { window.localStorage.setItem(LEGEND_OPEN_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  return (
    <div
      lang={locale}
      className="pointer-events-auto max-w-[calc(100vw-24px)] font-mono text-xs"
      style={{ color: COLORS.textPrimary }}
    >
      {shown && (
        <div
          id="graph-legend-panel"
          role="region"
          aria-label={t('legend.region')}
          className="mb-1 max-h-[40vh] w-64 sm:max-h-[60vh] max-w-full overflow-y-auto rounded-md p-3"
          style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.glassBorder}` }}
        >
          {filtered && (
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <p style={{ color: COLORS.textMuted }}>
                {showAll
                  ? t('legend.complete', { n: LEGEND_ENTRY_IDS.length })
                  : (present?.length ?? 0) === 0
                    ? t('legend.none')
                    // French counts 0 and 1 as singular, as the language does
                    : t(new Intl.PluralRules(locale).select(present!.length) === 'one' ? 'legend.onScreen.one' : 'legend.onScreen.other', { n: present!.length })}
              </p>
              <button
                type="button"
                aria-pressed={showAll}
                onClick={() => setShowAll(v => !v)}
                className={`inline-flex min-h-6 min-w-6 ${TOUCH_TARGET} items-center rounded-md px-2 py-1 text-[11px] ${FOCUS_RING}`}
                style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
              >
                {t('legend.showAll')}
              </button>
            </div>
          )}
          <ShownContext.Provider value={listed}>
          <Section section="states" title={t('legend.section.states')}>
            {STATES.map(state => (
              <Row key={state} id={`state-${state}` as LegendEntryId} icon={<Swatch color={stateColor(state, theme)} />}>
                {locale === 'en' ? (
                  <>
                    <span className="font-semibold">{stateShort(state)}</span>
                    {stateLong(state) !== stateShort(state) && <span style={{ color: COLORS.textMuted }}> ({stateLong(state)})</span>}
                  </>
                ) : (
                  // The canvas draws the English word under each agent and its accessibility tree announces it in English:
                  // the legend, the text equivalent of the colour, quotes the word as drawn, then glosses it (WCAG 1.4.1, 1.3.3)
                  <>
                    <span lang="en" data-i18n-exempt className="font-semibold">{STATE_LABEL_SHORT[state]}</span>
                    <span style={{ color: COLORS.textMuted }}> : {stateLong(state)}</span>
                  </>
                )}
              </Row>
            ))}
          </Section>

          <Section section="shapes" title={t('legend.section.shapes')}>
            <Row id="shape-main" icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(10, 12, 12)} fill="none" stroke={SCENE.holoBase} strokeWidth="1.5" /></svg>}>{t('legend.shape-main')}</Row>
            <Row id="shape-sub" icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(7, 12, 12)} fill="none" stroke={SCENE.holoBase} strokeWidth="1.5" /></svg>}>{t('legend.shape-sub')}</Row>
            <Row id="shape-tool" icon={<svg width="24" height="14" viewBox="0 0 24 14"><rect x="1" y="2" width="22" height="10" rx="2" fill="none" stroke={SCENE.tool} strokeWidth="1.5" /></svg>}>{t('legend.shape-tool')}</Row>
            <Row id="shape-discovery" icon={<svg width="24" height="14" viewBox="0 0 24 14"><rect x="1" y="2" width="22" height="10" rx="1" fill="none" stroke={SCENE.discoveryFile} strokeWidth="1" /><rect x="1" y="2" width="3" height="10" fill={SCENE.discoveryFile} /></svg>}>{t('legend.shape-discovery')}</Row>
            <Row id="shape-complete" icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(10, 12, 12)} fill="none" stroke={stateColor('complete', theme)} strokeWidth="1.5" strokeDasharray="3 3" /></svg>}>{t('legend.shape-complete')}</Row>
          </Section>

          <Section section="edges" title={t('legend.section.edges')}>
            <Row id="edge-parent" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.holoBase} strokeWidth="3" /></svg>}>{t('legend.edge-parent')}</Row>
            <Row id="edge-unverified" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.holoBase} strokeWidth="1.4" strokeDasharray="4 3" /></svg>}>{t('legend.edge-unverified')}</Row>
            <Row id="edge-tool" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.tool} strokeWidth="1.5" /></svg>}>{t('legend.edge-tool')}</Row>
            <Row id="edge-file-conflict" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.error} strokeWidth="1.75" strokeDasharray="5 2 1 2" /><polygon points="12,1.5 15.5,5 12,8.5 8.5,5" fill={SCENE.error} /></svg>}>{t('legend.edge-file-conflict')}</Row>
            <Row id="edge-badge-hidden" icon={<span className="rounded-full border px-1 text-[10px]" style={{ borderColor: SCENE.holoBase }}>+3</span>}>{t('legend.edge-badge-hidden')}</Row>
            <Row id="edge-badge-active" icon={<span className="inline-flex items-center gap-0.5 rounded-full border px-1 text-[10px]" style={{ borderColor: SCENE.complete }}><Swatch color={SCENE.complete} round />2</span>}>{t('legend.edge-badge-active')}</Row>
            <Row id="particle-dispatch" icon={<Swatch color={SCENE.dispatch} round />}>{t('legend.particle-dispatch')}</Row>
            <Row id="particle-return" icon={<Swatch color={SCENE.return} round />}>{t('legend.particle-return')}</Row>
          </Section>

          <Section section="teams" title={t('legend.section.teams')}>
            <Row id="team-ring" icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(8, 12, 12)} fill="none" stroke={SCENE.holoBase} strokeWidth="1.5" /><polygon points={hexPoints(10.5, 12, 12)} fill="none" stroke={SCENE.teamDefault} strokeWidth="2" /></svg>}>{t('legend.team-ring')}</Row>
            <Row id="team-idle" icon={<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="none" stroke={SCENE.holoBase} strokeWidth="2" /></svg>}>{t('legend.team-idle')}</Row>
            <Row id="team-working" icon={<svg width="24" height="24" viewBox="0 0 24 24"><path d="M12 6 A6 6 0 1 1 6 12" fill="none" stroke={SCENE.holoBase} strokeWidth="2" /></svg>}>{t('legend.team-working')}</Row>
            <Row id="team-done" icon={<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill={SCENE.holoBase} /></svg>}>{t('legend.team-done')}</Row>
            <Row id="team-archived" icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(9, 12, 12)} fill="none" stroke={SCENE.holoBase} strokeWidth="1.5" strokeDasharray="3 3" opacity="0.55" /></svg>}>{t('legend.team-archived')}</Row>
            <Row id="team-halo" icon={<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill={`${SCENE.teamDefault}1a`} stroke={SCENE.teamDefault} strokeWidth="1.5" strokeDasharray="4 3" /></svg>}>{t('legend.team-halo')}</Row>
            <Row id="session-halo" icon={<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke={SCENE.holoBase} strokeWidth="1.5" strokeDasharray="1 4" strokeLinecap="round" /></svg>}>{t('legend.session-halo')}</Row>
            <Row id="orchestrator" icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(10, 12, 12)} fill="none" stroke={SCENE.holoBase} strokeWidth="1.5" /><path d="M16 3 L16 7 L21 7 L21 3 L19.5 5 L18.5 2.5 L17.5 5 Z" fill={SCENE.crownAccent} /></svg>}>{t('legend.orchestrator')}</Row>
            {teams.map(team => (
              <Row key={team.key} id="team-row" icon={<Swatch color={team.color} round />}>
                <span className="font-semibold">{team.name}</span>
                <span style={{ color: COLORS.textMuted }}> ({teamCount(team)})</span>
              </Row>
            ))}
          </Section>

          <Section section="repeats" title={t('legend.section.repeats')}>
            <Row id="mark-loop" icon={<RepeatBadgeIcon kind="loop" />}>{t('legend.mark-loop', { repeat: REPEAT_THRESHOLD, cycle: CYCLE_THRESHOLD })}</Row>
            <Row id="mark-repeated" icon={<RepeatBadgeIcon kind="repeated" />}>{t('legend.mark-repeated', { rule: t('legend.repeatRule') })}</Row>
          </Section>

          <Section section="links" title={t('legend.section.links')}>
            <Row id="link-flight" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.dispatch} strokeWidth="3" strokeDasharray="6 3" /></svg>}>{t('legend.link-flight')}</Row>
            <Row id="link-recent" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.return} strokeWidth="2.5" /></svg>}>{t('legend.link-recent')}</Row>
            <Row id="link-error" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.error} strokeWidth="2.5" strokeDasharray="2 4" /></svg>}>{t('legend.link-error')}</Row>
            <Row id="link-quiet" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.holoBase} strokeWidth="1.75" opacity="0.5" /></svg>}>{t('legend.link-quiet')}</Row>
            <Row id="link-bubble" icon={<svg width="24" height="16" viewBox="0 0 24 16"><rect x="1" y="1" width="22" height="11" rx="2" fill="none" stroke={SCENE.dispatch} strokeWidth="1.5" /><line x1="8" y1="12" x2="8" y2="15" stroke={SCENE.dispatch} strokeWidth="1.5" /></svg>}>{t('legend.link-bubble')}</Row>
          </Section>

          <Section section="context" title={t('card.contextWindow')}>
            {contextSegmentList().map(seg => (
              <Row key={seg.id} id={seg.id} icon={<Swatch color={seg.color} />}>{t(`legend.${seg.id}` as MessageKey)}</Row>
            ))}
          </Section>

          <Section section="discoveries" title={t('legend.section.discoveries')}>
            {DISCOVERY_TYPES.map(type => (
              <Row key={type} id={`disc-${type}` as LegendEntryId} icon={<Swatch color={getDiscoveryTypeColor(type, SCENE)} />}>{t(`legend.disc-${type}` as MessageKey)}</Row>
            ))}
          </Section>

          <Section section="runtime" title={t('legend.section.runtime')}>
            <Row id="rt-claude" icon={<svg width="20" height="20" viewBox="0 0 512 512"><path d={CLAUDE_SPARK_D} fill={SCENE.holoBase} /></svg>}>{t('legend.rt-claude')}</Row>
            <Row id="rt-codex" icon={<svg width="20" height="20" viewBox="0 0 24 24"><path d={OPENAI_LOGO_D} fill={SCENE.holoBase} /></svg>}>{t('legend.rt-codex')}</Row>
            <Row id="rt-copilot" icon={<svg width="20" height="20" viewBox={`0 0 ${COPILOT_MARK_VIEWBOX} ${COPILOT_MARK_VIEWBOX}`}><path d={COPILOT_MARK_PATH} fill={SCENE.holoBase} /></svg>}>{t('legend.rt-copilot')}</Row>
            <Row id="rt-pi" icon={<svg width="20" height="20" viewBox={`0 0 ${PI_MARK_VIEWBOX} ${PI_MARK_VIEWBOX}`}><path d={PI_MARK_PATH} fill={SCENE.holoBase} /></svg>}>{t('legend.rt-pi')}</Row>
            <Row id="rt-gemini" icon={<svg width="20" height="20" viewBox={`0 0 ${GEMINI_MARK_VIEWBOX} ${GEMINI_MARK_VIEWBOX}`}><path d={GEMINI_MARK_PATH} fill={SCENE.holoBase} /></svg>}>{t('legend.rt-gemini')}</Row>
            <Row id="rt-opencode" icon={<svg width="20" height="20" viewBox={`0 0 ${OPENCODE_MARK_VIEWBOX} ${OPENCODE_MARK_VIEWBOX}`}><path d={OPENCODE_MARK_PATH} fill={SCENE.holoBase} /></svg>}>{t('legend.rt-opencode')}</Row>
          </Section>

          </ShownContext.Provider>

          <p className="mt-2 text-[11px]" style={{ color: COLORS.textMuted }}>
            {t('legend.footer')}{' '}<LearnMoreLink locale={locale} />
          </p>
        </div>
      )}
      {/* Sits on the playback bar: "Fit to view" keeps the content above it (issue 378) */}
      <div data-canvas-inset="bottom" className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={shown}
          aria-controls={shown ? "graph-legend-panel" : undefined}
          className={`inline-flex min-h-6 min-w-6 ${TOUCH_TARGET} items-center gap-1 rounded-md px-2 py-1 text-[11px] ${FOCUS_RING}`}
          style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
        >
          <span aria-hidden="true">{shown ? '▾' : '▸'}</span>
          {t('legend.name')}
        </button>
        {startTour && (
          <button
            id={GUIDED_TOUR_BUTTON_ID}
            // The tour and its label are not translated yet: the button declares its own language
            lang="en"
            data-i18n-exempt
            type="button"
            onClick={startTour}
            className={`inline-flex min-h-6 min-w-6 ${TOUCH_TARGET} items-center rounded-md px-2 py-1 text-[11px] ${FOCUS_RING}`}
            style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
          >
            {startTourLabel ?? 'Guided tour'}
          </button>
        )}
      </div>
    </div>
  )
}
