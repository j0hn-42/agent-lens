/**
 * Burrow view: makes the scene follow the agents. Called every frame with the simulation's agents; it acts only when
 * what an agent is observed doing changed (a new room, present or not, a new bubble), so the animals keep walking in between.
 */
import type { Agent } from '../agent-types'
import { visibleAgents } from '../inactive-agents'
import { deriveFreshness } from '../../hooks/simulation/freshness'
import type { BurrowEngine } from './burrow-engine'
import { placeAgent, pickAnimal, type BurrowBubble, type BurrowPlacement } from './burrow-model'
import type { BurrowRoomId } from './burrow-types'
import { treeOrder } from './burrow-links'

/** Most animals drawn at once: more would hide each other in a 560 x 315 px scene */
export const BURROW_MAX_ANIMALS = 24
const BUBBLE_SECONDS = 6

export type SyncAgent = Pick<Agent, 'id' | 'displayName' | 'state' | 'archived' | 'activity' | 'currentTool' | 'awaitingNextEvent' | 'kind'>
  & Pick<Agent, 'sessionId' | 'parentId'> & Partial<Pick<Agent, 'teamName' | 'teamKind' | 'clusterKey' | 'lastEventAt' | 'freshnessSource'>>

export interface BurrowRow {
  id: string
  name: string
  presence: BurrowPlacement['presence']
  room: BurrowRoomId
  state: Agent['state']
  /** Tool being run, when observed: the bubble is aria-hidden, so the list carries it */
  tool?: string
  /** The state is the last one known (silent, replayed or imported agent) */
  stale: boolean
  /** Parent agent key (null for a root agent): the list is in tree order, a sub-agent under its orchestrator */
  parentId: string | null
  /** Rank in the tree of the listed agents: 0 for a root, 1 for its sub-agents... */
  depth: number
  /** Sub-agents this agent sent that have not returned yet (observed dispatches without a return), when any */
  delegating?: number
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

export function syncBurrow(engine: BurrowEngine, st: BurrowSyncState, agents: ReadonlyMap<string, SyncAgent>, opts: BurrowSyncOptions): BurrowSyncResult {
  const max = opts.max ?? BURROW_MAX_ANIMALS
  let changed = false
  // 'Show: active' hides exactly what the graph hides (workflow members, parents and the selected agent stay)
  const shown = visibleAgents(agents as unknown as Map<string, Agent>, opts.hideInactive, [opts.selectedId])
  const wanted: Array<{ a: SyncAgent; p: BurrowPlacement; filtered: boolean }> = []
  for (const a of agents.values()) {
    const filtered = !shown.has(a.id)
    const stale = deriveFreshness(a, opts.now) === 'stale'
    // a filtered agent is not drawn: it walks out through the front door, and it is not listed (finished or not)
    wanted.push({ a, p: filtered ? { presence: 'away', room: 'lounge', bubble: null } : placeAgent(a, { stale, delegating: opts.delegations?.get(a.id) }), filtered })
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
  const instant = opts.instant === true || !st.started
  for (const { a, p } of order) {
    if (!engine.has(a.id)) {
      if (p.presence === 'away') continue            // a filtered agent that was never drawn is not drawn now
      if (drawn >= max) {
        // a newcomer takes the place of a drawn animal that claims less (a finished one first, then an idle one); otherwise it is counted
        const me = rank({ a, p })
        const victim = wanted.filter((w) => rank(w) < me && holdsPlace(w.a.id) && w.a.id !== opts.selectedId).sort((x, y) => rank(x) - rank(y))[0]
        if (!victim) { hidden++; continue }
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
    const sig = `${p.presence}|${p.room}|${bubble ?? ''}`
    if (st.applied.get(a.id) === sig) continue
    st.applied.set(a.id, sig)
    changed = true
    engine.setAvailable(a.id, p.presence !== 'away')
    engine.setResting(a.id, p.presence === 'finished')
    if (p.presence === 'in') {
      if (p.room === 'lounge') engine.release(a.id)
      else engine.assign(a.id, p.room)
    }
    engine.say(a.id, p.presence === 'in' ? bubble : null, p.bubble && keepsBubble(p.bubble) ? Number.POSITIVE_INFINITY : BUBBLE_SECONDS)
  }
  st.started = true
  const flat: Array<Omit<BurrowRow, 'depth'>> = []
  for (const { a, p, filtered } of wanted) {
    if (filtered || !engine.has(a.id)) continue   // filtered: not listed; not drawn (cap): counted in `hidden`
    const delegating = opts.delegations?.get(a.id) ?? 0
    flat.push({
      id: a.id, name: a.displayName, presence: p.presence, room: p.room, state: a.state,
      ...(p.bubble?.kind === 'tool' ? { tool: p.bubble.tool } : {}), stale: p.bubble?.kind === 'stale',
      parentId: a.parentId ?? null, ...(delegating > 0 ? { delegating } : {}),
    })
  }
  return { rows: treeOrder(flat), hidden, changed }
}
