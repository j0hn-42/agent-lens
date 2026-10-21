// The agent card and the System panel are read, not glanced at: their rows carry counts, durations, model names and
// file paths. Both used to draw almost everything at 11 px (badges at 10 px) in a 240 x 240 box, so the content had to
// be scrolled a row at a time. Here the floor is pinned: nothing in those two cards is drawn below 11 px, the rows are
// at 12 px or more, and the agent's own name is larger than its rows. The room that holds the content is pinned in
// panel-layout.test.ts (DETAIL_SIZE, SYSTEM_H).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CARDS = ['agent-detail-card.tsx', 'system-panel.tsx'] as const

function source(file: string): string {
  return readFileSync(join(__dirname, '..', 'web', 'components', 'agent-visualizer', file), 'utf8')
}

/** px size of every font-size class the two cards use: the arbitrary ones and the named Tailwind steps. */
const NAMED_PX: Record<string, number> = { 'text-xs': 12, 'text-sm': 14, 'text-base': 16, 'text-lg': 18 }

/** Every font size the file sets, in px, with the class it came from. */
function fontSizes(src: string): Array<{ cls: string; px: number }> {
  const out: Array<{ cls: string; px: number }> = []
  for (const m of src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) out.push({ cls: m[0], px: Number(m[1]) })
  for (const [cls, px] of Object.entries(NAMED_PX)) {
    for (const _ of src.matchAll(new RegExp(`(?<![\\w-])${cls}(?![\\w-])`, 'g'))) out.push({ cls, px })
  }
  return out
}

/** The smallest size allowed at all: a badge or a note, never a row of content. */
const FLOOR_PX = 11
/** The smallest size allowed for a row of content. */
const ROW_PX = 12

test('neither card draws text below 11 px', () => {
  for (const file of CARDS) {
    const sizes = fontSizes(source(file))
    assert.ok(sizes.length > 0, `${file}: no font size found, the scan is broken`)
    for (const { cls, px } of sizes) {
      assert.ok(px >= FLOOR_PX, `${file}: ${cls} is ${px} px, below the ${FLOOR_PX} px floor`)
    }
  }
})

test('the rows of both cards are at 12 px or more: only a badge or a note may stay at 11 px', () => {
  for (const file of CARDS) {
    const small = fontSizes(source(file)).filter(s => s.px < ROW_PX)
    assert.ok(small.length <= 2, `${file}: ${small.length} uses of a sub-${ROW_PX} px size, the rows are not meant to be among them`)
  }
})

test('the agent card names its agent larger than its rows', () => {
  const src = source('agent-detail-card.tsx')
  const at = src.indexOf('{agent.name}')
  assert.ok(at > 0, 'the name is rendered')
  // The className of the element that holds the name: the last one opened before it
  const cls = [...src.slice(Math.max(0, at - 400), at).matchAll(/className="([^"]*)"/g)].pop()?.[1] ?? ''
  const px = fontSizes(cls).map(s => s.px).sort((a, b) => b - a)[0] ?? 0
  assert.ok(px > ROW_PX, `the agent name is drawn at ${px} px, no larger than the ${ROW_PX} px of a row`)
})
