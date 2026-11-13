/**
 * Burrow view: what the picture may claim about an agent. Every placement comes from the agent's observed state
 * (and the name of the tool it is running); nothing is invented, so no random chatter, no task made up for an idle agent.
 */
import type { Agent, AgentState } from '../agent-types'
import { isDoneAgent } from '../inactive-agents'
import { BURROW_ANIMALS, type BurrowAnimal, type BurrowPosture, type BurrowRoomId, type BurrowWorkshopId } from './burrow-types'

export const BURROW_ROOM_ORDER: readonly BurrowRoomId[] = ['lounge', 'office', 'library', 'workshop', 'lab']

/** The tools of each room that has a list (the laboratory is every other tool, the lounge no tool); the legend reads this table too */
export const BURROW_ROOM_TOOLS = {
  /** Writing: files, notebooks, and the agent's own to-do list */
  office: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite'],
  library: ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch'],
  workshop: ['Bash', 'BashOutput', 'KillShell'],
  /** Tools that hand a task to a sub-agent: the agent phones, the sub-agent walks in through the front door */
  phone: ['Agent', 'Task'],
  /** Tools that wait for the user's answer: the agent stands with the ones waiting for a permission, beside the front door */
  door: ['AskUserQuestion'],
} as const
const OFFICE_TOOLS: ReadonlySet<string> = new Set(BURROW_ROOM_TOOLS.office)
const LIBRARY_TOOLS: ReadonlySet<string> = new Set(BURROW_ROOM_TOOLS.library)
const WORKSHOP_TOOLS: ReadonlySet<string> = new Set(BURROW_ROOM_TOOLS.workshop)
const DISPATCH_TOOLS: ReadonlySet<string> = new Set(BURROW_ROOM_TOOLS.phone)
const USER_TOOLS: ReadonlySet<string> = new Set(BURROW_ROOM_TOOLS.door)

/**
 * Room of a tool call: edits, reads and searches, the shell; a dispatch to a sub-agent is the telephone; a question to
 * the user is the post beside the front door;
 * every other tool (MCP, unknown) is the laboratory
 */
function roomOfTool(tool: string | undefined): BurrowWorkshopId {
  if (tool === undefined) return 'lab'
  if (DISPATCH_TOOLS.has(tool)) return 'phone'
  if (USER_TOOLS.has(tool)) return 'door'
  if (OFFICE_TOOLS.has(tool)) return 'office'
  if (LIBRARY_TOOLS.has(tool)) return 'library'
  if (WORKSHOP_TOOLS.has(tool)) return 'workshop'
  return 'lab'
}

/** What the speech bubble says: the tool being run, or the observed state (the view turns it into a sentence) */
export type BurrowBubble =
  | { kind: 'tool'; tool: string }
  | { kind: 'state'; state: AgentState }
  /** The agent is silent, replayed or imported: its state is the last one known, not a proof of what it does now */
  | { kind: 'stale'; state: AgentState }
  /** The agent runs a dispatch tool and `n` sub-agents it sent have not returned yet (burrow-links openDelegations) */
  | { kind: 'waiting'; n: number }

export interface BurrowPlacement {
  /**
   * 'finished' = the agent is done (complete, archived, done): it rests in the lounge, dimmed like a finished node of the
   * graph. 'away' = outside the burrow: the agent walked out through the front door (hidden by the filter, or gone)
   */
  presence: 'in' | 'finished' | 'away'
  room: BurrowRoomId
  bubble: BurrowBubble | null
}

type PlaceInput = Pick<Agent, 'state' | 'archived' | 'activity' | 'currentTool'> & Partial<Pick<Agent, 'awaitingNextEvent'>>

/**
 * `stale` (deriveFreshness = 'stale', the same test as the graph): no room, no tool, only the last known state in the lounge.
 * `silentOnly`: the agent is stale only because it has been silent, its events were received live (not replayed, not
 * imported). A named tool call seen opening live and not seen closing keeps the room of its tool (a long command sends
 * nothing until it ends); the bubble still says the state is the last one known.
 * A tool call whose tool name was not received claims no room either.
 * `delegating`: sub-agents this agent sent that have not returned yet; while it runs a dispatch tool the bubble says it
 * waits for them (a count of observed dispatches without a return, never a guess).
 */
export function placeAgent(a: PlaceInput, opt: { stale?: boolean; silentOnly?: boolean; delegating?: number } = {}): BurrowPlacement {
  if (isDoneAgent(a)) return { presence: 'finished', room: 'lounge', bubble: null }
  if (opt.stale === true) {
    const tool = typeof a.currentTool === 'string' && a.currentTool !== '' ? a.currentTool : undefined
    const room = opt.silentOnly === true && a.state === 'tool_calling' && tool ? roomOfTool(tool) : 'lounge'
    return { presence: 'in', room, bubble: a.state === 'idle' ? null : { kind: 'stale', state: a.state } }
  }
  switch (a.state) {
    case 'tool_calling': {
      const tool = typeof a.currentTool === 'string' && a.currentTool !== '' ? a.currentTool : undefined
      const waiting = opt.delegating ?? 0
      if (tool && DISPATCH_TOOLS.has(tool) && waiting > 0) return { presence: 'in', room: 'phone', bubble: { kind: 'waiting', n: waiting } }
      return tool ? { presence: 'in', room: roomOfTool(tool), bubble: { kind: 'tool', tool } } : { presence: 'in', room: 'lounge', bubble: { kind: 'state', state: 'tool_calling' } }
    }
    case 'waiting_permission':   // the only state that needs the user: the post beside the front door
      return { presence: 'in', room: 'door', bubble: { kind: 'state', state: a.state } }
    case 'thinking':
    case 'error':
    case 'paused':
      return { presence: 'in', room: 'lounge', bubble: { kind: 'state', state: a.state } }
    default:
      return { presence: 'in', room: 'lounge', bubble: null }
  }
}

/**
 * Posture in the lounge for an observed state (burrow-types BurrowPosture). `stale`: the state is only the last one
 * known, the animal dozes by the fire. Only an idle agent strolls; a state that is not idle claims no activity.
 */
export function postureOf(state: AgentState, stale: boolean): BurrowPosture {
  if (stale) return 'sleep'
  switch (state) {
    case 'idle': return 'stroll'
    case 'thinking': return 'sit'
    case 'waiting_permission': return 'wave'
    default: return 'still'
  }
}

function hash(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** The animal of an agent: from its key, so the same agent keeps its animal; the next free one when taken, shared once all nine are */
export function pickAnimal(key: string, used: ReadonlySet<string>): BurrowAnimal {
  const n = BURROW_ANIMALS.length
  const start = hash(key) % n
  for (let i = 0; i < n; i++) {
    const sprite = BURROW_ANIMALS[(start + i) % n].sprite
    if (!used.has(sprite)) return sprite
  }
  return BURROW_ANIMALS[start].sprite
}
