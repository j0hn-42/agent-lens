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

/**
 * A redirect text as the extension will pass it to Claude (#387): control and invisible characters removed (line
 * breaks kept), trimmed, capped. '' means there is nothing to send: a redirect needs a non-empty text.
 */
export function redirectMessage(text: string): string {
  return text.replace(CONTROL_TEXT, '').trim().slice(0, REDIRECT_MESSAGE_MAX)
}
