import { BUBBLE_FADE_IN, BUBBLE_HOLD, BUBBLE_FADE_OUT } from '../../../lib/canvas-constants'

/**
 * Compute the effective alpha for a message bubble given its age,
 * agent opacity, and whether it is a thinking bubble.
 *
 * `held` freezes the bubble in its visible phase so it never expires.
 * Returns 0 when the bubble should be skipped entirely.
 */
export function bubbleAlpha(age: number, agentOpacity: number, held = false): number {
  // While held (hovered, focused, paused or "never hide"), the bubble stays in its fully visible phase.
  if (held && age > BUBBLE_HOLD - 0.001) age = BUBBLE_HOLD - 0.001
  if (age > BUBBLE_HOLD + BUBBLE_FADE_OUT) return 0

  let alpha: number
  if (age < BUBBLE_FADE_IN) {
    alpha = age / BUBBLE_FADE_IN
  } else if (age < BUBBLE_HOLD) {
    alpha = 1
  } else {
    alpha = 1 - (age - BUBBLE_HOLD) / BUBBLE_FADE_OUT
  }

  alpha = Math.max(0, Math.min(1, alpha)) * agentOpacity * 0.9
  return alpha
}
