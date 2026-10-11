/**
 * Secret redaction before a session leaves the app (#237). Pattern-based and best effort: known credential
 * formats, `name=value` assignments whose name says secret, URL credentials and personal home directories
 * are replaced by `[REDACTED:<type>]` (home directories by `~`). Every replacement is counted so the export
 * can say how many were made; nothing here promises that every secret is caught.
 */
import { CONTROL_TEXT } from '@/lib/control-chars'

export interface RedactionCounts {
  total: number
  byType: Record<string, number>
}

export function createRedactionCounts(): RedactionCounts {
  return { total: 0, byType: {} }
}

const marker = (type: string) => `[REDACTED:${type}]`

/** Order matters: whole blocks first, then specific prefixes before the generic ones. */
const TOKEN_PATTERNS: { type: string; re: RegExp; keep?: number }[] = [
  { type: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { type: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { type: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { type: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { type: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
]

const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/g
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/[\]]+:[^\s@/[\]]+@/gi
const ASSIGNMENT = /((?:^|[^A-Za-z0-9])[A-Za-z0-9_-]*?(password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)([^\s"'`,;&)}\]]{4,})/gi
/** Values that are code or placeholders, not secrets */
const NOT_A_VALUE = /^(?:string|number|boolean|null|undefined|true|false|none|any|unknown|object|str|int|bool|process\.env\b.*|os\.environ\b.*|\$.*|<.*|\{.*|\[.*|\*+)$/i
const IDENTIFIER = /^[A-Za-z_][A-Za-z_.]*$/
// The leading group stands in for a lookbehind (not allowed by the ES6 target): it is put back as is
const HOME_UNIX = /(^|[^\w.-])\/(?:home|Users)\/[^/\s"'`:;,)\]}]+/g
const HOME_WINDOWS = /(^|[^\w.-])[A-Za-z]:\\Users\\[^\\\s"'`:;,)\]}]+/gi

function count(counts: RedactionCounts | undefined, type: string): void {
  if (!counts) return
  counts.total++
  counts.byType[type] = (counts.byType[type] ?? 0) + 1
}

/** Redact one string (control and bidi characters removed first). */
export function redactText(text: string, counts?: RedactionCounts): string {
  let out = text.replace(CONTROL_TEXT, '')
  for (const { type, re } of TOKEN_PATTERNS) {
    out = out.replace(re, () => { count(counts, type); return marker(type) })
  }
  out = out.replace(BEARER, (_m, head: string) => { count(counts, 'bearer-token'); return head + marker('bearer-token') })
  out = out.replace(URL_CREDENTIALS, (_m, scheme: string) => { count(counts, 'url-credentials'); return `${scheme}${marker('url-credentials')}@` })
  out = out.replace(ASSIGNMENT, (m, head: string, keyword: string, value: string) => {
    if (NOT_A_VALUE.test(value)) return m
    // A token or key name followed by a bare identifier is code (`token = readToken`), not a credential
    if (!/^pass|secret/i.test(keyword) && IDENTIFIER.test(value)) return m
    count(counts, 'secret')
    return head + marker('secret')
  })
  out = out.replace(HOME_UNIX, (_m, lead: string) => { count(counts, 'home-path'); return `${lead}~` })
  out = out.replace(HOME_WINDOWS, (_m, lead: string) => { count(counts, 'home-path'); return `${lead}~` })
  return out
}

/** Deep copy of `value` with every string (object keys included) redacted. */
export function redactSecrets<T>(value: T, counts?: RedactionCounts): T {
  return walk(value, counts, 0) as T
}

const MAX_DEPTH = 64

function walk(value: unknown, counts: RedactionCounts | undefined, depth: number): unknown {
  if (typeof value === 'string') return redactText(value, counts)
  if (value === null || typeof value !== 'object') return value
  // Deeper than any real payload: dropped rather than copied unredacted
  if (depth >= MAX_DEPTH) return '[REDACTED:too-deep]'
  if (Array.isArray(value)) return value.map(v => walk(v, counts, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    // defineProperty: a `__proto__` key stays a plain key
    Object.defineProperty(out, redactText(k, counts), { value: walk(v, counts, depth + 1), enumerable: true, writable: true, configurable: true })
  }
  return out
}
