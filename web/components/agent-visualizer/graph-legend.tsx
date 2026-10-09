'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { COLORS, SCENE, getDiscoveryTypeColor } from '@/lib/colors'
import { STATE_LABEL_SHORT, STATE_LABEL_LONG, LEGEND_OPEN_KEY } from '@/lib/canvas-constants'
import type { AgentState } from '@/lib/agent-types'
import { stateColor, CLAUDE_SPARK_D, OPENAI_LOGO_D } from './canvas/draw-misc'
import type { A11yTeamItem } from './canvas/a11y-model'
import { memberNoun } from '@/lib/ui-glossary'
import { LearnMoreLink } from './learn-more-link'
import type { LegendEntryId, LegendSectionId } from '@/lib/legend-entries'
import { useTourBridge, GUIDED_TOUR_BUTTON_ID } from './guided-tour-context'

const STATES: AgentState[] = ['idle', 'thinking', 'tool_calling', 'waiting_permission', 'error', 'paused', 'complete']

const contextSegmentList = (): Array<{ id: LegendEntryId; label: string; color: string }> => [
  { id: 'ctx-system', label: 'System prompt', color: SCENE.contextSystem },
  { id: 'ctx-user', label: 'User messages', color: SCENE.contextUser },
  { id: 'ctx-tool-results', label: 'Tool results', color: SCENE.contextToolResults },
  { id: 'ctx-reasoning', label: 'Reasoning', color: SCENE.contextReasoning },
  { id: 'ctx-subagent', label: 'Sub-agent results', color: SCENE.contextSubagent },
]

const DISCOVERY_TYPES: Array<{ type: string; label: string }> = [
  { type: 'file', label: 'File' },
  { type: 'pattern', label: 'Pattern' },
  { type: 'finding', label: 'Finding' },
  { type: 'code', label: 'Code' },
]

function hexPoints(r: number, cx: number, cy: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`
  }).join(' ')
}

function Row({ id, icon, children }: { id: LegendEntryId; icon: ReactNode; children: ReactNode }) {
  return (
    <li data-legend-entry={id} className="flex items-center gap-2 min-h-5">
      {/* The icons reproduce what the canvas draws, so they keep the scene colours (the canvas does not follow the theme) on a scene-ground tile that stays legible on a light panel */}
      <span className="flex w-7 shrink-0 items-center justify-center rounded-sm" style={{ background: SCENE.void, color: SCENE.textPrimary }} aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </li>
  )
}

function Heading({ section, children }: { section: LegendSectionId; children: ReactNode }) {
  return <h3 data-tour-target={`legend-${section}`} className="mt-2 mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.textMuted }}>{children}</h3>
}

function Swatch({ color, round }: { color: string; round?: boolean }) {
  return <span className={`inline-block h-3 w-3 ${round ? 'rounded-full' : 'rounded-sm'}`} style={{ background: color }} />
}

/**
 * Collapsible legend of everything the canvas encodes: states, shapes, edges,
 * context segments, discovery types and runtimes. Lives in the DOM (not the canvas)
 * so it is readable at any zoom and by assistive technology (WCAG 1.4.1, 1.3.3).
 */
export function GraphLegend({ teams = [] }: { teams?: A11yTeamItem[] }) {
  const [open, setOpen] = useState(false)
  // The guided tour can show the legend without touching the saved preference (only toggle writes it)
  const { legendOpen: tourWantsOpen, startTour } = useTourBridge()
  const shown = open || tourWantsOpen

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
      className="pointer-events-auto max-w-[calc(100vw-24px)] font-mono text-xs"
      style={{ color: COLORS.textPrimary }}
    >
      {shown && (
        <div
          id="graph-legend-panel"
          role="region"
          aria-label="Graph legend"
          className="mb-1 max-h-[40vh] w-64 sm:max-h-[60vh] max-w-full overflow-y-auto rounded-md p-3"
          style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.glassBorder}` }}
        >
          <Heading section="states">States</Heading>
          <ul>
            {STATES.map(state => (
              <Row key={state} id={`state-${state}` as LegendEntryId} icon={<Swatch color={stateColor(state)} />}>
                <span className="font-semibold">{STATE_LABEL_SHORT[state]}</span>
                {STATE_LABEL_LONG[state] !== STATE_LABEL_SHORT[state] && <span style={{ color: COLORS.textMuted }}> ({STATE_LABEL_LONG[state]})</span>}
              </Row>
            ))}
          </ul>

          <Heading section="shapes">Shapes</Heading>
          <ul>
            <Row id="shape-main" icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(10, 12, 12)} fill="none" stroke={SCENE.holoBase} strokeWidth="1.5" /></svg>}>Large hexagon: main agent</Row>
            <Row id="shape-sub" icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(7, 12, 12)} fill="none" stroke={SCENE.holoBase} strokeWidth="1.5" /></svg>}>Small hexagon: sub-agent</Row>
            <Row id="shape-tool" icon={<svg width="24" height="14" viewBox="0 0 24 14"><rect x="1" y="2" width="22" height="10" rx="2" fill="none" stroke={SCENE.tool} strokeWidth="1.5" /></svg>}>Rounded card: tool call</Row>
            <Row id="shape-discovery" icon={<svg width="24" height="14" viewBox="0 0 24 14"><rect x="1" y="2" width="22" height="10" rx="1" fill="none" stroke={SCENE.discoveryFile} strokeWidth="1" /><rect x="1" y="2" width="3" height="10" fill={SCENE.discoveryFile} /></svg>}>Card with colour bar: discovery</Row>
            <Row id="shape-complete" icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(10, 12, 12)} fill="none" stroke={SCENE.complete} strokeWidth="1.5" strokeDasharray="3 3" /></svg>}>Dashed outline: complete</Row>
          </ul>

          <Heading section="edges">Edges and particles</Heading>
          <ul>
            <Row id="edge-parent" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.holoBase} strokeWidth="3" /></svg>}>Thick line: parent to sub-agent (confirmed by the events)</Row>
            <Row id="edge-unverified" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.holoBase} strokeWidth="1.4" strokeDasharray="4 3" /></svg>}>Dashed line: parent link not verified</Row>
            <Row id="edge-tool" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.tool} strokeWidth="1.5" /></svg>}>Thin amber line: tool call</Row>
            <Row id="edge-badge-hidden" icon={<span className="rounded-full border px-1 text-[10px]" style={{ borderColor: SCENE.holoBase }}>+3</span>}>+N badge: N agents hidden in a folded branch (click to unfold)</Row>
            <Row id="edge-badge-active" icon={<span className="inline-flex items-center gap-0.5 rounded-full border px-1 text-[10px]" style={{ borderColor: SCENE.complete }}><Swatch color={SCENE.complete} round />2</span>}>Green badge: active agents in a folded branch</Row>
            <Row id="particle-dispatch" icon={<Swatch color={SCENE.dispatch} round />}>Purple dot: task dispatched</Row>
            <Row id="particle-return" icon={<Swatch color={SCENE.return} round />}>Green dot: result returned</Row>
          </ul>

          <Heading section="teams">Teams</Heading>
          <ul>
            <Row id="team-ring" icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(8, 12, 12)} fill="none" stroke={SCENE.holoBase} strokeWidth="1.5" /><polygon points={hexPoints(10.5, 12, 12)} fill="none" stroke={SCENE.teamDefault} strokeWidth="2" /></svg>}>Coloured outer ring: teammate (team colour)</Row>
            <Row id="team-idle" icon={<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="none" stroke={SCENE.holoBase} strokeWidth="2" /></svg>}>Hollow ring: teammate idle</Row>
            <Row id="team-working" icon={<svg width="24" height="24" viewBox="0 0 24 24"><path d="M12 6 A6 6 0 1 1 6 12" fill="none" stroke={SCENE.holoBase} strokeWidth="2" /></svg>}>Open arc: teammate working</Row>
            <Row id="team-done" icon={<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill={SCENE.holoBase} /></svg>}>Filled dot: teammate done</Row>
            <Row id="team-archived" icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(9, 12, 12)} fill="none" stroke={SCENE.holoBase} strokeWidth="1.5" strokeDasharray="3 3" opacity="0.55" /></svg>}>Faded dashed outline: archived agent (still clickable)</Row>
            <Row id="team-halo" icon={<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill={`${SCENE.teamDefault}1a`} stroke={SCENE.teamDefault} strokeWidth="1.5" strokeDasharray="4 3" /></svg>}>Dashed halo: team or workflow. Its label starts with Team or Workflow and names it; a finished workflow is drawn fainter</Row>
            <Row id="session-halo" icon={<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke={SCENE.holoBase} strokeWidth="1.5" strokeDasharray="1 4" strokeLinecap="round" /></svg>}>Dotted halo: session. Its label gives runtime, workspace, status and cost; click it to zoom to the cluster</Row>
            <Row id="orchestrator" icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(10, 12, 12)} fill="none" stroke={SCENE.holoBase} strokeWidth="1.5" /><path d="M16 3 L16 7 L21 7 L21 3 L19.5 5 L18.5 2.5 L17.5 5 Z" fill={SCENE.crownAccent} /></svg>}>Larger hexagon with a crown and a LEAD (team) or MAIN (session) badge: orchestrator</Row>
            {teams.map(team => (
              <Row key={team.key} id="team-row" icon={<Swatch color={team.color} round />}>
                <span className="font-semibold">{team.name}</span>
                <span style={{ color: COLORS.textMuted }}> ({team.teamKind === 'workflow' ? 'workflow, ' : ''}{team.memberNames.length} {memberNoun(team.teamKind, team.memberNames.length)})</span>
              </Row>
            ))}
          </ul>

          <Heading section="links">Message links</Heading>
          <ul>
            <Row id="link-flight" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.dispatch} strokeWidth="3" strokeDasharray="6 3" /></svg>}>Long dashes (purple): message in flight</Row>
            <Row id="link-recent" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.return} strokeWidth="2.5" /></svg>}>Solid green: recent message</Row>
            <Row id="link-error" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.error} strokeWidth="2.5" strokeDasharray="2 4" /></svg>}>Dotted red, badge starts with !: error</Row>
            <Row id="link-quiet" icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={SCENE.holoBase} strokeWidth="1.75" opacity="0.5" /></svg>}>Thin faded line: quiet link. Badge: message count. Click a link to read it</Row>
            <Row id="link-bubble" icon={<svg width="24" height="16" viewBox="0 0 24 16"><rect x="1" y="1" width="22" height="11" rx="2" fill="none" stroke={SCENE.dispatch} strokeWidth="1.5" /><line x1="8" y1="12" x2="8" y2="15" stroke={SCENE.dispatch} strokeWidth="1.5" /></svg>}>Bubble on a link: latest message (three lines). Click it to open the link panel</Row>
          </ul>

          <Heading section="context">Context usage</Heading>
          <ul>
            {contextSegmentList().map(seg => (
              <Row key={seg.label} id={seg.id} icon={<Swatch color={seg.color} />}>{seg.label}</Row>
            ))}
          </ul>

          <Heading section="discoveries">Discoveries</Heading>
          <ul>
            {DISCOVERY_TYPES.map(d => (
              <Row key={d.type} id={`disc-${d.type}` as LegendEntryId} icon={<Swatch color={getDiscoveryTypeColor(d.type, SCENE)} />}>{d.label}</Row>
            ))}
          </ul>

          <Heading section="runtime">Runtime</Heading>
          <ul>
            <Row id="rt-claude" icon={<svg width="20" height="20" viewBox="0 0 512 512"><path d={CLAUDE_SPARK_D} fill={SCENE.holoBase} /></svg>}>Spark logo: Claude</Row>
            <Row id="rt-codex" icon={<svg width="20" height="20" viewBox="0 0 24 24"><path d={OPENAI_LOGO_D} fill={SCENE.holoBase} /></svg>}>Knot logo: Codex</Row>
          </ul>

          <p className="mt-2 text-[11px]" style={{ color: COLORS.textMuted }}>
            Not observed, at least, estimated: <LearnMoreLink />
          </p>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={shown}
          aria-controls={shown ? "graph-legend-panel" : undefined}
          className="inline-flex min-h-6 min-w-6 items-center gap-1 rounded-md px-2 py-1 text-[11px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lens-focus-ring)]"
          style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
        >
          <span aria-hidden="true">{shown ? '▾' : '▸'}</span>
          Legend
        </button>
        {startTour && (
          <button
            id={GUIDED_TOUR_BUTTON_ID}
            type="button"
            onClick={startTour}
            className="inline-flex min-h-6 min-w-6 items-center rounded-md px-2 py-1 text-[11px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lens-focus-ring)]"
            style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
          >
            Guided tour
          </button>
        )}
      </div>
    </div>
  )
}
