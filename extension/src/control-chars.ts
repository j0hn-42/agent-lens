/**
 * The one definition of the characters that never reach the UI from untrusted text (#220).
 *
 * Forbidden: C0 controls, DEL, C1 controls (U+0080-009F, including U+009B CSI), zero-width and
 * direction marks (U+200B-200F), line/paragraph separators and bidi embeddings/overrides
 * (U+2028-202E), bidi isolates (U+2066-2069) and the byte order mark (U+FEFF).
 *
 * CONTROL_TEXT is for free text and keeps TAB, LF and CR; CONTROL_ALL is for identifiers and
 * single-line labels and removes those three too. Both are global: use them with `replace`, and
 * use `hasControlChars` to test (a global regex is stateful with `test`).
 *
 * web/lib/control-chars.ts is a verbatim mirror of this file (checked by scripts/control-chars.test.ts).
 */
const INVISIBLE = '\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2066-\\u2069\\uFEFF'

export const CONTROL_TEXT = new RegExp(`[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F${INVISIBLE}]`, 'g')
export const CONTROL_ALL = new RegExp(`[\\u0000-\\u001F${INVISIBLE}]`, 'g')

const CONTROL_ALL_PROBE = new RegExp(CONTROL_ALL.source)

/** True when `value` contains any forbidden character (TAB, LF and CR included). */
export function hasControlChars(value: string): boolean {
  return CONTROL_ALL_PROBE.test(value)
}
