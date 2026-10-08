/**
 * Light ANSI SGR parser for the output of Bash tools.
 *
 * Turns text containing escape sequences into styled segments. The renderer builds elements and inline
 * styles from those segments (never raw HTML), so the DOM text stays free of control codes: copying a
 * selection yields the plain text. Non-SGR control sequences are dropped.
 */
import type { CSSProperties } from 'react'

export interface AnsiStyle {
  /** CSS color: `var(--ansi-N)` for the 16 theme colors, hex otherwise. */
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
  strike?: boolean
}

export interface AnsiSegment extends AnsiStyle {
  text: string
}

/** Tokens: CSI sequence (complete, then truncated), OSC, charset/2-char ESC sequences, SGR whose ESC was lost, lone ESC. */
// eslint-disable-next-line no-control-regex
const TOKEN = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_]|\[(\d+(?:;\d*)*)m|\x1b/g

const NAMED = (n: number) => `var(--ansi-${n})`

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
}

/** 256-color palette: 0-15 theme colors, 16-231 6x6x6 cube, 232-255 grayscale ramp. */
export function ansi256(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined
  if (n < 16) return NAMED(n)
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `#${hex2(v)}${hex2(v)}${hex2(v)}` }
  const i = n - 16
  const level = (c: number) => (c === 0 ? 0 : 55 + c * 40)
  return `#${hex2(level(Math.floor(i / 36)))}${hex2(level(Math.floor(i / 6) % 6))}${hex2(level(i % 6))}`
}

function same(a: AnsiStyle, b: AnsiStyle): boolean {
  return a.fg === b.fg && a.bg === b.bg && !a.bold === !b.bold && !a.dim === !b.dim && !a.italic === !b.italic
    && !a.underline === !b.underline && !a.inverse === !b.inverse && !a.strike === !b.strike
}

/** Applies the parameters of one SGR sequence to the current state (unknown codes are ignored). */
function applySgr(state: AnsiStyle, raw: string): AnsiStyle {
  const s: AnsiStyle = { ...state }
  const p = raw === '' ? [0] : raw.split(/[;:]/).map(x => (x === '' ? 0 : Number(x)))
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === 0) { for (const k of Object.keys(s)) delete s[k as keyof AnsiStyle] }
    else if (c === 1) s.bold = true
    else if (c === 2) s.dim = true
    else if (c === 3) s.italic = true
    else if (c === 4) s.underline = true
    else if (c === 7) s.inverse = true
    else if (c === 9) s.strike = true
    else if (c === 22) { delete s.bold; delete s.dim }
    else if (c === 23) delete s.italic
    else if (c === 24) delete s.underline
    else if (c === 27) delete s.inverse
    else if (c === 29) delete s.strike
    else if (c >= 30 && c <= 37) s.fg = NAMED(c - 30)
    else if (c >= 90 && c <= 97) s.fg = NAMED(c - 90 + 8)
    else if (c >= 40 && c <= 47) s.bg = NAMED(c - 40)
    else if (c >= 100 && c <= 107) s.bg = NAMED(c - 100 + 8)
    else if (c === 39) delete s.fg
    else if (c === 49) delete s.bg
    else if (c === 38 || c === 48) {
      const key = c === 38 ? 'fg' : 'bg'
      if (p[i + 1] === 5) {
        const col = ansi256(p[i + 2])
        if (col) s[key] = col
        i += 2
      } else if (p[i + 1] === 2) {
        const [r, g, b] = [p[i + 2], p[i + 3], p[i + 4]]
        if ([r, g, b].every(v => Number.isFinite(v))) s[key] = `#${hex2(r)}${hex2(g)}${hex2(b)}`
        i += 4
      } else {
        // Unknown extended-color form: stop here rather than misread the remaining parameters.
        break
      }
    }
  }
  return s
}

/**
 * Parses text with ANSI escapes. State carries over line breaks (a color opened on one line stays active
 * on the next), segments with identical style are merged, empty segments are dropped.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  const out: AnsiSegment[] = []
  let state: AnsiStyle = {}
  let last = 0
  const push = (t: string) => {
    if (!t) return
    const prev = out[out.length - 1]
    if (prev && same(prev, state)) prev.text += t
    else out.push({ ...state, text: t })
  }
  const re = new RegExp(TOKEN.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    push(text.slice(last, m.index))
    last = m.index + m[0].length
    if (m[2] === 'm') state = applySgr(state, m[1])
    else if (m[3] !== undefined) state = applySgr(state, m[3])
  }
  push(text.slice(last))
  return out
}

/** The text without any escape sequence. */
export function stripAnsi(text: string): string {
  return parseAnsi(text).map(s => s.text).join('')
}

/** Keeps the first `max` visible characters of the segments. */
export function sliceAnsiSegments(segments: AnsiSegment[], max: number): AnsiSegment[] {
  const out: AnsiSegment[] = []
  let left = max
  for (const seg of segments) {
    if (left <= 0) break
    out.push(seg.text.length <= left ? seg : { ...seg, text: seg.text.slice(0, left) })
    left -= seg.text.length
  }
  return out
}

/** Inline style for a segment, or undefined when it carries none. */
export function ansiStyle(seg: AnsiStyle): CSSProperties | undefined {
  const fg = seg.inverse ? (seg.bg ?? 'var(--ansi-bg)') : seg.fg
  const bg = seg.inverse ? (seg.fg ?? 'var(--ansi-fg)') : seg.bg
  const style: CSSProperties = {}
  if (fg) style.color = fg
  if (bg) style.backgroundColor = bg
  if (seg.bold) style.fontWeight = 700
  if (seg.dim) style.opacity = 0.8
  if (seg.italic) style.fontStyle = 'italic'
  const deco = [seg.underline && 'underline', seg.strike && 'line-through'].filter(Boolean).join(' ')
  if (deco) style.textDecoration = deco
  return Object.keys(style).length ? style : undefined
}
