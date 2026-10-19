// #594: what the "N names hidden" button shows, from the readings of the plan's count (every 200 ms). The button must
// not blink while the camera moves (a transient count of 1 during a fit), nor move the controls; and it never shows a
// number that is not the reading of the frame drawn: while the count changes, it shows the neutral label (no number).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { HIDDEN_NAMES_INITIAL, stepHiddenNames, type HiddenNamesState } from '../web/lib/hidden-names-display'

/** The stable delay of web/lib/hidden-names-display.ts */
const STABLE_MS = 500
type Read ={ raw: number; busy?: boolean; focused?: boolean }
/** Feeds one reading every 200 ms; returns what the button showed after each one */
function run(reads: Read[], start: HiddenNamesState = HIDDEN_NAMES_INITIAL) {
  let s = start
  return reads.map((r, i) => {
    s = stepHiddenNames(s, { raw: r.raw, now: 1000 + i * 200, cameraBusy: !!r.busy, focused: !!r.focused })
    return { shown: s.shown, count: s.count }
  })
}

test('no reading of names hidden: no button', () => {
  assert.deepEqual(run([{ raw: 0 }, { raw: 0 }]).at(-1), { shown: false, count: null })
})

test('the button appears only once the count stayed the same for the stable delay, camera at rest', () => {
  const out = run([{ raw: 3 }, { raw: 3 }, { raw: 3 }, { raw: 3 }])
  const firstShown = out.findIndex(o => o.shown)
  assert.ok(firstShown * 200 >= STABLE_MS, `appears after ${firstShown * 200} ms`)
  assert.deepEqual(out.at(-1), { shown: true, count: 3 })
})

test('a count of 0 then 1 then 0 between two readings (fit from under 35 %) never changes the button', () => {
  const out = run([{ raw: 0 }, { raw: 1 }, { raw: 0 }, { raw: 1 }, { raw: 0 }, { raw: 0 }, { raw: 0 }, { raw: 0 }])
  for (const o of out) assert.deepEqual(o, { shown: false, count: null })
})

test('while the camera moves nothing appears, even with a steady count', () => {
  const out = run(Array.from({ length: 10 }, () => ({ raw: 2, busy: true })))
  for (const o of out) assert.equal(o.shown, false)
})

test('shown: a count that alternates keeps the button, with the neutral label (never a stale number)', () => {
  const settled = run([{ raw: 7 }, { raw: 7 }, { raw: 7 }, { raw: 7 }])
  assert.deepEqual(settled.at(-1), { shown: true, count: 7 })
  let s = HIDDEN_NAMES_INITIAL
  for (let i = 0; i < 4; i++) s = stepHiddenNames(s, { raw: 7, now: 1000 + i * 200, cameraBusy: false, focused: false })
  const out = run([{ raw: 6 }, { raw: 0 }, { raw: 6 }, { raw: 7 }, { raw: 0 }], s)
  for (const o of out) {
    assert.equal(o.shown, true, 'the button stays while the count is not stable')
    assert.equal(o.count, null, 'no number while the reading differs from the one shown')
  }
})

test('shown: an unchanged reading keeps its number while the camera moves', () => {
  let s = HIDDEN_NAMES_INITIAL
  for (let i = 0; i < 4; i++) s = stepHiddenNames(s, { raw: 5, now: 1000 + i * 200, cameraBusy: false, focused: false })
  const out = run([{ raw: 5, busy: true }, { raw: 5, busy: true }], s)
  for (const o of out) assert.deepEqual(o, { shown: true, count: 5 })
})

test('the number shown is always the latest reading', () => {
  const reads = [0, 4, 4, 4, 4, 5, 5, 5, 5, 3, 0, 0, 0, 0, 2].map(raw => ({ raw }))
  const out = run(reads)
  out.forEach((o, i) => { if (o.count !== null) assert.equal(o.count, reads[i].raw, `reading ${i}`) })
})

test('back to 0 for the stable delay: the button goes, unless it has the keyboard focus', () => {
  let s = HIDDEN_NAMES_INITIAL
  for (let i = 0; i < 4; i++) s = stepHiddenNames(s, { raw: 2, now: 1000 + i * 200, cameraBusy: false, focused: false })
  assert.equal(run([{ raw: 0 }, { raw: 0 }, { raw: 0 }, { raw: 0 }], s).at(-1)?.shown, false)
  const focused = run([{ raw: 0, focused: true }, { raw: 0, focused: true }, { raw: 0, focused: true }, { raw: 0, focused: true }], s)
  assert.deepEqual(focused.at(-1), { shown: true, count: null }, 'focused: kept, with no number')
})
