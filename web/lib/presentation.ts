/**
 * Presentation mode (#245): subtitles of transitions, masking of sensitive data, automatic follow.
 *
 * Pure (no React, no `window`), so it can be unit-tested with node:test. Principle of docs/reading-the-ui.md:
 * a subtitle only reports a state change that was observed live, the follow target is an agent whose activity was
 * observed live, and masking hides text instead of replacing it by a plausible value.
 */
import type { Agent, AgentState } from './agent-types'
import { getStateLabel, safeLabel } from './state-labels'
import { parseMcpTool } from './mcp-tool'

/** localStorage key of the three options (the mode itself is never stored: a page never starts in presentation) */
export const PRESENTATION_STORAGE_KEY = 'agent-lens:presentation'

export interface PresentationOptions {
  /** Caption of each state change observed live */
  subtitles: boolean
  /** Hide free text (prompts, paths, tool arguments, messages, session and team names) */
  mask: boolean
  /** The camera follows the agent that worked last */
  follow: boolean
}

/** Masking is on by default: a demo must be safe before it is configured */
export const DEFAULT_PRESENTATION_OPTIONS: PresentationOptions = { subtitles: true, mask: true, follow: true }

/** Stored blob -> options. Nothing is trusted: a value that is not a boolean falls back to its default; never throws. */
export function parsePresentationOptions(raw: string | null | undefined): PresentationOptions {
  if (!raw) return { ...DEFAULT_PRESENTATION_OPTIONS }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { ...DEFAULT_PRESENTATION_OPTIONS } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...DEFAULT_PRESENTATION_OPTIONS }
  const o = parsed as Record<string, unknown>
  const pick = (key: keyof PresentationOptions) => (typeof o[key] === 'boolean' ? (o[key] as boolean) : DEFAULT_PRESENTATION_OPTIONS[key])
  return { subtitles: pick('subtitles'), mask: pick('mask'), follow: pick('follow') }
}

export function serializePresentationOptions(options: PresentationOptions): string {
  return JSON.stringify({ subtitles: options.subtitles, mask: options.mask, follow: options.follow })
}

// ── Masking ─────────────────────────────────────────────────────────────────────

export const MASK_CHAR = '•'

/**
 * Hides every visible character and keeps the length and the spaces, so the layout (and the fact that there is
 * something) stays; the content does not. Idempotent.
 */
export function maskText(text: string | null | undefined): string {
  return typeof text === 'string' ? text.replace(/\S/gu, MASK_CHAR) : ''
}

/** The fields of a cluster label that carry free text, masked; counts and kinds are kept. */
export function maskedClusterLabelSource<T extends { title: string; workspace?: string; projectName?: string }>(c: T): T {
  return {
    ...c,
    title: maskText(c.title),
    workspace: c.workspace === undefined ? undefined : maskText(c.workspace),
    projectName: c.projectName === undefined ? undefined : maskText(c.projectName),
  }
}

/** A role, not a prompt: what an agent is called when names are masked. */
export function agentRoleLabel(agent: Pick<Agent, 'kind' | 'isMain' | 'parentId'>): string {
  if (agent.kind === 'teammate') return 'Teammate'
  if (agent.kind === 'subagent') return 'Sub-agent'
  if (agent.kind === 'main' || agent.isMain) return 'Main agent'
  return agent.parentId ? 'Sub-agent' : 'Main agent'
}

/** The agent as the canvas labels it when names are masked (same shape, no free text). */
export function maskedLabelAgent(agent: Agent): Agent {
  return { ...agent, name: maskText(agent.name), sessionLabel: agent.sessionLabel === undefined ? undefined : maskText(agent.sessionLabel) }
}

// ── Subtitles ───────────────────────────────────────────────────────────────────

export const MAX_SUBTITLE_LENGTH = 120
const MAX_NAME_LENGTH = 40

export interface AgentSnapshot {
  state: AgentState
  tool: string | undefined
}

export function snapshotOf(agent: Pick<Agent, 'state' | 'currentTool'>): AgentSnapshot {
  return { state: agent.state, tool: agent.state === 'tool_calling' ? agent.currentTool : undefined }
}

/** Was the last thing known about this agent seen live (not replayed, not imported, not absent)? */
export function observedLive(agent: Pick<Agent, 'lastEventAt' | 'freshnessSource'>): boolean {
  if (agent.freshnessSource === 'history' || agent.freshnessSource === 'imported') return false
  return typeof agent.lastEventAt === 'number'
}

function toolName(tool: string): string {
  const mcp = parseMcpTool(tool)
  return safeLabel(mcp ? mcp.tool : tool, 40) ?? ''
}

function describe(s: AgentSnapshot): string {
  const label = getStateLabel(s.state)
  const tool = s.state === 'tool_calling' && s.tool ? toolName(s.tool) : ''
  return tool ? `${label} ${tool}` : label
}

/**
 * Sentence for one transition, or null when there is nothing to say: no change, an agent whose activity was not
 * observed live (replayed history, imported transcript, never heard from). `prev` undefined = first sight of the
 * agent. With `mask` the agent is named by its role.
 */
export function transitionSubtitle(prev: AgentSnapshot | undefined, agent: Agent, mask: boolean): string | null {
  if (!observedLive(agent)) return null
  const next = snapshotOf(agent)
  const who = mask ? agentRoleLabel(agent) : (safeLabel(agent.name, MAX_NAME_LENGTH) ?? agentRoleLabel(agent))
  let text: string
  if (!prev) {
    text = `${who}: started (${describe(next)})`
  } else {
    if (prev.state === next.state && prev.tool === next.tool) return null
    text = `${who}: ${describe(prev)} → ${describe(next)}`
  }
  return text.length > MAX_SUBTITLE_LENGTH ? `${text.slice(0, MAX_SUBTITLE_LENGTH - 1)}…` : text
}

// ── Follow ──────────────────────────────────────────────────────────────────────

const WORKING: ReadonlySet<AgentState> = new Set(['thinking', 'tool_calling', 'waiting_permission'])

/** The agent to follow: the working one whose activity was observed live most recently (ties: smallest id). */
export function pickFollowAgent(agents: Iterable<Agent>): Agent | null {
  let best: Agent | null = null
  for (const a of agents) {
    if (a.archived || !WORKING.has(a.state) || !observedLive(a)) continue
    if (!best) { best = a; continue }
    const at = a.lastEventAt as number
    const bestAt = best.lastEventAt as number
    if (at > bestAt || (at === bestAt && a.id < best.id)) best = a
  }
  return best
}

export interface FollowInsets { top: number; right: number; bottom: number; left: number }

/** Camera transform that centres a world point in the free area of the viewport, zoom unchanged. */
export function followTransform(
  point: { x: number; y: number },
  current: { x: number; y: number; scale: number },
  dimensions: { width: number; height: number },
  insets: FollowInsets,
): { x: number; y: number; scale: number } {
  const freeW = Math.max(0, dimensions.width - insets.left - insets.right)
  const freeH = Math.max(0, dimensions.height - insets.top - insets.bottom)
  const cx = insets.left + freeW / 2
  const cy = insets.top + freeH / 2
  return { scale: current.scale, x: cx - point.x * current.scale, y: cy - point.y * current.scale }
}

export interface FollowState {
  targetId: string | null
  /** The user panned or zoomed since this target was picked */
  suspended: boolean
}

export const INITIAL_FOLLOW: FollowState = { targetId: null, suspended: false }

/**
 * One step of the follow rule. A manual pan or zoom suspends following until another agent becomes the target
 * (the camera never fights the person); with no working agent it stays where it is.
 */
export function stepFollow(state: FollowState, pickedId: string | null, manual: boolean): { state: FollowState; track: boolean } {
  let suspended = state.suspended
  if (pickedId !== state.targetId) suspended = false
  if (manual) suspended = true
  const next: FollowState = { targetId: pickedId, suspended }
  return { state: next, track: pickedId !== null && !suspended }
}
