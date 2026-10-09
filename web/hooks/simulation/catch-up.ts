/**
 * Catch-up of a burst of received events (#210): a switch to 'All', a relay replay or any large batch is
 * queued, then reduced in slices that fit a frame budget, so the page keeps painting and can show how far
 * the history has loaded. Pure apart from the queue it mutates; the clock is passed in.
 */
import type { SimulationEvent } from '../../lib/agent-types'
import type { SimulationState } from './types'
import { processEventBatch, type ProcessEventContext } from './process-event'

/** Time given to the catch-up in one frame (ms): the rest of the frame stays for drawing */
export const CATCH_UP_FRAME_BUDGET_MS = 8

interface CatchUpSegment {
  readonly events: readonly SimulationEvent[]
  /** Wall clock (ms) the events were received at: their freshness proof */
  readonly receivedAt: number
  /** Next event to process */
  next: number
}

export interface CatchUpQueue {
  segments: CatchUpSegment[]
  /** Events queued since the queue was last empty */
  total: number
  /** Of those, the events already processed */
  done: number
}

export interface CatchUpProgress { done: number; total: number }

export function createCatchUp(): CatchUpQueue {
  return { segments: [], total: 0, done: 0 }
}

/** Independent copy (a saved session snapshot keeps its own backlog). */
export function copyCatchUp(queue: CatchUpQueue): CatchUpQueue {
  return { segments: queue.segments.map(s => ({ ...s })), total: queue.total, done: queue.done }
}

export function clearCatchUp(queue: CatchUpQueue): void {
  queue.segments = []
  queue.total = 0
  queue.done = 0
}

export function enqueueCatchUp(queue: CatchUpQueue, events: readonly SimulationEvent[], receivedAt: number): void {
  if (events.length === 0) return
  queue.segments.push({ events, receivedAt, next: 0 })
  queue.total += events.length
}

/** Progress of the backlog, null when nothing is waiting. */
export function catchUpProgress(queue: CatchUpQueue): CatchUpProgress | null {
  return queue.segments.length > 0 ? { done: queue.done, total: queue.total } : null
}

/**
 * Process queued events until `budgetMs` has elapsed on `now` (at least one event per call, so the
 * backlog always moves). Returns the new state and the events processed, in order.
 */
export function runCatchUpSlice(
  queue: CatchUpQueue,
  state: SimulationState,
  ctx: ProcessEventContext,
  { budgetMs, now }: { budgetMs: number; now: () => number },
): { state: SimulationState; processed: SimulationEvent[] } {
  const start = now()
  const shouldYield = () => now() - start >= budgetMs
  const processed: SimulationEvent[] = []
  while (queue.segments.length > 0) {
    const segment = queue.segments[0]
    const from = segment.next
    const result = processEventBatch(segment.events, state, ctx, {
      from, advanceClock: true, receivedAt: segment.receivedAt, shouldYield,
    })
    state = result.state
    for (let i = from; i < from + result.processed; i++) processed.push(segment.events[i])
    segment.next += result.processed
    queue.done += result.processed
    if (segment.next < segment.events.length || shouldYield()) {
      if (segment.next >= segment.events.length) queue.segments.shift()
      break
    }
    queue.segments.shift()
  }
  if (queue.segments.length === 0) { queue.total = 0; queue.done = 0 }
  return { state, processed }
}
