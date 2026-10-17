/**
 * Gardes HTTP communs aux routes du relais : un seul enchaînement, appliqué dans le même ordre à chaque route
 * (en-têtes de sécurité, loopback + Host, Origin/Sec-Fetch-Site si demandé, méthode, limiteur de débit),
 * pour qu'une nouvelle route ne puisse pas en oublier un.
 */
import * as http from 'http'
import { isLoopbackAddress, type KeyedRateLimiter } from '../../extension/src/hook-guards'
import { statusRateKey, isCrossOriginRequest } from '../../extension/src/relay-guards'
import { applySecurityHeaders } from '../server-hardening'
import { requestHostClass, isRemoteCrossOrigin, isRemotePaired, remoteRateKey } from '../remote-access'

export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>

export interface GuardOptions {
  /** Limiteur de débit de la route (une clé par pair). */
  limiter: KeyedRateLimiter
  /** Méthodes acceptées (défaut : GET et HEAD). */
  methods?: readonly string[]
  /** Refuse aussi (403) les requêtes d'un autre site (Origin / Sec-Fetch-Site) : pour les routes qui lancent un processus. */
  rejectCrossOrigin?: boolean
  /** Noms d'hôte de tunnel acceptés en plus du loopback (--allow-host, #241). Réservé aux routes en lecture seule ;
   *  pour ces hôtes, seule l'origine https://<hôte> est acceptée, et le cookie d'appairage est exigé (401 sinon, #475).
   *  Absent : loopback seul. */
  allowedHosts?: readonly string[]
  /** Limiter key for loopback callers (default: peer + Origin + User-Agent). Routes that start a process use the peer
   *  address alone: Origin and User-Agent are chosen by the client, so keying on them lets a caller reset its own budget. */
  rateKey?: (req: http.IncomingMessage) => string
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

/** Enveloppe un handler : 403 (pair/Host non loopback, ou autre site), 401 (tunnel non appairé), 405 (méthode), 429 (débit), sinon le handler. */
export function guardedRoute(options: GuardOptions, handler: RouteHandler): RouteHandler {
  const methods = options.methods ?? ['GET', 'HEAD']
  const allow = methods.join(', ')
  return (req, res) => {
    applySecurityHeaders(res, 'api')
    const hostClass = requestHostClass(req, options.allowedHosts ?? [])
    if (!isLoopbackAddress(req.socket.remoteAddress) || hostClass === 'foreign') {
      return sendPlain(res, 403, 'Forbidden')
    }
    if (hostClass === 'allowed' && isRemoteCrossOrigin(req.headers, req.headers.host ?? '')) {
      return sendPlain(res, 403, 'Forbidden')
    }
    // Through a tunnel, nothing is read without a live pairing cookie (#475); same 401 for every reason. The pairing of
    // a loopback Host while remote access is on (#517) is enforced by the app gate (gateRemoteRequest)
    if (hostClass === 'allowed' && !isRemotePaired(req, options.allowedHosts ?? [])) {
      return sendPlain(res, 401, 'Unauthorized', { 'Cache-Control': 'no-store' })
    }
    if (hostClass === 'loopback' && options.rejectCrossOrigin && isCrossOriginRequest(req.headers, req.headers.host)) {
      return sendPlain(res, 403, 'Forbidden')
    }
    if (!req.method || !methods.includes(req.method)) {
      return sendPlain(res, 405, 'Method not allowed', { Allow: allow })
    }
    const rateKey = hostClass === 'allowed'
      ? remoteRateKey(req.headers.host ?? '')
      : options.rateKey ? options.rateKey(req) : statusRateKey(req.socket.remoteAddress, req.headers)
    if (!options.limiter.allow(rateKey)) {
      return sendPlain(res, 429, 'Too many requests', { 'Retry-After': '1' })
    }
    return handler(req, res)
  }
}
