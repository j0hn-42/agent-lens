/** GET /status : petit instantané JSON (version, espace de travail, runtimes, hooks, sessions). */
import type { RelayStatus } from '../../extension/src/protocol'
import type { KeyedRateLimiter } from '../../extension/src/hook-guards'
import type { SessionIndexResult } from '../../extension/src/session-index'
import type { KeyedCoalescer } from '../server-hardening'
import { guardedRoute, sendJson, sendPlain, type RouteHandler } from './guard'

export interface StatusSnapshot {
  sessionCount: number
  hooksConfigured: boolean
  disable1MContext: boolean
}

/** Ce qui change avec la portée (#291) : lu au moment de répondre, jamais figé dans un calcul partagé en vol. */
export type StatusLive = Pick<RelayStatus, 'allWorkspaces' | 'discovery' | 'skippedSessions'>

export interface StatusRouteDeps {
  limiter: KeyedRateLimiter
  /** UN seul calcul en vol : les requêtes concurrentes partagent le même. */
  coalescer: KeyedCoalescer<StatusSnapshot>
  /** Calcule l'instantané (appelé au plus une fois à la fois). */
  computeSnapshot: () => Promise<StatusSnapshot>
  /** Champs fixes du statut. */
  base: Pick<RelayStatus, 'relayVersion' | 'workspace' | 'runtimes'>
  /** Portée et plafonds de découverte tels qu'ils sont à cet instant. */
  live: () => StatusLive
  readIndex: () => SessionIndexResult | null
}

export function createStatusRoute(deps: StatusRouteDeps): RouteHandler {
  return guardedRoute({ limiter: deps.limiter, rejectCrossOrigin: true }, async (req, res) => {
    let snapshot: StatusSnapshot
    try {
      snapshot = await deps.coalescer.run('status', deps.computeSnapshot)
    } catch {
      if (!res.headersSent) sendPlain(res, 500, 'Status unavailable')
      return
    }
    if (res.destroyed || res.headersSent) return
    const live = deps.live()
    const status: RelayStatus = {
      relayVersion: deps.base.relayVersion,
      workspace: deps.base.workspace,
      runtimes: deps.base.runtimes,
      hooksConfigured: snapshot.hooksConfigured,
      disable1MContext: snapshot.disable1MContext,
      sessionCount: snapshot.sessionCount,
      skippedSessions: live.skippedSessions,
      allWorkspaces: live.allWorkspaces,
      discovery: live.discovery,
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
