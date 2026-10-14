/**
 * Tray icon menu model (#335). Pure logic, no GUI shell: whichever wrapper is chosen (Electron, Tauri, native)
 * renders these items. The app stays usable without the icon; nothing here touches the network.
 * Only facts proven by GET /status are shown: anything else reads "État indisponible".
 */
export type TrayItemId = 'open' | 'state' | 'url' | 'quit'

export interface TrayItem {
  id: TrayItemId
  /** Text label (the accessible name too: never an icon alone) */
  label: string
  /** false for the read-only state line */
  enabled: boolean
}

const UNKNOWN = 'État indisponible'

/** Sessions line from a /status body; a value that is not a non-negative integer is not shown. */
export function sessionsLabel(status: unknown): string {
  const n = (status as { sessionCount?: unknown } | null | undefined)?.sessionCount
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return UNKNOWN
  return n === 1 ? '1 session suivie' : `${n} sessions suivies`
}

/** The tray only ever points at the local relay. */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

export function buildTrayMenu(status: unknown, url: string): TrayItem[] {
  const state: TrayItem = { id: 'state', label: sessionsLabel(status), enabled: false }
  const quit: TrayItem = { id: 'quit', label: 'Quitter', enabled: true }
  if (!isLoopbackUrl(url)) return [state, quit]
  return [
    { id: 'open', label: "Ouvrir l'interface", enabled: true },
    state,
    { id: 'url', label: url, enabled: true },
    quit,
  ]
}
