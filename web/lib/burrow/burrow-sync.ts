/**
 * Burrow view: makes the scene follow the agents. Called with the simulation's agents when they may have changed
 * (syncDue); it acts only when what an agent is observed doing changed (a new room, present or not, a new bubble), so
 * the animals keep walking in between.
 */
import type { Agent, ToolCallNode } from '../agent-types'
import { visibleAgents } from '../inactive-agents'
import { deriveFreshness } from '../../hooks/simulation/freshness'
import type { SimulationState } from '../../hooks/simulation/types'
import type { BurrowEngine } from './burrow-engine'
import { placeAgent, pickAnimal, postureOf, type BurrowBubble, type BurrowPlacement } from './burrow-model'
import type { BurrowPosture, BurrowRoomId } from './burrow-types'
import { linksSignature, treeOrder } from './burrow-links'
import type { HealthVerdict } from '../loop-detection'
import { repeatMarks } from '../repeat-marks'
import { replayLostForAgents } from '../event-loss'
import type { TeamSummary } from '../agent-types'
import type { GroupKind } from '../ui-glossary'
import { colourOf, markerContext, teamOf } from './burrow-marker'

/** Most animals drawn at once: more would hide each other in a 560 x 315 px scene */
export const BURROW_MAX_ANIMALS = 24
const BUBBLE_SECONDS = 6

/**
 * Longest time the scene goes without following the agents when no event arrived: what changes with the clock alone
 * (an agent that turns stale, the stamps of the list) shows up within this delay.
 */
export const SYNC_INTERVAL_MS = 250

/**
 * Cheap fingerprint of what the scene follows: changes when an event is applied or dropped, an agent appears or goes,
 * or a link message arrives. Not with the clock (the simulation's time moves every frame).
 */
export function simFingerprint(sim: Pick<SimulationState, 'agents' | 'links' | 'eventIndex' | 'eventLog' | 'droppedEvents'> | null | undefined): string {
  if (!sim) return ''
  return `${sim.agents.size}|${sim.eventIndex}|${sim.eventLog?.length ?? 0}|${sim.droppedEvents}|${linksSignature(sim.links)}`
}

/** Whether the scene should follow the agents now: at once when the fingerprint changed, otherwise every SYNC_INTERVAL_MS */
export function syncDue(last: { at: number; fingerprint: string } | null, now: number, fingerprint: string): boolean {
  return last === null || fingerprint !== last.fingerprint || now - last.at >= SYNC_INTERVAL_MS
}

export type SyncAgent = Pick<Agent, 'id' | 'displayName' | 'state' | 'archived' | 'activity' | 'currentTool' | 'awaitingNextEvent' | 'kind'>
  & Pick<Agent, 'sessionId' | 'parentId'> & Partial<Pick<Agent, 'teamName' | 'teamKind' | 'teamColor' | 'clusterKey' | 'lastEventAt' | 'freshnessSource'>>

/** List order: the agents that wait for the user or failed first, then the ones running a tool, then the rest */
const attentionRank = (state: Agent['state']): number =>
  state === 'waiting_permission' ? 0 : state === 'error' ? 1 : state === 'tool_calling' ? 2 : 3

export interface BurrowRow {
  id: string
  name: string
  presence: BurrowPlacement['presence']
  room: BurrowRoomId
  state: Agent['state']
  /** Tool being run, when observed: the bubble is aria-hidden, so the list carries it */
  tool?: string
  /** Id of the running tool call the bubble names (the graph's ToolCallNode), only when it is proven: opens that call */
  toolCallId?: string
  /** The state is the last one known (silent, replayed or imported agent) */
  stale: boolean
  /** Parent agent key (null for a root agent): the list is in tree order, a sub-agent under its orchestrator */
  parentId: string | null
  /** Session of the agent: the list groups its rows by session when several are listed */
  sessionId: string
  /** Rank in the tree of the listed agents: 0 for a root, 1 for its sub-agents... */
  depth: number
  /** Sub-agents this agent sent that have not returned yet (observed dispatches without a return), when any */
  delegating?: number
  /** A loop is proven for this agent: the graph badges its node (repeatMarks, kind loop). Absent = no proof, never "no loop" */
  loop?: true
  /** Events the relay could not replay for this agent's session (a lower bound), when any: the graph qualifies its figures */
  replayLost?: number
  /** Colour of the ring on the floor under the animal (burrow-marker colourOf): absent when the view shows one session and no team */
  marker?: string
  /** Team or workflow whose halo holds the agent in the graph (its own, or the one its session hosts), when the rings are drawn */
  team?: { name: string; kind: GroupKind }
}

export interface BurrowSyncState {
  /** Last placement applied per agent id: what changed since is what the engine is told */
  applied: Map<string, string>
  started: boolean
}
export const createBurrowSyncState = (): BurrowSyncState => ({ applied: new Map(), started: false })

export interface BurrowSyncOptions {
  hideInactive: boolean
  selectedId: string | null
  /** Wall clock (ms): freshness of each agent is read at this instant, like the graph does */
  now: number
  /** Text of a bubble (tool name, translated state) */
  bubbleText: (b: BurrowBubble) => string
  /** Every new animal is already in the burrow (no walk through the door): reduced motion */
  instant?: boolean
  /** Per orchestrator: sub-agents it sent that have not returned yet (burrow-links openDelegations) */
  delegations?: ReadonlyMap<string, number>
  /** Tool calls of the simulation: the running call of an agent that runs a tool gives its row the id to open */
  toolCalls?: ReadonlyMap<string, Pick<ToolCallNode, 'agentId' | 'toolName' | 'state'>>
  /** Loop verdict per agent id, the graph's `health.byAgent` */
  health?: ReadonlyMap<string, HealthVerdict>
  /** Events the relay could not replay, per session id */
  replayLost?: ReadonlyMap<string, number>
  /** Teams of the simulation: a team colour missing on its members is read there, as the graph's halo does */
  teams?: ReadonlyMap<string, TeamSummary>
  max?: number
}

export interface BurrowSyncResult {
  rows: BurrowRow[]
  /** Agents that should be in the burrow but are not drawn because of the cap */
  hidden: number
  /** An animal was added, moved, sent out or given a bubble by this call: reduced motion draws again only then */
  changed: boolean
}

/** A state has no other proof on the floor than its bubble: it lasts as long as the state. A tool is proven by its room, so its bubble may end */
const keepsBubble = (b: BurrowBubble): boolean => b.kind === 'stale' || b.kind === 'waiting' || b.kind === 'state'
/** Claim on a place of the cap: a working agent takes the place of a finished animal first, then of an idle one */
const rank = (w: { a: SyncAgent; p: BurrowPlacement }): number => (w.p.presence === 'finished' ? 0 : w.a.state === 'idle' ? 1 : 2)

/** The running calls of each agent, by agent id */
function runningCalls(toolCalls: BurrowSyncOptions['toolCalls']): Map<string, Array<{ id: string; toolName: string }>> {
  const running = new Map<string, Array<{ id: string; toolName: string }>>()
  if (toolCalls) {
    for (const [id, c] of toolCalls) {
      if (c.state !== 'running') continue
      const list = running.get(c.agentId)
      if (list) list.push({ id, toolName: c.toolName })
      else running.set(c.agentId, [{ id, toolName: c.toolName }])
    }
  }
  return running
}

export function syncBurrow(engine: BurrowEngine, st: BurrowSyncState, agents: ReadonlyMap<string, SyncAgent>, opts: BurrowSyncOptions): BurrowSyncResult {
  const max = opts.max ?? BURROW_MAX_ANIMALS
  let changed = false
  // 'Show: active' hides exactly what the graph hides (workflow members, parents and the selected agent stay)
  const shown = visibleAgents(agents as unknown as Map<string, Agent>, opts.hideInactive, [opts.selectedId])
  const wanted: Array<{ a: SyncAgent; p: BurrowPlacement; filtered: boolean; posture: BurrowPosture }> = []
  for (const a of agents.values()) {
    const filtered = !shown.has(a.id)
    const stale = deriveFreshness(a, opts.now) === 'stale'
    // a filtered agent is not drawn: it walks out through the front door, and it is not listed (finished or not)
    wanted.push({
      a, p: filtered ? { presence: 'away', room: 'lounge', bubble: null } : placeAgent(a, { stale, delegating: opts.delegations?.get(a.id) }),
      filtered, posture: postureOf(a.state, stale),
    })
  }
  const ids = new Set(wanted.map((w) => w.a.id))
  // animals of agents that are gone from the data walk out for good
  for (const actor of engine.actors) if (!ids.has(actor.key)) { engine.removeActor(actor.key); st.applied.delete(actor.key); changed = true }
  for (const key of [...st.applied.keys()]) if (!engine.has(key) && !ids.has(key)) st.applied.delete(key)

  // already drawn first, then the busiest: the cap never takes an animal away from an agent that works
  const order = wanted.slice().sort((x, y) => Number(engine.has(y.a.id)) - Number(engine.has(x.a.id)) || rank(y) - rank(x))
  const used = new Set<string>(engine.actors.map((a) => a.sprite))
  const wantedAway = new Set(wanted.filter((w) => w.p.presence === 'away').map((w) => w.a.id))
  // an animal holds a place of the cap while it is in the burrow: not when it is outside, leaving or sent out
  const holdsPlace = (key: string): boolean => ids.has(key) && !wantedAway.has(key) && !engine.isGone(key)
  let drawn = engine.actors.filter((a) => holdsPlace(a.key)).length
  let hidden = 0
  // newcomers come in decreasing claim and the animals they could replace only get fewer: once none is found for a
  // claim, none will be for that claim or a lower one (with many agents beyond the cap, the search is not repeated)
  let noVictimUpTo = -1
  const instant = opts.instant === true || !st.started
  for (const { a, p, posture } of order) {
    if (!engine.has(a.id)) {
      if (p.presence === 'away') continue            // a filtered agent that was never drawn is not drawn now
      if (drawn >= max) {
        // a newcomer takes the place of a drawn animal that claims less (a finished one first, then an idle one); otherwise it is counted
        const me = rank({ a, p })
        const victim = me <= noVictimUpTo
          ? undefined
          : wanted.filter((w) => rank(w) < me && holdsPlace(w.a.id) && w.a.id !== opts.selectedId).sort((x, y) => rank(x) - rank(y))[0]
        if (!victim) { noVictimUpTo = Math.max(noVictimUpTo, me); hidden++; continue }
        engine.removeActor(victim.a.id); st.applied.delete(victim.a.id); drawn--
        wantedAway.add(victim.a.id)
      }
      const sprite = pickAnimal(a.id, used)
      used.add(sprite)
      engine.addActor(a.id, sprite, { inside: instant, room: p.room === 'lounge' ? undefined : p.room })
      drawn++
      st.applied.set(a.id, '')                       // forces the room and the bubble below
    }
    const bubble = p.bubble ? opts.bubbleText(p.bubble) : null
    const sig = `${p.presence}|${p.room}|${posture}|${bubble ?? ''}`
    if (st.applied.get(a.id) === sig) continue
    st.applied.set(a.id, sig)
    changed = true
    engine.setAvailable(a.id, p.presence !== 'away')
    engine.setPosture(a.id, posture)                // how it holds itself once in the lounge: the state, never at random
    engine.setResting(a.id, p.presence === 'finished')
    if (p.presence === 'in') {
      if (p.room === 'lounge') engine.release(a.id)
      else engine.assign(a.id, p.room)
    }
    engine.say(a.id, p.presence === 'in' ? bubble : null, p.bubble && keepsBubble(p.bubble) ? Number.POSITIVE_INFINITY : BUBBLE_SECONDS)
  }
  st.started = true
  const flat: Array<Omit<BurrowRow, 'depth'>> = []
  // the graph's own rule for its loop badge (a proven verdict with findings); the repeat ledger is not read here
  const marks = opts.health ? repeatMarks(opts.health, undefined, agents.keys()) : undefined
  // the rings tell apart the sessions and teams of the listed agents (a filtered one tells nothing apart)
  const running = runningCalls(opts.toolCalls)
  const ringCtx = markerContext(wanted.filter((w) => !w.filtered && engine.has(w.a.id)).map((w) => w.a), opts.teams)
  for (const { a, p, filtered } of wanted) {
    if (filtered || !engine.has(a.id)) continue   // filtered: not listed; not drawn (cap): counted in `hidden`
    const delegating = opts.delegations?.get(a.id) ?? 0
    const lost = replayLostForAgents(opts.replayLost, [a])
    const marker = colourOf(a, ringCtx)
    const team = teamOf(a, ringCtx)
    // the call to open is the one running call of this agent of the tool the bubble names: with two or more (parallel
    // calls, or an end that was lost) the bubble does not say which, and none is opened (never a guess)
    const bubbleTool = p.bubble?.kind === 'tool' ? p.bubble.tool : undefined
    const calls = bubbleTool !== undefined ? (running.get(a.id) ?? []).filter((c) => c.toolName === bubbleTool) : []
    const toolCallId = calls.length === 1 ? calls[0].id : undefined
    flat.push({
      id: a.id, name: a.displayName, presence: p.presence, room: p.room, state: a.state,
      ...(p.bubble?.kind === 'tool' ? { tool: p.bubble.tool } : {}), ...(toolCallId ? { toolCallId } : {}), stale: p.bubble?.kind === 'stale',
      parentId: a.parentId ?? null, sessionId: a.sessionId, ...(delegating > 0 ? { delegating } : {}),
      ...(marks?.get(a.id)?.kind === 'loop' ? { loop: true as const } : {}), ...(lost > 0 ? { replayLost: lost } : {}),
      ...(marker !== null ? { marker } : {}), ...(team ? { team } : {}),
    })
  }
  // attention first (stable: the order among equals is kept); the tree then puts each sub-agent under its parent
  flat.sort((x, y) => attentionRank(x.state) - attentionRank(y.state))
  return { rows: treeOrder(flat), hidden, changed }
}
