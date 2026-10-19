// Pure logic of the "Pair" filter: click one agent, Shift-click another and the feeds show only the
// communications (dispatch / return / peer message) exchanged between them. Free of React so it can be
// unit tested with node:test; the shared store lives in pair-filter-store.ts.

export interface PairState {
  /** First agent key ('' when unset) */
  a: string
  /** Second agent key ('' when unset) */
  b: string
}

export const EMPTY_PAIR: PairState = Object.freeze({ a: '', b: '' })

const COMM_TYPES: ReadonlySet<string> = new Set(['dispatch', 'return', 'message'])

/** True when both agents are chosen and differ. */
export function isPairComplete(p: PairState): boolean {
  return p.a !== '' && p.b !== '' && p.a !== p.b
}

/** True when anything is selected (a chip should be shown). */
export function isPairSet(p: PairState): boolean {
  return p.a !== '' || p.b !== ''
}

export function samePair(x: PairState, y: PairState): boolean {
  return x.a === y.a && x.b === y.b
}

/** Normalised pair from two agent keys; unusable keys ('', 'all', null) leave the slot empty. */
export function makePair(a: string | null | undefined, b: string | null | undefined): PairState {
  const clean = (k: string | null | undefined) => (k && k !== 'all' ? k : '')
  return { a: clean(a), b: clean(b) }
}

/**
 * Next state when an agent is picked (Shift-click on a tab / row, "Filter pair" button).
 * Nothing chosen: becomes the first agent. One chosen: becomes the second (picking the same agent again
 * clears it). Complete pair: starts a new pair with the picked agent.
 */
export function pickPairAgent(p: PairState, key: string): PairState {
  if (!key || key === 'all') return p
  if (p.a === '') return { a: key, b: '' }
  if (p.b === '') return p.a === key ? EMPTY_PAIR : { a: p.a, b: key }
  return { a: key, b: '' }
}

/**
 * Next pair when an agent is Shift-clicked on the canvas: with nothing picked yet, the currently selected
 * agent (`anchor`) is the first agent and the clicked one the second; otherwise the usual pick sequence.
 */
export function pairAfterShiftClick(p: PairState, anchor: string | null | undefined, key: string): PairState {
  if (!key || key === 'all') return p
  if (p.a === '' && anchor && anchor !== 'all' && anchor !== key) return { a: anchor, b: key }
  return pickPairAgent(p, key)
}

/** Drop keys that `known` rejects (an agent that disappeared). Returns the same object when unchanged. */
export function prunePair(p: PairState, known: (key: string) => boolean): PairState {
  const a = p.a !== '' && known(p.a) ? p.a : ''
  const b = p.b !== '' && known(p.b) ? p.b : ''
  return a === p.a && b === p.b ? p : { a, b }
}

/** Does the message connect exactly the two agents, in either direction? Plain conversation never does. */
export function messageMatchesPair(m: { type: string; from?: string; to?: string }, p: PairState): boolean {
  if (!isPairComplete(p) || !COMM_TYPES.has(m.type)) return false
  return (m.from === p.a && m.to === p.b) || (m.from === p.b && m.to === p.a)
}
