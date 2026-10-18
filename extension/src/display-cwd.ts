/**
 * The one rule for a working directory read from an agent's own files (Codex rollouts, Pi headers,
 * OpenCode rows) before it is shown or matched (#420): untrusted text, kept only when it is a path.
 */
import * as path from 'path'
import { hasControlChars } from './control-chars'

/** A cwd longer than this is not a path an adapter shows. */
export const CWD_MAX = 4096

/**
 * `cwd` as shown to the user: an absolute path of at most CWD_MAX characters, with no control,
 * invisible or bidi character (control-chars.ts); anything else (including a non-string) is undefined.
 */
export function displayCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string' || !cwd || cwd.length > CWD_MAX || hasControlChars(cwd)) return undefined
  return path.isAbsolute(cwd) ? cwd : undefined
}
