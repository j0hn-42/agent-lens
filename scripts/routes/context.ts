/** GET /context?session=<id> : CLAUDE.md + mémoire du cwd de la session (#64). Lu à chaque appel ; le client met en cache. */
import { readProjectContext } from '../../extension/src/project-context'
import { claudeConfigDir } from '../../extension/src/claude-config-dir'
import { isValidSessionId } from '../../extension/src/relay-guards'
import type { KeyedRateLimiter } from '../../extension/src/hook-guards'
import { guardedRoute, sendJson, sendPlain, type RouteHandler } from './guard'

export interface ContextRouteDeps {
  limiter: KeyedRateLimiter
  /** Le cwd d'une session suivie (tiré de l'en-tête de sa transcription, jamais de la requête). */
  cwdOf: (sessionId: string) => string | undefined
}

export function createContextRoute(deps: ContextRouteDeps): RouteHandler {
  return guardedRoute({ limiter: deps.limiter }, (req, res) => {
    let sessionId: string | null = null
    try { sessionId = new URL(req.url ?? '', 'http://localhost').searchParams.get('session') } catch { /* handled below */ }
    if (!isValidSessionId(sessionId)) return sendPlain(res, 400, 'Invalid session parameter')
    const cwd = deps.cwdOf(sessionId)
    if (!cwd) return sendPlain(res, 404, 'No project context for this session')
    sendJson(req, res, 200, { sessionId, loadedAt: Date.now(), ...readProjectContext(cwd, claudeConfigDir()) })
  })
}
