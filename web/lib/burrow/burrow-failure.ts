/**
 * Burrow view: failures. A tool call observed to fail makes the animal stumble where it is (burrow-sync detects it from
 * the agent's failure counter, the view stages it); an agent in error stands glum. Nothing is said that was not
 * received: the exit code only when the received text of a failed shell command starts with it.
 * The poses come from Agents' Burrow: only the squirrel has drawings of its own (startled, dizzy, sheepish, sad); the
 * other animals stand, only the effects around them move.
 */
import type { ToolCallNode } from '../agent-types'
import { isShellTool } from '../action-summary'

/** The row says a tool call just failed for this long after the burrow saw it fail */
export const FAILED_ROW_MS = 10_000

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
