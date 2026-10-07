import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COLORS, ROLE_COLORS } from '../web/lib/colors'
import {
  truncateWithMarker, formatElapsed, agentsWithNewText, nextTabIndex, stateLabel, STATE_LABELS,
} from '../web/components/agent-visualizer/feed-utils'

// ─── Pure helpers ───────────────────────────────────────────────────────────

test('truncateWithMarker leaves short text untouched', () => {
  assert.deepEqual(truncateWithMarker('abc', 5), { text: 'abc', hidden: 0, marker: '' })
})

test('truncateWithMarker reports hidden chars', () => {
  const r = truncateWithMarker('abcdefghij', 4)
  assert.equal(r.text, 'abcd')
  assert.equal(r.hidden, 6)
  assert.equal(r.marker, '… (+6 chars)')
})

test('formatElapsed produces m:ss and an ISO duration', () => {
  assert.deepEqual(formatElapsed(75.4), { label: '1:15', iso: 'PT75.4S' })
  assert.equal(formatElapsed(-3).label, '0:00')
  assert.equal(formatElapsed(NaN).iso, 'PT0.0S')
})

test('agentsWithNewText only reports agents whose text count increased', () => {
  const types = new Set(['assistant', 'user', 'thinking'])
  const conv = new Map([
    ['a', [{ type: 'assistant' }, { type: 'tool_call' }]],
    ['b', [{ type: 'assistant' }]],
    ['c', [{ type: 'assistant' }]],
  ])
  const first = agentsWithNewText(new Map(), conv, types)
  assert.deepEqual(first.increased.sort(), ['a', 'b', 'c'])

  // a gets only a tool call, b gets text, c unchanged
  const conv2 = new Map([
    ['a', [...conv.get('a')!, { type: 'tool_result' }]],
    ['b', [...conv.get('b')!, { type: 'thinking' }]],
    ['c', conv.get('c')!],
  ])
  const second = agentsWithNewText(first.nextLens, conv2, types)
  assert.deepEqual(second.increased, ['b'])
})

test('nextTabIndex wraps and supports Home/End', () => {
  assert.equal(nextTabIndex('ArrowRight', 2, 3), 0)
  assert.equal(nextTabIndex('ArrowLeft', 0, 3), 2)
  assert.equal(nextTabIndex('Home', 2, 3), 0)
  assert.equal(nextTabIndex('End', 0, 3), 2)
  assert.equal(nextTabIndex('a', 0, 3), null)
  assert.equal(nextTabIndex('Home', 0, 0), null)
})

test('state labels contain no underscores', () => {
  for (const label of Object.values(STATE_LABELS)) assert.ok(!label.includes('_'))
  assert.equal(stateLabel('some_new_state'), 'some new state')
})

// ─── Effective contrast of the token combos used by the feed components ────

type Rgb = [number, number, number]
const GLASS: Rgb = [0x09, 0x0c, 0x1a]

function parse(value: string): [number, number, number, number] {
  const v = value.trim()
  if (v.startsWith('#')) {
    const h = v.slice(1)
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1]
  }
  const m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (!m) throw new Error(`Unparseable color: ${value}`)
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

/** Contrast of `fg` (composited) over layered backgrounds on the glass panel. */
function effective(fg: string, ...layers: string[]): number {
  let bg = GLASS
  for (const l of layers) bg = over(l, bg)
  return ratio(over(fg, bg), bg)
}

const combos: Array<[string, string, string[]]> = []
for (const [name, role] of Object.entries(ROLE_COLORS)) {
  combos.push([`role ${name} text on bg`, role.text, [role.bg]])
  combos.push([`role ${name} text on selected bg`, role.text, [role.bgSelected]])
}
combos.push(
  ['textMuted on glass', COLORS.textMuted, []],
  ['todoCompletedText on glass', COLORS.todoCompletedText, []],
  ['todoPending on glass', COLORS.todoPending, []],
  ['contentDim on code block', COLORS.contentDim, [COLORS.codeBlockBg]],
  ['tool_calling on code block', COLORS.tool_calling, [COLORS.codeBlockBg]],
  ['filePathActive on code block', COLORS.filePathActive, [COLORS.codeBlockBg]],
  ['filePathInactive on glass', COLORS.filePathInactive, []],
  ['diffRemoved on removed bg', COLORS.diffRemoved, [COLORS.codeBlockBg, COLORS.diffRemovedBg]],
  ['diffAdded on added bg', COLORS.diffAdded, [COLORS.codeBlockBg, COLORS.diffAddedBg]],
  ['thinkingPreview on collapsed', COLORS.thinkingPreview, [COLORS.thinkingBgCollapsed]],
  ['thinkingTextExpanded on expanded', COLORS.thinkingTextExpanded, [COLORS.thinkingBgExpanded]],
  ['bashResultText on bash bg', COLORS.bashResultText, [COLORS.bashResultBg]],
  ['toolResultText on result bg', COLORS.toolResultText, [COLORS.toolResultBg]],
  ['tool color on file row', COLORS.tool, ['rgba(10, 15, 30, 0.5)']],
  ['filePathActive on file row', COLORS.filePathActive, ['rgba(10, 15, 30, 0.5)']],
  ['error heat on file row', COLORS.error, ['rgba(10, 15, 30, 0.5)']],
)

for (const [name, fg, layers] of combos) {
  test(`feed contrast: ${name} >= 4.5:1`, () => {
    const r = effective(fg, ...layers)
    assert.ok(r >= 4.5, `${name} is ${r.toFixed(2)}:1`)
  })
}

test('feed contrast: search input border >= 3:1', () => {
  const r = effective(COLORS.controlBorder, COLORS.holoBg05)
  assert.ok(r >= 3, `border is ${r.toFixed(2)}:1`)
})
