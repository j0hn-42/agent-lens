/**
 * POST /quota : reçoit le `rate_limits` de la barre d'état de Claude Code (#467).
 *
 * Même enchaînement que /scope (loopback + Host, autre site refusé, méthode, limiteur, Content-Type exact, corps
 * plafonné et délai, JSON strict). Le corps n'est jamais renvoyé ni journalisé ; seules les valeurs validées par
 * `parseQuotaBody` atteignent le store.
 */
import type { KeyedRateLimiter } from '../../extension/src/hook-guards'
import { RELAY_QUOTA_BODY_MAX_BYTES, RELAY_QUOTA_BODY_TIMEOUT_MS } from '../../extension/src/constants'
import { parseQuotaBody, type QuotaSnapshot, type QuotaWindows } from '../quota'
import { guardedRoute, sendPlain, type RouteHandler } from './guard'
import { isJsonContentType, readLimitedBody } from './scope'

export interface QuotaRouteDeps {
  limiter: KeyedRateLimiter
  /** Enregistre les fenêtres reçues et les rend telles qu'elles sont désormais connues. */
  accept: (body: QuotaWindows) => QuotaSnapshot
}

export function createQuotaRoute(deps: QuotaRouteDeps): RouteHandler {
  // Clé = pair seul : Origin et User-Agent sont choisis par le client, et chaque POST accepté diffuse un message
  return guardedRoute({ limiter: deps.limiter, methods: ['POST'], rejectCrossOrigin: true, rateKey: req => req.socket.remoteAddress ?? '' }, async (req, res) => {
    if (!isJsonContentType(req.headers['content-type'])) return sendPlain(res, 415, 'Content-Type must be application/json')
    const body = await readLimitedBody(req, RELAY_QUOTA_BODY_MAX_BYTES, RELAY_QUOTA_BODY_TIMEOUT_MS)
    if (res.destroyed) return
    if (!body.ok) {
      const text = body.code === 413 ? 'Payload too large' : body.code === 408 ? 'Request timeout' : 'Bad request'
      // Corps trop gros ou trop lent : on répond puis on ferme, sans attendre le reste
      return sendPlain(res, body.code, text, body.code === 400 ? {} : { Connection: 'close' })
    }
    const windows = parseQuotaBody(body.text)
    if (!windows) return sendPlain(res, 400, 'Invalid quota: expected {"rate_limits":{"five_hour"?,"seven_day"?}}')
    deps.accept(windows)
    const text = '{}'
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text),
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(text)
  })
}
