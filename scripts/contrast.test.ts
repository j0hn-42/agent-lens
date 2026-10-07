import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COLORS } from '../web/lib/colors'

type Rgb = [number, number, number]

const BACKGROUNDS: Record<string, Rgb> = {
  void: [0x05, 0x05, 0x10],
  glass: [0x09, 0x0c, 0x1a],
}

/** Parse #rgb, #rrggbb, #rrggbbaa or rgba()/rgb() into [r,g,b,a]. */
function parseColor(value: string): [number, number, number, number] {
  const v = value.trim()
  if (v.startsWith('#')) {
    const h = v.slice(1)
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
      return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1]
    }
  }
  const m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
  throw new Error(`Unparseable color: ${value}`)
}

function composite(value: string, bg: Rgb): Rgb {
  const [r, g, b, a] = parseColor(value)
  return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)]
}

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Tokens rendered as text (WCAG 1.4.3, 4.5:1)
const TEXT_TOKENS = [
  'textPrimary', 'textDim', 'textMuted',
  'userLabel', 'userText', 'assistantLabel', 'assistantText',
  'thinkingLabel', 'thinkingArrow', 'thinkingPreview', 'thinkingTextExpanded',
  'bashResultText', 'toolResultText', 'textFaint',
  'filePathActive', 'filePathInactive',
  'todoCompleted', 'todoCompletedText', 'todoPending', 'contentDim',
  'panelLabel', 'panelLabelDim', 'scrollBtnText',
  'costText', 'costTextDim',
  'roleAssistantText', 'roleThinkingText', 'roleUserText',
] as const

// Tokens used for control borders, tracks and graphical objects (WCAG 1.4.11, 3:1)
const NON_TEXT_TOKENS = [
  'glassBorder', 'toggleBorder', 'tabSelectedBorder', 'tabInactiveBorder',
  'playBtnBorder', 'reviewBtnBorder', 'liveResumeBorder',
  'controlTrack', 'scrollbarThumb', 'contextSystem',
] as const

for (const [bgName, bg] of Object.entries(BACKGROUNDS)) {
  for (const token of TEXT_TOKENS) {
    test(`text token ${token} >= 4.5:1 on ${bgName}`, () => {
      const r = ratio(composite(COLORS[token], bg), bg)
      assert.ok(r >= 4.5, `${token}=${COLORS[token]} is ${r.toFixed(2)}:1 on ${bgName}`)
    })
  }
  for (const token of NON_TEXT_TOKENS) {
    test(`non-text token ${token} >= 3:1 on ${bgName}`, () => {
      const r = ratio(composite(COLORS[token], bg), bg)
      assert.ok(r >= 3, `${token}=${COLORS[token]} is ${r.toFixed(2)}:1 on ${bgName}`)
    })
  }
}
