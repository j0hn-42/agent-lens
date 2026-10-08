import type { TeamSummary } from '@/lib/agent-types'
import type { SessionLink } from '@/lib/session-links'
import type { SimulationState, AgentLink } from '@/hooks/simulation/types'
import type { SessionMeta } from './index'

export interface CanvasProps {
  /** Identity of the selected tab (session id, 'all', team): a change refits the camera */
  scopeKey?: string
  /** Ref to simulation state — read every frame without React re-renders */
  simulationRef: React.RefObject<SimulationState>
  selectedAgentId: string | null
  hoveredAgentId: string | null
  showStats: boolean
  showHexGrid: boolean
  zoomToFitTrigger?: number
  pauseAutoFit?: boolean
  /** `modifiers.shiftKey` is set for a Shift-click (pair filter: click one agent, Shift-click another) */
  onAgentClick: (agentId: string | null, modifiers?: { shiftKey: boolean }) => void
  onAgentHover: (agentId: string | null) => void
  onAgentDrag: (agentId: string, x: number, y: number) => void
  onContextMenu: (e: React.MouseEvent, type: 'agent' | 'edge' | 'canvas', id?: string) => void
  onToolCallClick?: (toolCallId: string | null) => void
  selectedToolCallId?: string | null
  onDiscoveryClick?: (discoveryId: string | null) => void
  selectedDiscoveryId?: string | null
  showCostOverlay?: boolean
  /** Hide idle / complete agents (the selected agent and the parents of visible agents stay) */
  hideInactive?: boolean
  /** Communication links between agents (spawn / teammate). Defaults to the simulation's own links. */
  links?: Map<string, AgentLink>
  /** Agent Teams (halo colours, legend) */
  teams?: Map<string, TeamSummary>
  /** A link (edge or count badge) was clicked */
  onLinkClick?: (linkId: string) => void
  selectedLinkId?: string | null
  /** Facts about sessions the agents do not carry (workspace, label, runtime), keyed by session id: shown on the cluster labels */
  sessions?: ReadonlyMap<string, SessionMeta>
  /** Proven parent -> child links between sessions, drawn between the session halos of the 'All' view */
  sessionLinks?: ReadonlyArray<SessionLink>
  /**
   * A cluster label (or its outline entry) was activated: the canvas has already zoomed to the cluster;
   * the app can also select the session / team (e.g. its session tab).
   */
  onClusterSelect?: (cluster: { key: string; kind: 'session' | 'team'; sessionIds: string[]; teamName?: string }) => void
}
