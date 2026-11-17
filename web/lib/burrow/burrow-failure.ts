/**
 * Burrow view: failures. A tool call observed to fail makes the animal stumble where it is (burrow-sync detects it from
 * the agent's failure counter, the view stages it); an agent in error stands glum. Nothing is said that was not
 * received: the exit code only when the received text of a failed shell command starts with it.
 * The poses come from Agents' Burrow: only the squirrel has drawings of its own (startled, dizzy, sheepish, sad); the
 * other animals stand, only the effects around them move.
 */
import type { ToolCallNode } from '../agent-types'
import { isShellTool } from '../action-summary'
import { poseOr, seqAt, type BurrowActFrame, type Seq } from './burrow-acts'
import type { BurrowSpriteMeta } from './burrow-types'

/** The row says a tool call just failed for this long after the burrow saw it fail */
export const FAILED_ROW_MS = 10_000

/** It starts, its head turns (dizzy), then it stands sheepish: the source's stumble of a failed action */
const OOPS_SEQ: Seq = [['startled', 0.6], ['dizzyA', 0.25], ['dizzyB', 0.25], ['dizzyA', 0.25], ['dizzyB', 0.25], ['sheepish', 1.5]]
/** Seconds the animal stumbles (held where it is), then goes on */
export const STUMBLE_S = 3.1
/** Its bubble says the exit code from when it stands sheepish until a little after it goes on */
const LINE_FROM_S = 1.6
const LINE_UNTIL_S = 4.0
/** The dust under its feet lasts this long */
const PUFF_S = 0.55

/**
 * What an animal shows `age` seconds after the burrow saw a tool call of its agent fail: startled under "!" with dust
 * under its feet, dizzy with stars over its head, then sheepish under "!" with a drop of sweat (STUMBLE_S); its bubble
 * says `line` (the exit code, translated; null when none was received) from LINE_FROM_S to LINE_UNTIL_S. After the
 * stumble the pose is the engine's again. `still` (reduced motion, Freeze motion): sheepish under "!" with the line,
 * without effects. Null once over. The "!" never blinks. Animals without these drawings stand (poseOr).
 */
export function stumbleFrame(o: { age: number; still: boolean; meta: BurrowSpriteMeta; line: string | null }): BurrowActFrame | null {
  const { meta, line } = o
  const age = Math.max(0, o.age)
  if (age >= LINE_UNTIL_S) return null
  if (age >= STUMBLE_S) return line === null ? null : { sign: null, fx: [], line }
  const said = line !== null && (o.still || age >= LINE_FROM_S) ? { line } : {}
  if (o.still) return { pose: poseOr(meta, 'sheepish'), sign: 'alert', fx: [], ...said }
  const step = seqAt(OOPS_SEQ, age, false).pose
  const pose = poseOr(meta, step)
  const tall = (pose && meta.poses[pose]?.h) || meta.h
  const fx: Array<{ name: string; dx: number; dy: number; alpha?: number }> = []
  if (age < PUFF_S) {                                 // two puffs either side of the feet, drifting apart and up, fading
    const k = age / PUFF_S
    const d = Math.round(5 * k)
    fx.push({ name: 'w_puff', dx: -11 - d, dy: -7 - d, alpha: 1 - k }, { name: 'w_puff', dx: 11 + d, dy: -7 - d, alpha: 1 - k })
  }
  if (step.startsWith('dizzy')) {                     // three stars on an ellipse over the head, one turn per 1.05 s
    for (let k = 0; k < 3; k++) {
      const q = age * 6 + k * 2.094
      fx.push({ name: 'w_star', dx: Math.round(Math.cos(q) * 10), dy: -tall - 4 + Math.round(Math.sin(q) * 3) })
    }
    return { pose, sign: null, fx, ...said }
  }
  if (step === 'sheepish') fx.push({ name: 'w_drop', dx: 11, dy: -tall + 7 + Math.round(((age - LINE_FROM_S) % 1.2) * 5) })
  return { pose, sign: 'alert', fx, ...said }
}

/** An agent in error: the squirrel hangs its head, another animal stands, under a steady "!" (as long as the state lasts) */
export function glumFrame(o: { meta: BurrowSpriteMeta }): BurrowActFrame {
  return { pose: poseOr(o.meta, 'sad'), sign: 'alert', fx: [] }
}

/** `Exit code N` at the start of the text, after the `[FAILED] ` our hook path puts before a failed result */
const EXIT_CODE = /^(?:\[FAILED\] )?Exit code (\d{1,3})(?!\d)/

/**
 * The exit code of a failed shell command, read from its received text (its error message, else its result): only
 * when that text starts with `Exit code N`, N an exit status (0..255). Null for any other tool, or any other text.
 */
export function exitCodeOf(call: Pick<ToolCallNode, 'toolName'> & Partial<Pick<ToolCallNode, 'errorMessage' | 'result'>>): number | null {
  if (!isShellTool(call.toolName)) return null
  const m = EXIT_CODE.exec(call.errorMessage || call.result || '')
  if (!m) return null
  const code = Number(m[1])
  return code <= 255 ? code : null
}
