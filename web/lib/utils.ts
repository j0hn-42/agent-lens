import { CLAUDE_FAMILY_ALTERNATION } from './canvas-constants'

/** Convert a 0–1 alpha value to a two-character hex string (e.g. 0.5 → '80') */
export function alphaHex(alpha: number): string {
  return Math.floor(alpha * 255).toString(16).padStart(2, '0')
}

/** Format a token count for display (e.g. 640 → '640', 1500 → '1.5k', 128500 → '128k', 1200000 → '1.2M') */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens < 1000) return String(Math.floor(tokens))
  if (tokens < 10_000) return `${(Math.floor(tokens / 100) / 10).toString()}k`
  if (tokens < 1_000_000) return `${Math.floor(tokens / 1000)}k`
  if (tokens < 10_000_000) return `${(Math.floor(tokens / 100_000) / 10).toString()}M`
  return `${Math.floor(tokens / 1_000_000)}M`
}

/**
 * Format a dollar amount with one consistent rule set: >= $1 two decimals, < $1 three,
 * < $0.01 four, and "<$0.0001" instead of a misleading "$0.0000". Non-finite or <= 0 → '$0.00'.
 * (e.g. 1.234 → '$1.23', 0.1234 → '$0.123', 0.0004 → '$0.0004')
 */
export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0.00'
  if (cost >= 1) return `$${cost.toFixed(2)}`
  if (cost >= 0.01) {
    const s = cost.toFixed(3)
    return s === '1.000' ? '$1.00' : `$${s}`
  }
  if (cost < 0.0001) return '<$0.0001'
  const s = cost.toFixed(4)
  // Rounding can carry a 4-decimal amount up to $0.01: keep the three-decimal form
  return Number(s) >= 0.01 ? `$${cost.toFixed(3)}` : `$${s}`
}

/** Format a duration in seconds as m:ss, or h:mm:ss past one hour (e.g. 75 → '1:15', 3725 → '1:02:05') */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = s.toString().padStart(2, '0')
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Pluralise a noun after a count (e.g. (1, 'agent') → '1 agent', (2, 'file') → '2 files') */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/** Truncate a file path to the last N segments (e.g. '/a/b/c/d.ts' → 'b/c/d.ts') */
export function truncatePath(path: string, segments = 3): string {
  return path.split('/').slice(-segments).join('/')
}

const PROVIDER_PREFIX = /^[a-z]+\.anthropic\./i
const VERSION_SUFFIX = /-v\d+:\d+$/i
const DATE_STAMP = /-\d{8}(?=$|-)/

const CLAUDE_NEW = new RegExp(`claude-(${CLAUDE_FAMILY_ALTERNATION})-(\\d+)(?:-(\\d+))?`, 'i')
const CLAUDE_LEGACY = new RegExp(`claude-(\\d+)(?:-(\\d+))?-(${CLAUDE_FAMILY_ALTERNATION})`, 'i')
const GPT = /gpt-(\S+?)(?:-\d{4}-\d{2}-\d{2})?$/i

function claudeLabel(family: string, major: string, minor?: string): string {
  const name = family[0].toUpperCase() + family.slice(1).toLowerCase()
  return minor ? `${name} ${major}.${minor}` : `${name} ${major}`
}

/** Format a raw model ID for display (e.g. 'claude-opus-4-6-20250514' → 'Opus 4.6'). */
export function formatModelName(model: string): string {
  const base = model
    .replace(PROVIDER_PREFIX, '')
    .replace(VERSION_SUFFIX, '')
    .replace(DATE_STAMP, '')

  const m = base.match(CLAUDE_NEW)
  if (m) return claudeLabel(m[1], m[2], m[3])

  const legacy = base.match(CLAUDE_LEGACY)
  if (legacy) return claudeLabel(legacy[3], legacy[1], legacy[2])

  const gpt = base.match(GPT)
  if (gpt) return `GPT-${gpt[1]}`

  return base
}

/** Accent colour of a model's tier: red for the largest (Fable/Mythos), orange for Opus,
 *  amber for Sonnet, blue for Haiku. OpenAI follows the same scale: red for GPT-5 / Pro, orange for
 *  o-series / GPT-4 / Codex, blue for mini / nano. Unknown models get a neutral grey. */
export function modelTierColor(model?: string): string {
  const id = (model ?? '').toLowerCase()
  if (/fable|mythos/.test(id)) return '#ff5a5a'
  if (/opus/.test(id)) return '#ff9a3c'
  if (/sonnet/.test(id)) return '#ffd24a'
  if (/haiku/.test(id)) return '#5aa9ff'
  if (/gpt|codex|\bo\d/.test(id)) {
    // GPT-5.6 named tiers, then size suffixes (mini/nano, gpt-oss-20b), then the large models
    if (/-luna|mini|nano|oss-20b/.test(id)) return '#5aa9ff'
    if (/-terra/.test(id)) return '#ff9a3c'
    if (/-sol|pro|gpt-5|gpt-4\.5/.test(id)) return '#ff5a5a'
    return '#ff9a3c'
  }
  return '#8a96a8'
}
