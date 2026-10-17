/**
 * Tray icon menu model (#335). Pure function, no I/O, no GUI shell, no network. The driver probes
 * GET /status and renders these items; a click sends back an item id, never a command or a URL.
 * Only proven facts are shown: a count comes from a recent, valid /status answer from an Agent Lens
 * relay, otherwise the menu says "unknown" (docs/reading-the-ui.md).
 */
import type { MessageKey } from '../../web/lib/messages'

/**
 * The driver starts a probe 5 s after the previous one ends (5 to 7 s apart with the 2 s time limit):
 * after 15 s, at least two later probes have ended and the last answer no longer counts as current.
 */
export const STALE_AFTER_MS = 15_000

export type StatusProbe =
  | { kind: 'ok'; body: unknown; receivedAt: number }
  | { kind: 'unreachable' | 'timeout' | 'http-error' | 'invalid-json' | 'not-started' }

export type TrayMessage = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string

export interface MenuInput {
  probe: StatusProbe
  /** Same clock as `receivedAt` (ms) */
  now: number
  port: number | null
  /** The icon started the relay, so it is the only case where "quit" may stop it */
  ownsRelay: boolean
  t: TrayMessage
}

export type TrayItemId = 'open' | 'copyUrl' | 'state' | 'skipped' | 'quit'

export interface MenuItem {
  id: TrayItemId
  /** Text label, also the accessible name: never an icon or a colour alone */
  label: string
  enabled: boolean
}

export interface TrayMenu {
  tooltip: string
  items: MenuItem[]
}

const VERSION = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/** The sum of the per-reason counts, or null when the field is absent or any count is invalid. */
function skippedTotal(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  let total = 0
  for (const n of Object.values(raw)) {
    if (!isCount(n)) return null
    total += n
  }
  return total
}

/** The /status body when it is current and comes from an Agent Lens relay, else null. */
function provenStatus(probe: StatusProbe, now: number): { sessionCount: number; skipped: number | null } | null {
  if (probe.kind !== 'ok') return null
  const age = now - probe.receivedAt
  if (!Number.isFinite(age) || age < 0 || age > STALE_AFTER_MS) return null
  const body = probe.body as { relayVersion?: unknown; sessionCount?: unknown; skippedSessions?: unknown } | null
  if (typeof body !== 'object' || body === null) return null
  if (typeof body.relayVersion !== 'string' || !VERSION.test(body.relayVersion)) return null
  if (!isCount(body.sessionCount)) return null
  return { sessionCount: body.sessionCount, skipped: skippedTotal(body.skippedSessions) }
}

const isPort = (p: number | null): p is number => p !== null && Number.isInteger(p) && p >= 1 && p <= 65535

export function deriveMenu({ probe, now, port, ownsRelay, t }: MenuInput): TrayMenu {
  const status = provenStatus(probe, now)
  const stateLabel = status
    ? t(status.sessionCount === 1 ? 'tray.sessions.one' : 'tray.sessions.many', { n: status.sessionCount })
    : t('tray.sessions.unknown')
  const canOpen = isPort(port)
  const items: MenuItem[] = [
    { id: 'open', label: t('tray.open'), enabled: canOpen },
    { id: 'copyUrl', label: t('tray.copyUrl'), enabled: canOpen },
    { id: 'state', label: stateLabel, enabled: false },
  ]
  if (status && status.skipped !== null && status.skipped > 0) {
    items.push({ id: 'skipped', label: t('tray.skipped', { k: status.skipped }), enabled: false })
  }
  items.push({ id: 'quit', label: t(ownsRelay ? 'tray.quit.stopRelay' : 'tray.quit.closeIcon'), enabled: true })
  return { tooltip: t('tray.tooltip', { state: stateLabel }), items }
}
