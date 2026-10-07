import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

function composite(value: string, bg: Rgb, opacity = 1): Rgb {
  const [r, g, b, a0] = parseColor(value)
  const a = a0 * opacity
  return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)]
}

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/**
 * Effective contrast of a color rendered over `bg` with an extra CSS opacity multiplier.
 * Component-level tests use this to assert what is actually painted.
 */
export function effectiveContrast(color: string, bg: Rgb | string, opacity = 1): number {
  const base: Rgb = typeof bg === 'string' ? composite(bg, BACKGROUNDS.glass) : bg
  return ratio(composite(color, base, opacity), base)
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Tokens rendered as text (WCAG 1.4.3, 4.5:1)
const TEXT_TOKENS = [
  'textPrimary', 'textDim', 'textMuted', 'textHint',
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
  'toggleBorder', 'toggleBorderActive', 'tabSelectedBorder', 'tabInactiveBorder',
  'playBtnBorder', 'reviewBtnBorder', 'liveResumeBorder',
  'controlTrack', 'scrollbarThumb', 'contextSystem', 'statusDotRing',
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

test('glassBorder stays a restrained decorative value', () => {
  const [, , , a] = parseColor(COLORS.glassBorder)
  assert.ok(a >= 0.15 && a <= 0.3, `glassBorder alpha ${a}`)
})

test('selected tab/toggle borders are stronger than inactive ones', () => {
  for (const [sel, inactive] of [['tabSelectedBorder', 'tabInactiveBorder'], ['toggleBorderActive', 'toggleBorder']] as const) {
    for (const bg of Object.values(BACKGROUNDS)) {
      assert.ok(ratio(composite(COLORS[sel], bg), bg) > ratio(composite(COLORS[inactive], bg), bg), `${sel} vs ${inactive}`)
    }
  }
})

test('empty-state hierarchy: textDim heading and textHint are distinct and both compliant', () => {
  assert.notEqual(COLORS.textDim, COLORS.textHint)
  for (const bg of Object.values(BACKGROUNDS)) {
    assert.ok(ratio(composite(COLORS.textHint, bg), bg) >= 4.5)
  }
})

test('status dot ring has >= 3:1 against its dark inner gap', () => {
  const gap = composite(COLORS.statusDotRingInner, BACKGROUNDS.void)
  assert.ok(ratio(composite(COLORS.statusDotRing, gap), gap) >= 3)
})

test('effectiveContrast applies the opacity multiplier', () => {
  assert.ok(effectiveContrast(COLORS.textPrimary, BACKGROUNDS.glass, 0.3) < effectiveContrast(COLORS.textPrimary, BACKGROUNDS.glass, 1))
  assert.ok(effectiveContrast(COLORS.todoCompletedText, BACKGROUNDS.glass, 0.6) < 4.5, 'old 0.6 multiplier must stay forbidden')
})

// ─── Text tokens on their own tinted backgrounds ────────────────────────────

const TINTED: Array<[string, keyof typeof COLORS, Array<keyof typeof COLORS>]> = [
  ['thinking expanded', 'thinkingBgExpanded', ['thinkingLabel', 'thinkingArrow', 'thinkingPreview', 'thinkingTextExpanded']],
  ['thinking collapsed', 'thinkingBgCollapsed', ['thinkingLabel', 'thinkingArrow', 'thinkingPreview']],
  ['user message', 'userMsgBg', ['userLabel', 'userText']],
  ['tool call', 'toolCallBg', ['toolIndicatorText', 'textPrimary']],
  ['tool result', 'toolResultBg', ['toolResultText']],
  ['bash result', 'bashResultBg', ['bashResultText']],
  ['code block', 'codeBlockBg', ['contentDim', 'textPrimary']],
  ['diff removed', 'diffRemovedBg', ['diffRemoved']],
  ['diff added', 'diffAddedBg', ['diffAdded']],
  ['assistant role', 'roleAssistantBgSelected', ['roleAssistantText']],
  ['thinking role', 'roleThinkingBgSelected', ['roleThinkingText']],
  ['user role', 'roleUserBgSelected', ['roleUserText']],
]

for (const [name, bgToken, tokens] of TINTED) {
  for (const [baseName, base] of Object.entries(BACKGROUNDS)) {
    const tinted = composite(COLORS[bgToken] as string, base)
    for (const token of tokens) {
      test(`${token} >= 4.5:1 on ${name} background over ${baseName}`, () => {
        const r = ratio(composite(COLORS[token] as string, tinted), tinted)
        assert.ok(r >= 4.5, `${token} is ${r.toFixed(2)}:1 on ${name}`)
      })
    }
  }
}

// ─── globals.css values ─────────────────────────────────────────────────────

const css = readFileSync(join(__dirname, '../web/app/globals.css'), 'utf8')

function cssValue(selector: string, prop: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = css.match(new RegExp(`${esc}\\s*\\{([^}]*)\\}`))
  assert.ok(block, `selector ${selector} not found in globals.css`)
  const m = block[1].match(new RegExp(`${prop}:\\s*(?:1px solid |2px solid )?([^;!]+?)\\s*(?:!important)?;`))
  assert.ok(m, `${prop} not found in ${selector}`)
  return m[1]
}

for (const [bgName, bg] of Object.entries(BACKGROUNDS)) {
  test(`globals.css scrollbar thumb >= 3:1 on ${bgName}`, () => {
    const v = cssValue('.glass-card ::-webkit-scrollbar-thumb', 'background')
    assert.ok(ratio(composite(v, bg), bg) >= 3, v)
  })
  test(`globals.css input border >= 3:1 on ${bgName}`, () => {
    const v = cssValue('.glass-card input,\n.glass-card textarea,\n.glass-card select', 'border')
    assert.ok(ratio(composite(v, bg), bg) >= 3, v)
  })
  test(`globals.css placeholder >= 4.5:1 on input background over ${bgName}`, () => {
    const inputBg = composite(cssValue('.glass-card input,\n.glass-card textarea,\n.glass-card select', 'background'), bg)
    const v = cssValue('.glass-card input::placeholder,\n.glass-card textarea::placeholder', 'color')
    assert.ok(ratio(composite(v, inputBg), inputBg) >= 4.5, v)
  })
  test(`globals.css focus ring >= 3:1 on ${bgName}`, () => {
    const v = cssValue(':focus-visible', 'outline')
    assert.ok(ratio(composite(v, bg), bg) >= 3, v)
  })
}

test('globals.css .glass-card border is decorative and matches glassBorder', () => {
  const v = cssValue('.glass-card', 'border')
  assert.equal(parseColor(v)[3], parseColor(COLORS.glassBorder)[3])
})
