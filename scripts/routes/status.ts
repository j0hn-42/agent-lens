/** GET /status : petit instantané JSON (version, espace de travail, runtimes, hooks, sessions). */
import type { RelayStatus } from '../../extension/src/protocol'
import type { KeyedRateLimiter } from '../../extension/src/hook-guards'
import type { SessionIndexResult } from '../../extension/src/session-index'
import type { KeyedCoalescer } from '../server-hardening'
import { guardedRoute, sendJson, sendPlain, type RouteHandler } from './guard'

export interface StatusSnapshot { sessionCount: number; hooksConfigured: boolean }

export interface StatusRouteDeps {
  limiter: KeyedRateLimiter
  /** UN seul calcul en vol : les requêtes concurrentes partagent le même. */
  coalescer: KeyedCoalescer<StatusSnapshot>
  /** Calcule l'instantané (appelé au plus une fois à la fois). */
  computeSnapshot: () => Promise<StatusSnapshot>
  /** Champs fixes du statut. */
  base: Pick<RelayStatus, 'relayVersion' | 'workspace' | 'runtimes' | 'allWorkspaces'>
  readIndex: () => SessionIndexResult | null
}

export function createStatusRoute(deps: StatusRouteDeps): RouteHandler {
  return guardedRoute({ limiter: deps.limiter }, async (req, res) => {
    let snapshot: StatusSnapshot
    try {
      snapshot = await deps.coalescer.run('status', deps.computeSnapshot)
    } catch {
      if (!res.headersSent) sendPlain(res, 500, 'Status unavailable')
      return
    }
    if (res.destroyed || res.headersSent) return
    const status: RelayStatus = {
      relayVersion: deps.base.relayVersion,
      workspace: deps.base.workspace,
      runtimes: deps.base.runtimes,
      hooksConfigured: snapshot.hooksConfigured,
      sessionCount: snapshot.sessionCount,
      allWorkspaces: deps.base.allWorkspaces,
    }
    const indexed = deps.readIndex()
    if (indexed) {
      status.sessionIndex = {
        status: indexed.status, count: indexed.sessions.length, truncated: indexed.truncated,
        ...(indexed.message ? { message: indexed.message } : {}),
      }
    }
    sendJson(req, res, 200, status)
  })
}
