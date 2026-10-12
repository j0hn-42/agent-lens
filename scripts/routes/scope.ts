/**
 * POST /scope : change la portée de découverte du relais à l'exécution (#291), `{"scope":"workspace"|"all"}`.
 *
 * Seule route qui modifie l'état du relais, donc la plus gardée : même enchaînement que les autres (loopback + Host,
 * autre site refusé, méthode, limiteur), puis Content-Type exact, corps plafonné et délai, JSON strict. Aucun chemin,
 * aucun identifiant venant du client : l'entrée est une énumération à deux valeurs.
 */
import * as http from 'http'
import type { KeyedRateLimiter } from '../../extension/src/hook-guards'
import { RELAY_SCOPE_BODY_MAX_BYTES, RELAY_SCOPE_BODY_TIMEOUT_MS } from '../../extension/src/constants'
import { guardedRoute, sendPlain, type RouteHandler } from './guard'

export type RelayScope = 'workspace' | 'all'

export interface ScopeRouteDeps {
  limiter: KeyedRateLimiter
  /** Applique la portée et la rend telle qu'elle est réellement scannée ensuite. */
  apply: (scope: RelayScope) => { scope: RelayScope; allWorkspaces: boolean }
}

/** `application/json`, avec ou sans charset utf-8 ; tout autre type est refusé (text/plain est « simple » pour CORS). */
export function isJsonContentType(value: string | undefined): boolean {
  return typeof value === 'string' && /^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.test(value.trim())
}

/** `{"scope":"workspace"|"all"}` et rien d'autre : un objet simple, une seule clé, une valeur de l'énumération. */
export function parseScopeBody(text: string): RelayScope | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'scope') return null
  const scope = (value as { scope: unknown }).scope
  return scope === 'workspace' || scope === 'all' ? scope : null
}

export type BodyResult = { ok: true; text: string } | { ok: false; code: 413 | 408 | 400 }

/** Lit le corps avec un plafond d'octets et un délai ; au-delà, on coupe sans tout lire. */
export function readLimitedBody(req: http.IncomingMessage, maxBytes: number, timeoutMs: number): Promise<BodyResult> {
  return new Promise(resolve => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) return resolve({ ok: false, code: 413 })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const done = (r: BodyResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      req.off('data', onData)
      resolve(r)
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) return done({ ok: false, code: 413 })
      chunks.push(chunk)
    }
    timer = setTimeout(() => done({ ok: false, code: 408 }), timeoutMs)
    req.on('data', onData)
    req.on('end', () => done({ ok: true, text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', () => done({ ok: false, code: 400 }))
    req.on('aborted', () => done({ ok: false, code: 400 }))
  })
}

export function createScopeRoute(deps: ScopeRouteDeps): RouteHandler {
  return guardedRoute({ limiter: deps.limiter, methods: ['POST'], rejectCrossOrigin: true }, async (req, res) => {
    if (!isJsonContentType(req.headers['content-type'])) return sendPlain(res, 415, 'Content-Type must be application/json')
    const body = await readLimitedBody(req, RELAY_SCOPE_BODY_MAX_BYTES, RELAY_SCOPE_BODY_TIMEOUT_MS)
    if (res.destroyed) return
    if (!body.ok) {
      const text = body.code === 413 ? 'Payload too large' : body.code === 408 ? 'Request timeout' : 'Bad request'
      // Corps trop gros ou trop lent : on répond puis on ferme, sans attendre le reste
      return sendPlain(res, body.code, text, body.code === 400 ? {} : { Connection: 'close' })
    }
    const scope = parseScopeBody(body.text)
    if (!scope) return sendPlain(res, 400, 'Invalid scope: expected {"scope":"workspace"|"all"}')
    const result = deps.apply(scope)
    const text = JSON.stringify(result)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text),
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(text)
  })
}
