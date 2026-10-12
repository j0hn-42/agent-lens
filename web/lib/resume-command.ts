/**
 * "Copy resume command" of a session (#240, PR 1): `cd '<cwd>' && claude --resume <id>`, built here in the
 * browser from what the session list already holds. No route, nothing is run: the user pastes it in a terminal.
 * It is offered only when it can be proven to target this session: a Claude session, read live (not imported),
 * whose id passes the relay's check and whose working directory is a known absolute POSIX path.
 */
import type { SessionInfo } from './bridge-types'
import { hasControlChars } from './control-chars'

/** Mirrors RELAY_SESSION_PARAM_MAX_LENGTH of extension/src/constants.ts (scripts/resume-command.test.ts compares them). */
export const RESUME_SESSION_ID_MAX_LENGTH = 128
const SESSION_ID_RE = /^[A-Za-z0-9._:-]+$/
/** Longest cwd put in a command (PATH_MAX on Linux) */
const CWD_MAX_LENGTH = 4096

/** Mirrors isValidSessionId of extension/src/relay-guards.ts, which reads files and cannot be bundled here. */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= RESUME_SESSION_ID_MAX_LENGTH && SESSION_ID_RE.test(value)
}

/** POSIX shell single quoting: every character is literal; a quote becomes '\'' (close, escaped quote, reopen). */
export function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export type ResumeUnavailableReason = 'invalid-id' | 'runtime' | 'imported' | 'cwd'
export type ResumeCommandResult = { ok: true; command: string } | { ok: false; reason: ResumeUnavailableReason }

export type ResumableSession = Pick<SessionInfo, 'id' | 'runtime' | 'cwd' | 'imported'>

/** Why no command is offered, worded for the panel. */
export const RESUME_UNAVAILABLE_TEXT: Record<ResumeUnavailableReason, string> = {
  'invalid-id': 'No resume command: the session id is not one Claude Code can take.',
  runtime: 'No resume command: only Claude Code sessions can be resumed with claude --resume.',
  imported: 'No resume command: an imported transcript comes from another machine.',
  cwd: 'No resume command: the working directory of this session is unknown or not an absolute path.',
}

export function resumeCommand(session: ResumableSession): ResumeCommandResult {
  // A leading '-' would be read by claude as an option, not as the session id
  if (!isValidSessionId(session.id) || session.id.startsWith('-')) return { ok: false, reason: 'invalid-id' }
  if (session.runtime !== 'claude') return { ok: false, reason: 'runtime' }
  if (session.imported) return { ok: false, reason: 'imported' }
  const cwd = session.cwd
  // Single-line absolute POSIX path only: a pasted newline would run the rest as a separate command
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > CWD_MAX_LENGTH || hasControlChars(cwd)) {
    return { ok: false, reason: 'cwd' }
  }
  return { ok: true, command: `cd ${quotePosixShell(cwd)} && claude --resume ${session.id}` }
}
