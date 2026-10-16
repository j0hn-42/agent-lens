// Test helper (#440): run a block with requestAnimationFrame slowed down, to prove that a canvas
// assertion does not depend on how many frames real time lets the canvas draw. setup.ts replaces
// requestAnimationFrame by setTimeout(0): under machine load the number of frames drawn in a fixed
// real-time window varies by a third or more, so a test must hold with few frames as well as many.
import { act } from 'react'

const g = globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }

export async function withSlowFrames<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const fast = g.requestAnimationFrame
  g.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => { act(() => { cb(Date.now()) }) }, ms) as unknown as number
  try {
    return await fn()
  } finally {
    g.requestAnimationFrame = fast
  }
}
