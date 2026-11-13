/**
 * Burrow view: what the picture may claim about an agent. Every placement comes from the agent's observed state
 * (and the name of the tool it is running); nothing is invented, so no random chatter, no task made up for an idle agent.
 */
import type { Agent, AgentState } from '../agent-types'
import { isDoneAgent } from '../inactive-agents'
import { BURROW_ANIMALS, type BurrowAnimal, type BurrowRoomId, type BurrowWorkshopId } from './burrow-types'

export const BURROW_ROOM_ORDER: readonly BurrowRoomId[] = ['lounge', 'office', 'library', 'workshop', 'lab']

const OFFICE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const LIBRARY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch'])
const WORKSHOP_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell'])

/** Room of a tool call: edits, reads and searches, the shell; every other tool (agent dispatch, MCP, unknown) is the laboratory */
function roomOfTool(tool: string | undefined): BurrowWorkshopId {
  if (tool === undefined) return 'lab'
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

export interface BurrowPlacement {
  /** 'away' = outside the burrow (finished): the agent walks out through the front door */
  presence: 'in' | 'away'
  room: BurrowRoomId
  bubble: BurrowBubble | null
}

type PlaceInput = Pick<Agent, 'state' | 'archived' | 'activity' | 'currentTool'> & Partial<Pick<Agent, 'awaitingNextEvent'>>

/**
 * `stale` (deriveFreshness = 'stale', the same test as the graph): no room, no tool, only the last known state in the lounge.
 * A tool call whose tool name was not received claims no room either.
 */
export function placeAgent(a: PlaceInput, opt: { stale?: boolean } = {}): BurrowPlacement {
  if (isDoneAgent(a)) return { presence: 'away', room: 'lounge', bubble: null }
  if (opt.stale === true) return { presence: 'in', room: 'lounge', bubble: a.state === 'idle' ? null : { kind: 'stale', state: a.state } }
  switch (a.state) {
    case 'tool_calling': {
      const tool = typeof a.currentTool === 'string' && a.currentTool !== '' ? a.currentTool : undefined
      return tool ? { presence: 'in', room: roomOfTool(tool), bubble: { kind: 'tool', tool } } : { presence: 'in', room: 'lounge', bubble: { kind: 'state', state: 'tool_calling' } }
    }
    case 'thinking':
    case 'waiting_permission':
    case 'error':
    case 'paused':
      return { presence: 'in', room: 'lounge', bubble: { kind: 'state', state: a.state } }
    default:
      return { presence: 'in', room: 'lounge', bubble: null }
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
