// Test helper (#440): wait for a condition instead of a fixed time. A fixed sleep is a guess that a
// loaded machine overruns (throttled UI commits, frames run as setTimeout(0)); polling the condition
// itself holds whatever the load. Each poll goes through act() so React state updates are flushed.
// Returns whether the condition held: the caller asserts it with its own message. The cap only bounds
// a failure, it is never the expected path.
import { act } from 'react'

export async function waitFor(cond: () => boolean, ms = 20_000, step = 50): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() >= deadline) return false
    await act(async () => { await new Promise(r => setTimeout(r, step)) })
  }
  return true
}
