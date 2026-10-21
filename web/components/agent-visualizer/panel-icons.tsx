/**
 * Icons of the seven panel buttons of the top bar (#523), drawn instead of their name at every width since the bar holds
 * on one line (owner request, 2026-10-21). Decorative: the button keeps its name (aria-label) and its tooltip, so each SVG is aria-hidden and out of
 * the Tab order. Stroked in currentColor, so they follow the button's text colour in every theme.
 */
import type { ReactNode } from 'react'

export type TopBarPanelId = 'files' | 'conversation' | 'context' | 'system' | 'cost' | 'timeline' | 'stats'

const PATHS: Record<TopBarPanelId, ReactNode> = {
  // A page with a folded corner
  files: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></>,
  // A speech bubble
  conversation: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  // A book (CLAUDE.md, memory)
  context: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /></>,
  // A chip
  system: <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" /></>,
  // A dollar sign
  cost: <><path d="M12 2v20" /><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>,
  // Bars along a time axis
  timeline: <path d="M3 21h18M4 6h9M8 11h11M5 16h7" />,
  // A bar chart
  stats: <path d="M4 20V11M10 20V4M16 20v-7M2 20h20" />,
}

/** The icon of a panel button (its name is the tooltip and the accessible name). */
export function PanelIcon({ panel }: { panel: TopBarPanelId }) {
  return (
    <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="block">
      {PATHS[panel]}
    </svg>
  )
}
