/**
 * "Go to terminal" (#240, PR 2): opens a VS Code terminal in the working directory of a session, with no command.
 * Pure (no `vscode` import): the caller passes the window API. The webview is not trusted: it names a session,
 * never a directory. The directory is the one the extension itself recorded for that session, and it must still be
 * an existing absolute single-line path. Nothing is typed or run in the terminal; the user decides what to run.
 */
import * as fs from 'fs'
import * as path from 'path'
import { CONTROL_ALL, hasControlChars } from './control-chars'
import { isValidSessionId } from './relay-guards'

export const TERMINAL_NAME_MAX = 60
const TERMINAL_NAME_PREFIX = 'Agent Lens: '
const CWD_MAX_LENGTH = 4096

export interface TerminalSession {
  id: string
  cwd?: string
}

export interface TerminalWindow {
  createTerminal(options: { name: string; cwd: string }): { show(): void; sendText?(text: string): void }
}

export type OpenTerminalFailure = 'unknown-session' | 'cwd' | 'not-a-directory'
export type OpenTerminalResult = { ok: true; cwd: string } | { ok: false; reason: OpenTerminalFailure }

/** The session named by a well-formed `open-terminal` message; any other field (a cwd, say) is ignored. */
export function parseOpenTerminalMessage(raw: unknown): { sessionId: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const sessionId = (raw as Record<string, unknown>).sessionId
  return isValidSessionId(sessionId) ? { sessionId } : null
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

export function openSessionTerminal(
  sessionId: string,
  sessions: readonly TerminalSession[],
  deps: { window: TerminalWindow; isDirectory?: (p: string) => boolean },
): OpenTerminalResult {
  const session = sessions.find(s => s.id === sessionId)
  if (!session) return { ok: false, reason: 'unknown-session' }
  const cwd = session.cwd
  if (typeof cwd !== 'string' || cwd.length > CWD_MAX_LENGTH || !path.isAbsolute(cwd) || hasControlChars(cwd)) {
    return { ok: false, reason: 'cwd' }
  }
  if (!(deps.isDirectory ?? isDirectory)(cwd)) return { ok: false, reason: 'not-a-directory' }
  const folder = path.basename(cwd).replace(CONTROL_ALL, '')
  const name = (TERMINAL_NAME_PREFIX + folder).slice(0, TERMINAL_NAME_MAX)
  deps.window.createTerminal({ name, cwd }).show()
  return { ok: true, cwd }
}

/** What the user is told when no terminal was opened. */
export const OPEN_TERMINAL_FAILURE_TEXT: Record<OpenTerminalFailure, string> = {
  'unknown-session': 'Agent Lens: no terminal opened, this session is not known to the extension.',
  cwd: 'Agent Lens: no terminal opened, the working directory of this session is unknown or not an absolute path.',
  'not-a-directory': 'Agent Lens: no terminal opened, the working directory of this session no longer exists.',
}
