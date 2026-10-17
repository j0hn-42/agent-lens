/** État du quota d'abonnement Claude Code (#467) : lu dans `rate_limits` de la barre d'état, jamais reconstitué. */

export interface QuotaWindow {
  /** 0 à 100. */
  usedPercentage: number
  /** Epoch en secondes. */
  resetsAt: number
}

export interface QuotaWindows {
  fiveHour: QuotaWindow | null
  sevenDay: QuotaWindow | null
}

export interface QuotaSnapshot extends QuotaWindows {
  /** Epoch en millisecondes. */
  receivedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseWindow(value: unknown): QuotaWindow | null {
  if (!isRecord(value)) return null
  const used = value.used_percentage
  const resets = value.resets_at
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null
  if (typeof resets !== 'number' || !Number.isInteger(resets) || resets < 0) return null
  return { usedPercentage: used, resetsAt: resets }
}

/**
 * Racine stricte (`rate_limits` seul) ; clés inconnues tolérées dans `rate_limits`, où seules
 * `five_hour` et `seven_day` sont lues. Une fenêtre présente mais invalide invalide tout le corps.
 */
export function parseQuotaBody(text: string): QuotaWindows | null {
  let root: unknown
  try { root = JSON.parse(text) } catch { return null }
  if (!isRecord(root)) return null
  const keys = Object.keys(root)
  if (keys.length !== 1 || keys[0] !== 'rate_limits') return null
  const limits = root.rate_limits
  if (!isRecord(limits)) return null
  const result: QuotaWindows = { fiveHour: null, sevenDay: null }
  for (const [key, field] of [['five_hour', 'fiveHour'], ['seven_day', 'sevenDay']] as const) {
    if (!(key in limits)) continue
    const parsed = parseWindow(limits[key])
    if (!parsed) return null
    result[field] = parsed
  }
  return result.fiveHour || result.sevenDay ? result : null
}

export function createQuotaStore(now: () => number = Date.now) {
  let snapshot: QuotaSnapshot | null = null
  return {
    /** Remplace les deux fenêtres ensemble : une fenêtre absente devient `null`, elle n'hérite pas de l'ancienne. */
    accept(body: QuotaWindows): QuotaSnapshot {
      snapshot = { fiveHour: body.fiveHour, sevenDay: body.sevenDay, receivedAt: now() }
      return snapshot
    },
    current(): QuotaSnapshot | null { return snapshot },
  }
}
