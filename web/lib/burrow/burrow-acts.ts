/**
 * Burrow view: acts, what an animal shows over its plain posture for a state it is observed in (an agent that waits for
 * you...). The view decides an act from the observed state and the wall clock, and hands it to the engine (setAct), which
 * shows it only while the animal stands. Pure: no DOM, no engine clock.
 */

/** A sign over the head, one meaning each: "?" waits for you, "..." still waits for you (it sulks), "!" a failure */
export type BurrowSign = 'ask' | 'dots' | 'alert'

export interface BurrowActFrame {
  /** Pose drawn instead of the engine's: a pose the sheet has, null = standing frame of its direction, undefined = no override */
  pose?: string | null
  sign: BurrowSign | null
  /** Effects around the animal: fx rect, centre offset from its feet (scene px), alpha (default 1) */
  fx: ReadonlyArray<{ name: string; dx: number; dy: number; alpha?: number }>
  /** Bubble text while the act lasts, instead of the engine's */
  line?: string
  /** Sprite lifted by this many px */
  oy?: number
}
