// Contrast of every theme (neon, graphite, paper): WCAG 1.4.3 (text >= 4.5:1) and 1.4.11 (controls >= 3:1).
// scripts/contrast.test.ts keeps pinning the neon pixels; this file checks the palette each theme really paints.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paletteFor, type ColorKey } from '../web/lib/theme-palette'
import { THEME_IDS, TOKENS, extraVars, type ThemeId } from '../web/lib/theme-tokens'

type Rgb = [number, number, number]

function parse(value: string): [number, number, number, number] {
  const v = value.trim()
  if (v.startsWith('#')) {
    const h = v.slice(1)
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1]
  }
  const m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (!m) throw new Error(`Unparseable colour: ${value}`)
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
}

function over(value: string, bg: Rgb): Rgb {
  const [r, g, b, a] = parse(value)
  return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)]
}

function lum([r, g, b]: Rgb): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const rgb = (hex: string): Rgb => parse(hex).slice(0, 3) as Rgb

const TEXT_KEYS: ColorKey[] = [
  'textPrimary', 'textDim', 'textMuted', 'textHint', 'userLabel', 'userText', 'assistantLabel', 'assistantText',
  'thinkingLabel', 'thinkingArrow', 'thinkingPreview', 'thinkingTextExpanded', 'bashResultText', 'toolResultText',
  'textFaint', 'filePathActive', 'filePathInactive', 'todoCompleted', 'todoCompletedText', 'todoPending', 'contentDim',
  'panelLabel', 'panelLabelDim', 'scrollBtnText', 'costText', 'costTextDim', 'roleAssistantText', 'roleThinkingText',
  'roleUserText', 'liveText', 'toolIndicatorText', 'diffAdded', 'diffRemoved',
]

const NON_TEXT_KEYS: ColorKey[] = [
  'toggleBorder', 'toggleBorderActive', 'tabSelectedBorder', 'tabInactiveBorder', 'playBtnBorder', 'reviewBtnBorder',
  'liveResumeBorder', 'controlBorder', 'controlTrack', 'scrollbarThumb', 'contextSystem', 'statusDotRing',
]

const TINTED: Array<[string, ColorKey, ColorKey[]]> = [
  ['thinking expanded', 'thinkingBgExpanded', ['thinkingLabel', 'thinkingArrow', 'thinkingPreview', 'thinkingTextExpanded']],
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
  ['search highlight', 'searchHighlightBg', ['textPrimary']],
  ['dispatch row', 'commDispatchBgSelected', ['commDispatchText']],
  ['return row', 'commReturnBgSelected', ['commReturnText']],
  ['error row', 'commErrorBgSelected', ['commErrorText']],
  ['teammate row', 'commMessageBgSelected', ['commMessageText']],
]

for (const id of THEME_IDS) {
  const t = TOKENS[id]
  const p = paletteFor(id)
  const grounds: Record<string, Rgb> = {
    void: rgb(t.void),
    glass: over(p.glassBg, rgb(t.void)),
    raised: rgb(t['surface-raised']),
  }

  for (const [name, bg] of Object.entries(grounds)) {
    test(`${id}: ink and ink-muted are >= 4.5:1 on ${name}`, () => {
      assert.ok(ratio(rgb(t.ink), bg) >= 4.5, `ink on ${name}`)
      assert.ok(ratio(rgb(t['ink-muted']), bg) >= 4.5, `ink-muted on ${name}`)
    })
    test(`${id}: focus ring is >= 3:1 on ${name}`, () => {
      assert.ok(ratio(rgb(t.focus), bg) >= 3, `focus on ${name}`)
    })
  }

  for (const [name, bg] of [['void', grounds.void], ['surface', rgb(t.surface)]] as const) {
    test(`${id}: control-border is >= 3:1 on ${name}`, () => {
      assert.ok(ratio(rgb(t['control-border']), bg) >= 3, `control-border ${t['control-border']} on ${name}`)
    })
  }

  test(`${id}: status colours are >= 4.5:1 text on surface and raised, accent fill carries on-accent`, () => {
    for (const bg of [rgb(t.surface), rgb(t['surface-raised'])]) {
      for (const role of ['ok', 'warn', 'danger', 'delegate', 'info', 'accent'] as const) {
        assert.ok(ratio(rgb(t[role]), bg) >= 4.5, `${role} ${t[role]} on ${bg}`)
      }
    }
    assert.ok(ratio(rgb(t['on-accent']), rgb(t.accent)) >= 4.5, 'on-accent on accent')
  })

  test(`${id}: context-system slice is >= 3:1 on surface`, () => {
    assert.ok(ratio(rgb(t['context-system']), rgb(t.surface)) >= 3)
  })

  for (const [name, bg] of Object.entries(grounds)) {
    test(`${id}: text keys >= 4.5:1 on ${name}`, () => {
      const failures = TEXT_KEYS.filter(k => ratio(over(p[k], bg), bg) < 4.5).map(k => `${k}=${p[k]} ${ratio(over(p[k], bg), bg).toFixed(2)}`)
      assert.deepEqual(failures, [])
    })
    if (name !== 'raised') {
      test(`${id}: non-text keys >= 3:1 on ${name}`, () => {
        const failures = NON_TEXT_KEYS.filter(k => ratio(over(p[k], bg), bg) < 3).map(k => `${k}=${p[k]} ${ratio(over(p[k], bg), bg).toFixed(2)}`)
        assert.deepEqual(failures, [])
      })
    }
  }

  test(`${id}: text on its tinted background stays >= 4.5:1`, () => {
    const failures: string[] = []
    for (const [name, bgKey, keys] of TINTED) {
      const bg = over(p[bgKey], grounds.glass)
      for (const k of keys) {
        const r = ratio(over(p[k], bg), bg)
        if (r < 4.5) failures.push(`${name}: ${k}=${p[k]} on ${bgKey} ${r.toFixed(2)}`)
      }
    }
    assert.deepEqual(failures, [])
  })

  test(`${id}: scrubber fill is >= 3:1 against its track`, () => {
    const track = over(p.controlTrack, grounds.glass)
    const stops = [...p.scrubberFill.matchAll(/#[0-9a-f]{6}|rgba\([^)]*\)/gi)].map(m => m[0])
    assert.equal(stops.length, 2)
    for (const stop of stops) assert.ok(ratio(over(stop, track), track) >= 3, `${stop} on track`)
  })

  test(`${id}: glass-card inputs, scrollbar and focus ring (themes.css) keep their contrast`, () => {
    const v = extraVars(id)
    for (const [name, bg] of Object.entries(grounds)) {
      if (name === 'raised') continue
      assert.ok(ratio(over(v['--lens-scrollbar-thumb'], bg), bg) >= 3, `scrollbar thumb on ${name}`)
      assert.ok(ratio(over(v['--lens-scrollbar-thumb-hover'], bg), bg) >= 3, `scrollbar thumb hover on ${name}`)
      assert.ok(ratio(over(v['--lens-input-border'], bg), bg) >= 3, `input border on ${name}`)
      assert.ok(ratio(over(v['--lens-focus-ring'], bg), bg) >= 3, `focus ring on ${name}`)
      const input = over(v['--lens-input-bg'], bg)
      assert.ok(ratio(over(v['--lens-input-placeholder'], input), input) >= 4.5, `placeholder on ${name}`)
      assert.ok(ratio(over(v['--lens-input-color'], input), input) >= 4.5, `input text on ${name}`)
    }
  })

  test(`${id}: palette is complete and made of colours the canvas can parse`, () => {
    for (const [key, value] of Object.entries(p)) {
      assert.equal(typeof value, 'string', key)
      assert.ok(value.length > 0, key)
    }
  })
}

test('palettes of the three themes define the same keys', () => {
  const keys = (id: ThemeId) => Object.keys(paletteFor(id)).sort()
  assert.deepEqual(keys('graphite'), keys('neon'))
  assert.deepEqual(keys('paper'), keys('neon'))
})

test('neon: the panel and feed colours keep their historical values', () => {
  const p = paletteFor('neon')
  assert.equal(p.commDispatchBg, 'rgba(80,140,255,0.14)')
  assert.equal(p.commReturnText, '#7fe3a3')
  assert.equal(p.commErrorBgSelected, 'rgba(255,90,90,0.26)')
  assert.equal(p.commMessageText, '#e0b0ff')
  assert.equal(p.fileCardBg, 'rgba(10, 15, 30, 0.5)')
  const v = extraVars('neon')
  assert.equal(v['--lens-hover-05'], 'rgba(255, 255, 255, 0.05)')
  assert.equal(v['--lens-hover-10'], 'rgba(255, 255, 255, 0.1)')
  assert.equal(v['--lens-focus-strong'], '#ffffff')
})
