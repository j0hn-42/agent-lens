/** GET /observations et /observations/schema : l'action typée que Claude peut interroger. */
import { observationsRoute, isTruthyFlag } from '../../extension/src/relay-guards'
import { parseObservationsInput } from '../../extension/src/observations'
import type { createObservationsAction } from '../../extension/src/observations'
import type { KeyedRateLimiter } from '../../extension/src/hook-guards'
import { guardedRoute, sendJson, type RouteHandler } from './guard'

export interface ObservationsRouteDeps {
  limiter: KeyedRateLimiter
  observations: ReturnType<typeof createObservationsAction>
}

export function createObservationsRoute({ limiter, observations }: ObservationsRouteDeps): RouteHandler {
  return guardedRoute({ limiter }, (req, res) => {
    if (observations.disposed) return sendJson(req, res, 503, { error: 'observations action is shut down' })
    if (observationsRoute(req.url) === 'schema') return sendJson(req, res, 200, observations.definition)
    let query: URL
    try { query = new URL(req.url ?? '/', 'http://localhost') } catch { return sendJson(req, res, 400, { error: 'bad url' }) }
    const raw: Record<string, unknown> = {}
    const session = query.searchParams.get('session')
    if (session !== null) raw.session = session
    const agents = query.searchParams.get('agents')
    if (agents !== null) raw.includeAgents = isTruthyFlag(agents)
    for (const k of query.searchParams.keys()) if (k !== 'session' && k !== 'agents') return sendJson(req, res, 400, { error: `unknown query parameter: ${k}` })
    const parsed = parseObservationsInput(raw)
    if (!parsed.ok) return sendJson(req, res, 400, { error: parsed.error })
    const out = observations.run(parsed.input)
    return out.ok ? sendJson(req, res, 200, out.result) : sendJson(req, res, 500, { error: out.error })
  })
}
