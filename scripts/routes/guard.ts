/**
 * Gardes HTTP communs aux routes du relais : un seul enchaînement, appliqué dans le même ordre à chaque route
 * (en-têtes de sécurité, loopback + Host, Origin/Sec-Fetch-Site si demandé, méthode, limiteur de débit),
 * pour qu'une nouvelle route ne puisse pas en oublier un.
 */
import * as http from 'http'
import { isLoopbackAddress, isLoopbackHostHeader, type KeyedRateLimiter } from '../../extension/src/hook-guards'
import { statusRateKey, isCrossOriginRequest } from '../../extension/src/relay-guards'
import { applySecurityHeaders } from '../server-hardening'

export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>

export interface GuardOptions {
  /** Limiteur de débit de la route (une clé par pair). */
  limiter: KeyedRateLimiter
  /** Méthodes acceptées (défaut : GET et HEAD). */
  methods?: readonly string[]
  /** Refuse aussi (403) les requêtes d'un autre site (Origin / Sec-Fetch-Site) : pour les routes qui lancent un processus. */
  rejectCrossOrigin?: boolean
}

export function sendPlain(res: http.ServerResponse, code: number, text: string, extra: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(code, { 'Content-Type': 'text/plain', ...extra })
  res.end(text)
}

/** Réponse JSON non mise en cache ; pas de corps pour HEAD. */
export function sendJson(req: http.IncomingMessage, res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/** Enveloppe un handler : 403 (pair/Host non loopback, ou autre site), 405 (méthode), 429 (débit), sinon le handler. */
export function guardedRoute(options: GuardOptions, handler: RouteHandler): RouteHandler {
  const methods = options.methods ?? ['GET', 'HEAD']
  const allow = methods.join(', ')
  return (req, res) => {
    applySecurityHeaders(res, 'api')
    if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHostHeader(req.headers.host)) {
      return sendPlain(res, 403, 'Forbidden')
    }
    if (options.rejectCrossOrigin && isCrossOriginRequest(req.headers, req.headers.host)) {
      return sendPlain(res, 403, 'Forbidden')
    }
    if (!req.method || !methods.includes(req.method)) {
      return sendPlain(res, 405, 'Method not allowed', { Allow: allow })
    }
    if (!options.limiter.allow(statusRateKey(req.socket.remoteAddress, req.headers))) {
      return sendPlain(res, 429, 'Too many requests', { 'Retry-After': '1' })
    }
    return handler(req, res)
  }
}
