/**
 * Session renaming (#246): a name chosen by the user, kept in this browser only. It replaces the label
 * for display; the original label stays available (`originalLabel`) so a rename never hides what the
 * source reported. Pure (no React, no `window`) so it can be unit-tested with node:test.
 *
 * Trust model: the stored blob may be hand-edited or corrupted; parsing never throws and every value is
 * re-sanitized.
 */
import type { SessionInfo } from './bridge-types'
import { SESSION_ID_MAX_LENGTH } from './ui-preferences'

/** localStorage key of the alias map (session id -> name) */
export const SESSION_ALIASES_STORAGE_KEY = 'agent-lens:session-aliases'
export const ALIAS_MAX_LENGTH = 80
/** Upper bound on stored aliases, so a corrupted blob cannot grow without limit */
export const ALIAS_MAX_COUNT = 500

export type SessionAliases = ReadonlyMap<string, string>

/** Clean name, or null when nothing usable is left (which means "no alias"). */
export function sanitizeAlias(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = value
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, ALIAS_MAX_LENGTH)
    .trim()
  return clean.length > 0 ? clean : null
}

export function parseAliases(raw: string | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!raw) return out
  let data: unknown
  try { data = JSON.parse(raw) } catch { return out }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return out
  for (const [id, value] of Object.entries(data)) {
    if (out.size >= ALIAS_MAX_COUNT) break
    if (id.length === 0 || id.length > SESSION_ID_MAX_LENGTH) continue
    const alias = sanitizeAlias(value)
    if (alias !== null) out.set(id, alias)
  }
  return out
}

export function serializeAliases(aliases: SessionAliases): string {
  return JSON.stringify(Object.fromEntries(aliases))
}

/** New map with the alias set, or removed when `value` is empty. */
export function setAlias(aliases: SessionAliases, sessionId: string, value: string): Map<string, string> {
  const next = new Map(aliases)
  const alias = sanitizeAlias(value)
  if (alias === null) next.delete(sessionId)
  else if (next.has(sessionId) || next.size < ALIAS_MAX_COUNT) next.set(sessionId, alias)
  return next
}

/** Sessions with their chosen name as label; returns the same array when nothing applies. */
export function applyAliases(sessions: SessionInfo[], aliases: SessionAliases): SessionInfo[] {
  if (aliases.size === 0 || !sessions.some(s => aliases.has(s.id))) return sessions
  return sessions.map(s => {
    const alias = aliases.get(s.id)
    return alias === undefined ? s : { ...s, label: alias, originalLabel: s.label }
  })
}
