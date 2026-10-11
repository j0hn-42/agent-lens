/** GET /context?session=<id> : CLAUDE.md + mémoire du cwd de la session (#64). Lu à chaque appel ; le client met en cache. */
import { readProjectContext } from '../../extension/src/project-context'
import { createSessionCapabilitiesReader, unreadableCapabilities } from '../../extension/src/session-capabilities'
import { claudeConfigDir, claudeProjectsDir } from '../../extension/src/claude-config-dir'
import { isValidSessionId } from '../../extension/src/relay-guards'
import type { KeyedRateLimiter } from '../../extension/src/hook-guards'
import { guardedRoute, sendJson, sendPlain, type RouteHandler } from './guard'

export interface ContextRouteDeps {
  limiter: KeyedRateLimiter
  /** Le cwd d'une session suivie (tiré de l'en-tête de sa transcription, jamais de la requête). */
  cwdOf: (sessionId: string) => string | undefined
  /** Le chemin de la transcription d'une session suivie (découvert par le relais, jamais tiré de la requête), #242. */
  transcriptOf?: (sessionId: string) => string | undefined
}

export function createContextRoute(deps: ContextRouteDeps): RouteHandler {
  const readCapabilities = createSessionCapabilitiesReader()
  return guardedRoute({ limiter: deps.limiter, rejectCrossOrigin: true }, (req, res) => {
    let sessionId: string | null = null
    try { sessionId = new URL(req.url ?? '', 'http://localhost').searchParams.get('session') } catch { /* handled below */ }
    if (!isValidSessionId(sessionId)) return sendPlain(res, 400, 'Invalid session parameter')
    const cwd = deps.cwdOf(sessionId)
    if (!cwd) return sendPlain(res, 404, 'No project context for this session')
    const configDir = claudeConfigDir()
    // Capacités (#242) : lues dans la transcription, bornée à <config>/projects ; sans transcription connue, « illisible », jamais vide
    const transcript = deps.transcriptOf?.(sessionId)
    const capabilities = !deps.transcriptOf ? undefined
      : transcript ? readCapabilities(transcript, claudeProjectsDir(configDir)) : unreadableCapabilities()
    sendJson(req, res, 200, { sessionId, loadedAt: Date.now(), ...readProjectContext(cwd, configDir), ...(capabilities ? { capabilities } : {}) })
  })
}
