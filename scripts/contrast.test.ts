import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { COLORS } from '../web/lib/colors'
import { FRESHNESS_DRAW } from '../web/lib/canvas-constants'

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
  'controlBorder', 'controlTrack', 'scrollbarThumb', 'contextSystem', 'statusDotRing',
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

// ─── Scrubber fill, Firefox scrollbar, hover ────────────────────────────────

test('scrubberFill gradient stops are >= 3:1 against the controlTrack they are painted over', () => {
  const stops = COLORS.scrubberFill.match(/rgba?\([^)]*\)/g)
  assert.ok(stops && stops.length >= 2, 'expected gradient stops')
  for (const bg of Object.values(BACKGROUNDS)) {
    const track = composite(COLORS.controlTrack, bg)
    for (const stop of stops) {
      const r = ratio(composite(stop, track), track)
      assert.ok(r >= 3, `${stop} is ${r.toFixed(2)}:1 on the track`)
    }
  }
})

for (const [bgName, bg] of Object.entries(BACKGROUNDS)) {
  test(`globals.css scrollbar thumb:hover >= 3:1 on ${bgName}`, () => {
    const v = cssValue('.glass-card ::-webkit-scrollbar-thumb:hover', 'background')
    assert.ok(ratio(composite(v, bg), bg) >= 3, v)
  })
  test(`globals.css Firefox scrollbar-color thumb >= 3:1 on ${bgName}`, () => {
    const v = cssValue('.glass-card,\n.glass-card *', 'scrollbar-color')
    const thumb = v.match(/rgba?\([^)]*\)|#[0-9a-f]{6,8}/i)
    assert.ok(thumb, v)
    assert.ok(ratio(composite(thumb[0], bg), bg) >= 3, v)
  })
}

test('globals.css sets scrollbar-width for Firefox on glass cards', () => {
  assert.match(cssValue('.glass-card,\n.glass-card *', 'scrollbar-width'), /thin|auto/)
})

// ─── Focus killers must stay gone ───────────────────────────────────────────

test('no outline-ring/50 anywhere in globals.css', () => {
  assert.ok(!/outline-ring\/50/.test(css), 'outline-ring/50 dims the focus ring below 3:1')
})

test('no `outline: none` rule in globals.css', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  for (const [, selector, body] of rules) {
    assert.ok(!/outline(-style)?:\s*(none|0)\b/.test(body), `rule "${selector.trim()}" removes the outline`)
  }
})

test('inputs keep a real outline on focus', () => {
  const v = cssValue('.glass-card input:focus,\n.glass-card textarea:focus', 'outline')
  assert.ok(!/none/.test(v), v)
})

// ─── statusDotRing against the real backgrounds, effectiveContrast ──────────

for (const [bgName, bg] of Object.entries(BACKGROUNDS)) {
  test(`statusDotRing >= 3:1 on ${bgName} (real background, not only the gap)`, () => {
    assert.ok(ratio(composite(COLORS.statusDotRing, bg), bg) >= 3)
  })
}

test('effectiveContrast is monotonic across several opacities and matches the 1.0 case', () => {
  const opacities = [1, 0.8, 0.6, 0.4, 0.2]
  for (const token of ['textPrimary', 'textDim', 'todoCompletedText'] as const) {
    const values = opacities.map(o => effectiveContrast(COLORS[token], BACKGROUNDS.glass, o))
    for (let i = 1; i < values.length; i++) assert.ok(values[i] < values[i - 1], `${token} at ${opacities[i]}`)
    const direct = ratio(composite(COLORS[token], BACKGROUNDS.glass), BACKGROUNDS.glass)
    assert.ok(Math.abs(values[0] - direct) < 1e-9)
  }
  assert.ok(effectiveContrast(COLORS.textPrimary, BACKGROUNDS.glass, 0) < 1.0001, 'opacity 0 is invisible')
  assert.ok(effectiveContrast(COLORS.textMuted, BACKGROUNDS.void, 0.5) < 4.5)
})

// ─── glassBorder must not be a control boundary ─────────────────────────────

/**
 * Heuristic: for every `COLORS.glassBorder` use in web/components tsx files, take the JSX opening tag
 * it belongs to (from the nearest preceding `<Tag`, up to the first `>` that is not part of `=>`),
 * and fail if that tag is a button/input/textarea/select, has onClick, or has type="button".
 * Canvas-drawing .ts files and decorative cards/dividers are not matched. Control borders must use
 * controlBorder / toggleBorder / tabInactiveBorder (>= 3:1).
 */
function listTsx(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? listTsx(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : [])
}

function openingTagAround(src: string, index: number): string {
  const start = src.slice(0, index).search(/<[A-Za-z][^<]*$/)
  let end = index
  while (end < src.length && !(src[end] === '>' && src[end - 1] !== '=')) end++
  return src.slice(start === -1 ? index : start, end + 1)
}

test('openingTagAround heuristic picks the enclosing tag', () => {
  const src = `<div><button type="button" style={{ border: COLORS.glassBorder }}>x</button></div>`
  assert.match(openingTagAround(src, src.indexOf('COLORS')), /^<button/)
})

test('COLORS.glassBorder is not used on buttons or inputs in web/components', () => {
  const offenders: string[] = []
  for (const file of listTsx(join(__dirname, '../web/components'))) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/COLORS\.glassBorder/g)) {
      const tag = openingTagAround(src, m.index)
      if (/^<(button|input|textarea|select)\b/.test(tag) || /\bonClick=|type="button"/.test(tag)) {
        offenders.push(`${file.split('web/components/')[1]}: ${tag.slice(0, 80).replace(/\s+/g, ' ')}`)
      }
    }
  }
  assert.deepEqual(offenders, [], 'use controlBorder for control boundaries')
})

// #145: the "last known state" label of a stale node is read over the dark violet halo of its session,
// not only over the void. Dark violet worst case: the halo tint at its strongest.
test('stale node label >= 4.5:1 on the void and on the dark violet session halo', () => {
  for (const [name, bg] of Object.entries({ ...BACKGROUNDS, violetHalo: [0x2a, 0x18, 0x3a] as Rgb })) {
    const r = ratio(composite(FRESHNESS_DRAW.staleTextColor, bg), bg)
    assert.ok(r >= 4.5, `staleTextColor=${FRESHNESS_DRAW.staleTextColor} is ${r.toFixed(2)}:1 on ${name}`)
  }
})
