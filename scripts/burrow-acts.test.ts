// Burrow view: an agent that needs you. At the post beside the front door it stands under a "?", calls you (an animal
// waves, the squirrel knocks on the air), then sulks under "...", in cycles, for as long as the observed wait lasts. Every
// frame is a pure function of the time waited, so the still scene (reduced motion, Freeze motion) shows the same stage.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { actDrawList, glassOwner, needsYouFrame, SIGN_LIFT } from '../web/lib/burrow/burrow-acts'
import { BURROW_DATA } from '../web/lib/burrow/burrow-data'

const fox = BURROW_DATA.sprites.fox
const squirrel = BURROW_DATA.sprites.squirrel
const rects = BURROW_DATA.fx.rects
const frame = (meta: typeof fox, elapsed: number, o: { still?: boolean; bursts?: boolean } = {}) =>
  needsYouFrame({ elapsed, still: o.still ?? false, meta, bursts: o.bursts ?? false })
/** Samples a frame every 10 ms between two instants (half a step off the boundaries, which are whole hundredths) */
const sample = (meta: typeof fox, from: number, to: number, o: { still?: boolean; bursts?: boolean } = {}) => {
  const out: Array<{ t: number; f: ReturnType<typeof frame> }> = []
  for (let i = Math.round(from * 100); i < Math.round(to * 100); i++) out.push({ t: (i + 0.5) / 100, f: frame(meta, (i + 0.5) / 100, o) })
  return out
}

test('the fox (a drawing with a wave): it stands under "?" for 8 s, then waves under "?" until 26.75 s, then sulks standing under "..." until 46.75 s, and calls again', () => {
  for (const { t, f } of sample(fox, 0, 8)) assert.deepEqual([f.stage, f.pose, f.sign], ['wonder', null, 'ask'], `${t}`)
  const call = sample(fox, 8, 26.75)
  for (const { t, f } of call) { assert.equal(f.stage, 'call', `${t}`); assert.equal(f.sign, 'ask'); assert.ok(f.pose === 'wave' || f.pose === null, `${t} ${f.pose}`) }
  assert.equal(frame(fox, 8.1).pose, 'wave', 'it waves at once')
  assert.equal(frame(fox, 8.5).pose, null, 'and pauses between two waves')
  // three waves and a pause per round of 3.75 s
  const waves = call.filter(({ f }, i) => f.pose === 'wave' && (i === 0 || call[i - 1].f.pose !== 'wave')).length
  assert.equal(waves, 15, 'five rounds of three waves')
  for (const { t, f } of sample(fox, 26.75, 46.75)) assert.deepEqual([f.stage, f.pose, f.sign], ['sulk', null, 'dots'], `${t}`)
  assert.deepEqual([frame(fox, 46.8).stage, frame(fox, 46.8).sign], ['call', 'ask'])
  assert.equal(frame(fox, 8 + 38.75 * 3 + 1).stage, 'call', 'the cycle repeats every 38.75 s')
  for (const { f } of sample(fox, 0, 90, { bursts: true })) assert.deepEqual(f.fx, [], 'no burst for a waving animal')
})

test('the squirrel: it thinks and looks at you under "?", knocks on the air from 8 s, then taps its foot, arms crossed, under "..." from 27.5 s', () => {
  const wonder = sample(squirrel, 0, 8)
  assert.deepEqual(new Set(wonder.map(({ f }) => f.pose)), new Set(['think', 'front']))
  assert.equal(frame(squirrel, 1).pose, 'think')
  assert.equal(frame(squirrel, 3).pose, 'front', '2.6 s thinking, 0.8 s looking at you')
  for (const { f } of wonder) assert.equal(f.sign, 'ask')
  const call = sample(squirrel, 8, 27.5)
  for (const { t, f } of call) { assert.equal(f.stage, 'call', `${t}`); assert.equal(f.sign, 'ask'); assert.ok(['front', 'knockA', 'think'].includes(String(f.pose)), `${t} ${f.pose}`) }
  assert.equal(frame(squirrel, 8.4).pose, 'knockA')
  for (const { t, f } of sample(squirrel, 27.5, 47.5)) {
    assert.equal(f.stage, 'sulk', `${t}`)
    assert.equal(f.sign, 'dots')
    assert.ok(f.pose === 'crossA' || f.pose === 'crossB', `${t} ${f.pose}`)
  }
  assert.equal(frame(squirrel, 47.6).stage, 'call', 'every 39.5 s')
})

test('a knock burst shows for 0.13 s after each knock, only for the agent given the bursts, never in the still scene', () => {
  // the knocks of a round start 0.34 s, 0.84 s and 1.34 s after the round starts
  for (const k of [0.34, 0.84, 1.34]) {
    for (const round of [0, 1, 4]) {
      const at = 8 + round * 3.9 + k
      assert.deepEqual(frame(squirrel, at + 0.05, { bursts: true }).fx.map((x) => x.name), ['w_hitS'], `knock at ${at}`)
      assert.deepEqual(frame(squirrel, at + 0.14, { bursts: true }).fx, [], `over 0.13 s after the knock at ${at}`)
      assert.equal(frame(squirrel, at + 0.05, { bursts: true }).pose, 'knockA')
    }
  }
  const burst = frame(squirrel, 8.4, { bursts: true }).fx[0]
  assert.deepEqual([burst.dx, burst.dy], [-5, -13], 'at the fist, in front of its body')
  for (const { f } of sample(squirrel, 0, 90)) assert.deepEqual(f.fx, [], 'no burst for an agent not given them')
  for (const { f } of sample(squirrel, 0, 90, { bursts: true, still: true })) assert.deepEqual(f.fx, [], 'none in the still scene')
})

test('flashes: two knock bursts are at least half a second apart, so never more than two a second (WCAG 2.3.1, the app limit)', () => {
  const onsets: number[] = []
  let was = false
  for (const { t, f } of sample(squirrel, 0, 200, { bursts: true })) {
    const on = f.fx.length > 0
    if (on && !was) onsets.push(t)
    was = on
  }
  assert.ok(onsets.length > 30, `${onsets.length} bursts in 200 s`)
  for (let i = 1; i < onsets.length; i++) assert.ok(onsets[i] - onsets[i - 1] >= 0.5 - 1e-9, `${onsets[i - 1]} -> ${onsets[i]}`)
  // in any window of one second, at most two
  for (const t of onsets) assert.ok(onsets.filter((x) => x >= t && x < t + 1).length <= 2, `at ${t}`)
})

test('the still scene shows the stage held: "?" thinking / standing, then knocking / waving, then "..." arms crossed / standing', () => {
  const still = (meta: typeof fox, t: number) => { const f = frame(meta, t, { still: true }); return [f.stage, f.pose, f.sign] }
  assert.deepEqual(still(squirrel, 1), ['wonder', 'think', 'ask'])
  assert.deepEqual(still(squirrel, 3), ['wonder', 'think', 'ask'], 'one frame per stage, not a sequence')
  assert.deepEqual(still(fox, 1), ['wonder', null, 'ask'])
  assert.deepEqual(still(squirrel, 9), ['call', 'knockA', 'ask'])
  assert.deepEqual(still(squirrel, 20), ['call', 'knockA', 'ask'])
  assert.deepEqual(still(fox, 9), ['call', 'wave', 'ask'])
  assert.deepEqual(still(fox, 8.5), ['call', 'wave', 'ask'])
  assert.deepEqual(still(squirrel, 30), ['sulk', 'crossA', 'dots'])
  assert.deepEqual(still(fox, 30), ['sulk', null, 'dots'])
})

test('a drawing with neither a wave nor a knock stands under its signs', () => {
  const plain = { ...fox, poses: {} }
  assert.deepEqual([frame(plain, 10).pose, frame(plain, 10).sign], [null, 'ask'])
  assert.deepEqual([frame(plain, 40).pose, frame(plain, 40).sign], [null, 'dots'])
})

test('actDrawList: the sign sits over the head of the drawn pose, centred, bobbing 1 px with motion, still without; effects centred on their offset', () => {
  const a = { x: 100.4, y: 200.2, meta: squirrel }
  const ask = rects.w_ask
  const f = { pose: 'knockA', sign: 'ask' as const, fx: [{ name: 'w_hitS', dx: -5, dy: -13 }] }
  const still = actDrawList(a, f, rects, 0.3, true)
  const top = 200 - squirrel.poses.knockA.h
  assert.deepEqual(still.find((x) => x.name === 'w_ask'), { name: 'w_ask', x: 100 - (ask[2] >> 1), y: top - ask[3] - 3, alpha: 1 })
  const hit = rects.w_hitS
  assert.deepEqual(still.find((x) => x.name === 'w_hitS'), { name: 'w_hitS', x: 95 - (hit[2] >> 1), y: 187 - (hit[3] >> 1), alpha: 1 })
  const ys = new Set<number>()
  for (let c = 0; c < 2; c += 0.05) ys.add(actDrawList(a, f, rects, c, false).find((x) => x.name === 'w_ask')!.y)
  assert.ok(ys.size >= 2 && Math.max(...ys) - Math.min(...ys) <= 2, `bob of ${[...ys]}`)
  for (let c = 0; c < 2; c += 0.05) assert.equal(actDrawList(a, f, rects, c, true).find((x) => x.name === 'w_ask')!.y, top - ask[3] - 3)
  // the standing frame: the animal's own height; the dots and the "!" have their rects
  const standing = actDrawList(a, { pose: null, sign: 'dots', fx: [] }, rects, 0, true)
  assert.deepEqual(standing, [{ name: 'w_dots', x: 100 - (rects.w_dots[2] >> 1), y: 200 - squirrel.h - rects.w_dots[3] - 3, alpha: 1 }])
  assert.equal(actDrawList(a, { sign: 'alert', fx: [] }, rects, 0, true)[0].name, 'w_alert')
  assert.deepEqual(actDrawList(a, { sign: null, fx: [] }, rects, 0, true), [])
  // the bubble is raised above the tallest sign
  assert.ok(SIGN_LIFT >= Math.max(rects.w_ask[3], rects.w_dots[3], rects.w_alert[3]) + 3)
})

test('glassOwner: the waiting agent with the squirrel that has waited longest, ties by key; other animals never', () => {
  const metas: Record<string, typeof fox> = { a: squirrel, b: squirrel, c: squirrel, f: fox }
  const of = (k: string) => metas[k]
  assert.equal(glassOwner(new Map(), of), null)
  assert.equal(glassOwner(new Map([['f', 1]]), of), null, 'a fox has no knock')
  assert.equal(glassOwner(new Map([['f', 1], ['b', 5], ['a', 9]]), of), 'b')
  assert.equal(glassOwner(new Map([['c', 5], ['b', 5]]), of), 'b')
  assert.equal(glassOwner(new Map([['x', 1], ['c', 5]]), of), 'c', 'an unknown key is skipped')
})
