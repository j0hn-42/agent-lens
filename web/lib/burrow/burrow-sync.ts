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
import { burrowRoomOfTool, placeAgent, pickAnimal, postureOf, type BurrowBubble, type BurrowPlacement } from './burrow-model'
import type { BurrowPosture, BurrowRoomId } from './burrow-types'
import { linksSignature, treeOrder } from './burrow-links'
import type { HealthVerdict } from '../loop-detection'
import { repeatMarks } from '../repeat-marks'
import { replayLostForAgents } from '../event-loss'
import type { TeamSummary } from '../agent-types'
import type { GroupKind } from '../ui-glossary'
import { colourOf, markerContext, teamOf } from './burrow-marker'
import { exitCodeOf, FAILED_ROW_MS } from './burrow-failure'

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
  & Pick<Agent, 'sessionId' | 'parentId'> & Partial<Pick<Agent, 'teamName' | 'teamKind' | 'teamColor' | 'clusterKey' | 'lastEventAt' | 'freshnessSource' | 'toolErrors'>>

/** What the burrow reads of a tool call: its agent, tool and state; for a failed one its text and times */
type SyncCall = Pick<ToolCallNode, 'agentId' | 'toolName' | 'state'> & Partial<Pick<ToolCallNode, 'errorMessage' | 'result' | 'startTime' | 'completeTime'>>

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
  /**
   * Whole minutes this agent has waited for you at the post beside the front door, counted from when the burrow first
   * saw it there (a lower bound), from one minute on
   */
  waited?: number
  /**
   * A tool call of this agent was seen failing in the last FAILED_ROW_MS: its tool and its exit code, each only when
   * received (the animal stumbles, the bubble is aria-hidden)
   */
  failed?: { tool?: string; exit?: number }
}

/** A tool call seen failing: when the burrow saw it (opts.now), its tool and its exit code when received */
export interface BurrowStumble { at: number; tool: string | undefined; exit: number | null }

export interface BurrowSyncState {
  /** Last placement applied per agent id: what changed since is what the engine is told */
  applied: Map<string, string>
  started: boolean
  /** Room of the last tool each agent was seen running, and when (opts.now): held while it thinks between two calls */
  lastRoom: Map<string, { room: BurrowRoomId; at: number }>
  /** Ids of the tool calls already seen; the first look only takes note of them (they have no time of reception) */
  callsSeen: Set<string>
  callsStarted: boolean
  /** Named calls received per agent, with their room and when they were first seen (opts.now), within the window */
  recent: Map<string, Array<{ id: string; room: BurrowRoomId; at: number }>>
  /** Room the animal stands in while it works: the dominant room of its recent calls (see dominantRoom) */
  dominant: Map<string, BurrowRoomId>
  /**
   * When the burrow first saw each agent waiting for you at the post beside the front door (opts.now; on the first look:
   * when the view opened). Dropped as soon as it no longer stands there.
   */
  waitSince: Map<string, number>
  /** Failure counter (Agent.toolErrors) of each agent at the last sync; absent = not seen yet (its first look) */
  toolErrors: Map<string, number>
  /** Ids of the failed calls already accounted for: a later failure never names one of them */
  failCredited: Set<string>
  /** The last failure seen per agent, kept FAILED_ROW_MS */
  stumbles: Map<string, BurrowStumble>
  /** When the burrow last followed the agents (opts.now), null before the first look */
  lastSyncAt: number | null
}
export const createBurrowSyncState = (): BurrowSyncState => ({
  applied: new Map(), started: false, lastRoom: new Map(), callsSeen: new Set(), callsStarted: false, recent: new Map(), dominant: new Map(),
  waitSince: new Map(), toolErrors: new Map(), failCredited: new Set(), stumbles: new Map(), lastSyncAt: null,
})

/** The animal follows the room of most of its calls of this last stretch of time, not each call */
const BURROW_CALL_WINDOW_MS = 10_000
/** Calls by which another room must lead the room the animal stands in to take it over (a near tie never moves it) */
const ROOM_LEAD = 2
/** Rooms whose calls are counted: the work rooms. The telephone and the front door are waits and take priority */
const WORK_ROOMS: ReadonlySet<BurrowRoomId> = new Set(['office', 'library', 'workshop', 'lab'])

/**
 * Longest time between two syncs after which what changed meanwhile is not "just seen": the burrow did not follow (a
 * background tab draws no frame), so a failure or a call of that gap only becomes the new baseline, like a first look
 */
export const SYNC_GAP_MS = FAILED_ROW_MS

/** A tool call seen starting since the last sync: the view flashes an object of its room (nothing on the first look) */
export interface ReceivedCall { id: string; agentId: string; room: BurrowRoomId }

/**
 * Takes note of the calls received since the last sync: each new named call joins its agent's recent calls (its time
 * is when it was first seen), and is returned for the flash. The first look only takes note of what is there. A call
 * first seen already finished counts only when its agent is live (`live`): the calls of a sub-agent are read from its
 * transcript in batches, start and end together, so they are never seen running; a replayed history counts for nothing.
 */
function receiveCalls(st: BurrowSyncState, toolCalls: BurrowSyncOptions['toolCalls'], now: number, live: (agentId: string) => boolean, gap: boolean): ReceivedCall[] {
  const out: ReceivedCall[] = []
  if (toolCalls) {
    for (const [id, c] of toolCalls) {
      if (st.callsSeen.has(id)) continue
      st.callsSeen.add(id)
      const room = burrowRoomOfTool(c.toolName)
      if (!st.callsStarted || gap || room === null || (c.state !== 'running' && !live(c.agentId))) continue
      out.push({ id, agentId: c.agentId, room })
      if (WORK_ROOMS.has(room)) {
        const list = st.recent.get(c.agentId)
        if (list) list.push({ id, room, at: now })
        else st.recent.set(c.agentId, [{ id, room, at: now }])
      }
    }
    for (const id of st.callsSeen) if (!toolCalls.has(id)) st.callsSeen.delete(id)
  }
  for (const [agentId, list] of st.recent) {
    const kept = list.filter((x) => now - x.at <= BURROW_CALL_WINDOW_MS)
    if (kept.length) st.recent.set(agentId, kept)
    else st.recent.delete(agentId)
  }
  st.callsStarted = true
  return out
}

/**
 * The work room the animal stands in: per room, the calls received for the agent in the window, and each call that
 * still runs (it counts as long as it runs). It stays in its room until another room leads it by ROOM_LEAD calls, or
 * its room has none left; a first call (or one after a rest) goes to the room with the most, the tool's own on a tie.
 */
function dominantRoom(p: BurrowPlacement, a: SyncAgent, st: BurrowSyncState, running: ReadonlyMap<string, ReadonlyArray<{ id: string; toolName: string }>>): BurrowPlacement {
  const counts = new Map<BurrowRoomId, number>()
  const add = (room: BurrowRoomId): void => { counts.set(room, (counts.get(room) ?? 0) + 1) }
  const recent = st.recent.get(a.id) ?? []
  for (const x of recent) add(x.room)
  for (const c of running.get(a.id) ?? []) {
    const room = burrowRoomOfTool(c.toolName)
    if (room && WORK_ROOMS.has(room) && !recent.some((x) => x.id === c.id)) add(room)
  }
  const working = WORK_ROOMS.has(p.room)
  if (working && !counts.get(p.room)) add(p.room)       // the tool it runs is observed, even when its call is not in the map
  // between two steps (p is the lounge): only the calls received count; with none, it stays where the state puts it
  if (counts.size === 0) return p
  const n = (room: BurrowRoomId | undefined): number => (room ? counts.get(room) ?? 0 : 0)
  let best: BurrowRoomId = working ? p.room : [...counts.keys()][0]
  for (const [room] of counts) if (n(room) > n(best)) best = room
  const current = st.dominant.get(a.id)
  const room = current && n(current) > 0 && n(best) < n(current) + ROOM_LEAD ? current : best
  st.dominant.set(a.id, room)
  return room === p.room ? p : { ...p, room }
}

/**
 * Between two tool calls an agent thinks for a moment: it stays in the room of its last tool for up to this long
 * (its bubble says Thinking), instead of crossing the burrow and back for a think of a second.
 */
const ROOM_HOLD_MS = 10_000

/** Longest silence for which a live tool call still open keeps its room: past it, the end of the call may have been lost */
const OPEN_CALL_MAX_MS = 10 * 60_000

/** Stale only because it has been silent a while: its events came live (not replayed, not imported), and not for too long */
function silentOnly(a: SyncAgent, now: number): boolean {
  if (a.freshnessSource === 'imported' || a.freshnessSource === 'history') return false
  return typeof a.lastEventAt === 'number' && now - a.lastEventAt < OPEN_CALL_MAX_MS
}

/**
 * Between two steps of a turn: thinking, a tool call whose name was not received, or idle while its next event is
 * awaited (the state the simulation gives an agent whose call just ended). Idle at rest is not between two steps.
 */
const betweenSteps = (a: SyncAgent): boolean =>
  a.state === 'thinking' || (a.state === 'tool_calling' && !a.currentTool) || (a.state === 'idle' && a.awaitingNextEvent === true)

/** The placement with the room of the last tool held while an agent is between two calls (see ROOM_HOLD_MS) */
function holdRoom(p: BurrowPlacement, a: SyncAgent, stale: boolean, st: BurrowSyncState, now: number): BurrowPlacement {
  if (p.presence !== 'in' || stale) { st.lastRoom.delete(a.id); return p }
  // the post beside the front door is for an agent that waits for the user: never kept once it thinks again
  if (p.room === 'door') { st.lastRoom.delete(a.id); return p }
  if (p.room !== 'lounge') { st.lastRoom.set(a.id, { room: p.room, at: now }); return p }
  const between = betweenSteps(a)
  const last = st.lastRoom.get(a.id)
  if (!between || !last || now - last.at > ROOM_HOLD_MS) { st.lastRoom.delete(a.id); return p }
  return { ...p, room: last.room }
}

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
  toolCalls?: ReadonlyMap<string, SyncCall>
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
  /** Tool calls seen starting since the last sync (none on the first): the view flashes their room */
  received: ReceivedCall[]
  /** Agents that should be in the burrow but are not drawn because of the cap */
  hidden: number
  /** An animal was added, moved, sent out or given a bubble by this call: reduced motion draws again only then */
  changed: boolean
  /** Agents waiting for you at the post beside the front door, and since when the burrow saw them there (wall clock ms) */
  waits: ReadonlyMap<string, number>
  /** The tool calls seen failing in the last FAILED_ROW_MS, per agent (the animal stumbles) */
  stumbles: ReadonlyMap<string, BurrowStumble>
}

/**
 * A tool call of a live agent seen failing now: its failure counter rose since the last sync (a call that starts and
 * fails between two syncs counts too, it is never seen running). Not on the agent's first look (failures already
 * there), not for a replayed history or an imported transcript, an agent away, finished or silent, nor for a cancelled
 * call (not counted as a failure), nor after a gap of more than SYNC_GAP_MS without a sync (it may be old). The call named is its newest failed call not accounted for yet, when there is one.
 */
function failureSeen(a: SyncAgent, p: BurrowPlacement, stale: boolean, st: BurrowSyncState, toolCalls: BurrowSyncOptions['toolCalls'], now: number, gap: boolean): void {
  const cur = a.toolErrors ?? 0
  const prev = st.toolErrors.get(a.id)
  st.toolErrors.set(a.id, cur)
  if (prev === undefined || gap || cur <= prev || a.freshnessSource !== 'live' || p.presence !== 'in' || stale) return
  let call: SyncCall | undefined
  let callAt = Number.NEGATIVE_INFINITY
  for (const [id, c] of toolCalls ?? []) {
    if (c.agentId !== a.id || c.state !== 'error' || st.failCredited.has(id)) continue
    const t = c.completeTime ?? c.startTime ?? 0
    if (t >= callAt) { call = c; callAt = t }
  }
  st.stumbles.set(a.id, { at: now, tool: call?.toolName, exit: call ? exitCodeOf(call) : null })
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
  // the burrow did not follow for a while (a background tab): what happened meanwhile is not played as just seen
  const gap = st.lastSyncAt !== null && opts.now - st.lastSyncAt > SYNC_GAP_MS
  st.lastSyncAt = opts.now
  const received = receiveCalls(st, opts.toolCalls, opts.now, (id) => {
    const a = agents.get(id)
    return a !== undefined && deriveFreshness(a, opts.now) === 'fresh'
  }, gap)
  const running = runningCalls(opts.toolCalls)
  const wanted: Array<{ a: SyncAgent; p: BurrowPlacement; filtered: boolean; posture: BurrowPosture }> = []
  for (const a of agents.values()) {
    const filtered = !shown.has(a.id)
    const stale = deriveFreshness(a, opts.now) === 'stale'
    let p: BurrowPlacement = { presence: 'away', room: 'lounge', bubble: null }
    // a filtered agent is not drawn: it walks out through the front door, and it is not listed (finished or not)
    if (!filtered) {
      p = placeAgent(a, { stale, silentOnly: silentOnly(a, opts.now), delegating: opts.delegations?.get(a.id) })
      // at work (a named call in a work room, live): the room of most of its recent calls, not of each call
      if (p.presence === 'in' && !stale && WORK_ROOMS.has(p.room)) p = dominantRoom(p, a, st, running)
      p = holdRoom(p, a, stale, st, opts.now)
      // between two steps with calls received in the window but never seen running (a sub-agent's, read in batches):
      // the room of most of them, for as long as the window holds them
      if (p.presence === 'in' && !stale && p.room === 'lounge' && betweenSteps(a)) p = dominantRoom(p, a, st, running)
    }
    // the room is kept only while it works there, or thinks there for a moment: anything else decides afresh next time
    if (!WORK_ROOMS.has(p.room) || p.presence !== 'in') st.dominant.delete(a.id)
    // waiting for you: exactly the agents the placement sends to the post beside the front door (a fresh permission wait,
    // an AskUserQuestion call still open); counted from the first sync that sees it there
    if (p.presence === 'in' && p.room === 'door') { if (!st.waitSince.has(a.id)) st.waitSince.set(a.id, opts.now) }
    else st.waitSince.delete(a.id)
    failureSeen(a, p, stale, st, opts.toolCalls, opts.now, gap)
    wanted.push({ a, p, filtered, posture: postureOf(a.state, stale) })
  }
  const ids = new Set(wanted.map((w) => w.a.id))
  // animals of agents that are gone from the data walk out for good
  for (const actor of engine.actors) if (!ids.has(actor.key)) { engine.removeActor(actor.key); st.applied.delete(actor.key); changed = true }
  for (const key of [...st.applied.keys()]) if (!engine.has(key) && !ids.has(key)) st.applied.delete(key)
  for (const key of [...st.lastRoom.keys()]) if (!ids.has(key)) st.lastRoom.delete(key)
  for (const key of [...st.dominant.keys()]) if (!ids.has(key)) st.dominant.delete(key)
  for (const key of [...st.recent.keys()]) if (!ids.has(key)) st.recent.delete(key)
  for (const key of [...st.waitSince.keys()]) if (!ids.has(key)) st.waitSince.delete(key)
  for (const key of [...st.toolErrors.keys()]) if (!ids.has(key)) st.toolErrors.delete(key)
  for (const [key, s] of [...st.stumbles]) if (!ids.has(key) || opts.now - s.at >= FAILED_ROW_MS) st.stumbles.delete(key)
  // every failed call there now is accounted for: a later failure never names an older call (gone calls are forgotten)
  const calls = opts.toolCalls ?? new Map<string, SyncCall>()
  for (const [id, c] of calls) if (c.state === 'error') st.failCredited.add(id)
  for (const id of st.failCredited) if (!calls.has(id)) st.failCredited.delete(id)

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
    const since = st.waitSince.get(a.id)
    const waited = since === undefined ? 0 : Math.floor((opts.now - since) / 60_000)
    const stumble = st.stumbles.get(a.id)
    const failed = stumble ? { ...(stumble.tool !== undefined ? { tool: stumble.tool } : {}), ...(stumble.exit !== null ? { exit: stumble.exit } : {}) } : undefined
    flat.push({
      id: a.id, name: a.displayName, presence: p.presence, room: p.room, state: a.state,
      ...(p.bubble?.kind === 'tool' ? { tool: p.bubble.tool } : {}), ...(toolCallId ? { toolCallId } : {}), stale: p.bubble?.kind === 'stale',
      parentId: a.parentId ?? null, sessionId: a.sessionId, ...(delegating > 0 ? { delegating } : {}),
      ...(marks?.get(a.id)?.kind === 'loop' ? { loop: true as const } : {}), ...(lost > 0 ? { replayLost: lost } : {}),
      ...(marker !== null ? { marker } : {}), ...(team ? { team } : {}), ...(waited >= 1 ? { waited } : {}),
      ...(failed ? { failed } : {}),
    })
  }
  // attention first (stable: the order among equals is kept); the tree then puts each sub-agent under its parent
  flat.sort((x, y) => attentionRank(x.state) - attentionRank(y.state))
  return { rows: treeOrder(flat), hidden, changed, received, waits: new Map(st.waitSince), stumbles: new Map(st.stumbles) }
}
