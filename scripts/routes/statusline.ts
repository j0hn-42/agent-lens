/**
 * GET /statusline (#236) : une ligne de texte pour une barre tmux ou zellij (`?format=json` pour les compteurs).
 * Dérivée des observations, donc de la même liste blanche : ni identifiant de session, ni nom d'agent, ni chemin.
 */
import type { Observations, ObservationsRunResult } from '../../extension/src/observations'
import type { KeyedRateLimiter } from '../../extension/src/hook-guards'
import { guardedRoute, sendJson, sendPlain, type RouteHandler } from './guard'

export interface StatusLine {
  /** Sessions actives dont l'activité est récente */
  live: number
  /** Agents actifs / en attente de ces sessions */
  active: number
  idle: number
  /** Comptes minorants : observation tronquée ou liste d'agents incomplète */
  atLeast: boolean
  text: string
}

export function formatStatusline(obs: Observations): StatusLine {
  let live = 0
  let active = 0
  let idle = 0
  let atLeast = obs.truncated || obs.omittedSessions > 0
  for (const s of obs.sessions) {
    // Une session importée n'est jamais observée en direct ; périmée ou fermée, elle n'est pas « en cours »
    if (s.provenance === 'imported' || s.status !== 'active' || s.freshness !== 'fresh') continue
    live++
    if (s.agentsIncomplete || s.agentsTruncated) atLeast = true
    for (const a of s.agents ?? []) {
      if (a.state === 'active') active++
      else if (a.state === 'idle') idle++
    }
  }
  const lb = atLeast ? '>=' : ''
  const text = live === 0 && !atLeast ? 'lens 0 live' : `lens ${lb}${live} live ${lb}${active} active ${lb}${idle} idle`
  return { live, active, idle, atLeast, text }
}

export interface StatusLineRouteDeps {
  limiter: KeyedRateLimiter
  observe: () => ObservationsRunResult
}

export function createStatusLineRoute({ limiter, observe }: StatusLineRouteDeps): RouteHandler {
  return guardedRoute({ limiter, rejectCrossOrigin: true }, (req, res) => {
    let query: URL
    try { query = new URL(req.url ?? '/', 'http://localhost') } catch { return sendPlain(res, 400, 'Bad URL') }
    let format = 'text'
    for (const [k, v] of query.searchParams) {
      if (k !== 'format' || (v !== 'text' && v !== 'json')) return sendPlain(res, 400, 'Unknown query parameter or format')
      format = v
    }
    const out = observe()
    // Une observation indisponible n'est jamais affichée comme « 0 session »
    if (!out.ok) return sendPlain(res, 503, 'Observations unavailable')
    const line = formatStatusline(out.result)
    if (format === 'json') return sendJson(req, res, 200, line)
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(req.method === 'HEAD' ? undefined : line.text + '\n')
  })
}
