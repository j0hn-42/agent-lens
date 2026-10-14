/**
 * Display helpers of the permission requests panel (#240, PR 4). Pure: no React, no DOM.
 */
import { CONTROL_ALL, CONTROL_TEXT } from './control-chars'
import type { PermissionRequestMessage } from './bridge-types'

/** Fields of a tool input that name what the call acts on, first found wins (for the button names only) */
const SUMMARY_FIELDS = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url'] as const
const SUMMARY_MAX = 60

/** Wall-clock time of a deadline, in the interface language */
export function formatPermissionTime(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(ms)
}

/** One line naming what the call acts on (`npm test`, a path), read from a whole input only; '' when there is none */
export function inputSummary(r: PermissionRequestMessage): string {
  if (r.inputTruncated) return ''
  let input: unknown
  try { input = JSON.parse(r.inputPreview) } catch { return '' }
  if (!input || typeof input !== 'object') return ''
  for (const key of SUMMARY_FIELDS) {
    const v = (input as Record<string, unknown>)[key]
    if (typeof v !== 'string') continue
    const line = v.replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim()
    if (line) return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line
  }
  return ''
}

/** The extension caps a redirect text at this many characters (extension PERMISSION_MESSAGE_MAX) */
export const REDIRECT_MESSAGE_MAX = 2000

/** Cuts at `max` UTF-16 units without leaving half of a surrogate pair at the end */
function cutText(text: string, max: number): string {
  const cut = text.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/**
 * A redirect text as the extension will pass it to Claude (#387): control and invisible characters removed (line
 * breaks kept), trimmed, capped. '' means there is nothing to send: a redirect needs a non-empty text.
 */
export function redirectMessage(text: string): string {
  return cutText(text.replace(CONTROL_TEXT, '').trim(), REDIRECT_MESSAGE_MAX)
}

/** What the extension tells Claude Code with a plain deny (extension permission-gate.ts) */
const DENY_MESSAGE = 'Denied by the operator from Agent Lens.'

/** Characters of a redirect text compared with the result of the call: the result is cut by the extension */
const PROBE_CHARS = 40
const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * The text whose presence in the error result of the call proves that this page's refusal reached Claude (#387):
 * the deny text, or the beginning of the redirect text. null for an approval. Kept in the page's memory only.
 */
export function refusalProbe(action: 'approve' | 'deny' | 'redirect', message?: string): string | null {
  if (action === 'deny') return DENY_MESSAGE
  if (action !== 'redirect') return null
  const text = collapse(redirectMessage(message ?? ''))
  return text ? cutText(text, PROBE_CHARS) : null
}

/**
 * Whether the result of an error end carries the probe. A hook PostToolUseFailure result (`[FAILED] ` prefix) is a
 * call that ran and failed, and the hook server does not authenticate it: it never counts.
 */
export function carriesRefusal(probe: string, result: unknown): boolean {
  if (typeof result !== 'string' || result.startsWith('[FAILED]')) return false
  return collapse(result).includes(probe)
}
