// Burrow view: the squirrel's close-up at the glass. Where it may stand: on the bottom edge of the picture (or on what
// covers the bottom), in a gap between two room titles, never over a title mat, a post, a docked panel, the timeline or
// the burrow's own controls; no close-up when no gap is free. What it does: five visits, each tried after a scene at its
// post, up to the crack and the tape, every frame a pure function of the time waited (the still scene shows the same).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createBurrowEngine } from '../web/lib/burrow/burrow-engine'
import { glassBand, glassDrawList, glassFrame, glassHit, glassPlace, glassSoundsBetween } from '../web/lib/burrow/burrow-glass'
import { BURROW_DATA } from '../web/lib/burrow/burrow-data'

const EN = { lounge: 'Lounge', office: 'Office', library: 'Library', workshop: 'Workshop', lab: 'Laboratory', home: 'Home' }
const FR = { lounge: 'Salon', office: 'Bureau', library: 'Bibliothèque', workshop: 'Atelier', lab: 'Laboratoire', home: 'Maison' }
const { w: W, h: H } = BURROW_DATA.map

/** What the view gives glassPlace for an engine, nothing covering the picture unless said */
function input(titles: Record<string, string>, o: Partial<Parameters<typeof glassPlace>[0]> = {}): Parameters<typeof glassPlace>[0] {
  const e = createBurrowEngine({ data: BURROW_DATA, titles })
  return { agentX: 120, mats: e.mats, posts: [...e.postsOf('door'), ...e.postsOf('phone'), ...e.postsOf('error')], covers: [], coveredBottom: 0, coveredLeft: 0, coveredRight: 0, ...o }
}
/** The opaque part of the close-up, all its poses together (squirrel.glass x0..x1 in a 112 px cell centred on cx) */
const glass = BURROW_DATA.sprites.squirrel.glass!
const x0 = Math.min(...Object.values(glass.poses).map((p) => p.x0)) - glass.cell[0] / 2
const x1 = Math.max(...Object.values(glass.poses).map((p) => p.x1)) - glass.cell[0] / 2
const span = (cx: number): [number, number] => [cx + x0, cx + x1]
const meets = (a: [number, number], b: [number, number]): boolean => a[0] < b[1] && b[0] < a[1]

test('with nothing covering, the close-up stands on the bottom edge in a gap between two bottom titles, in English and in French', () => {
  for (const titles of [EN, FR]) {
    const o = input(titles)
    const mats = o.mats.filter((m) => m.y + m.h > H - 80)
    assert.equal(mats.length, 3, 'the three titles of the bottom rooms')
    for (const agentX of [0, 120, 200, 280, 330, 400, 560]) {
      const p = glassPlace({ ...o, agentX })
      assert.ok(p, `${titles.lounge} ${agentX}`)
      assert.equal(p.base, H)
      for (const m of mats) assert.equal(meets(span(p.cx), [m.x - 4, m.x + m.w + 4]), false, `${titles.lounge} ${agentX}: over the ${m.id} title`)
      assert.ok(span(p.cx)[0] >= p.left && span(p.cx)[1] <= p.right, `${titles.lounge} ${agentX}: inside its gap`)
      assert.ok(p.left >= 0 && p.right <= W && p.right - p.left >= 104)
    }
    // the gap nearest the agent: left of the lounge title for an agent on the left, right of it for one on the right
    const lounge = mats.find((m) => m.id === 'lounge')!
    assert.ok(glassPlace({ ...o, agentX: 100 })!.cx < lounge.x, 'left gap')
    assert.ok(glassPlace({ ...o, agentX: 450 })!.cx > lounge.x + lounge.w, 'right gap')
  }
})

test('never over a post whose feet are in its band (12 px around it)', () => {
  const o = input(EN)
  const free = glassPlace(o)!
  // a post in the middle of the gap the close-up took: that gap is too narrow now
  const blocked = glassPlace({ ...o, posts: [...o.posts, { x: free.cx, y: H - 30 }] })
  assert.ok(blocked)
  assert.ok(blocked.cx !== free.cx, 'it goes to the other gap')
  assert.equal(meets(span(blocked.cx), [free.cx - 12, free.cx + 12]), false)
  // a post above its band does not count
  assert.deepEqual(glassPlace({ ...o, posts: [...o.posts, { x: free.cx, y: H - 120 }] }), free)
})

test('a panel docked on the right that covers the right gap leaves the left one; both gaps covered: no close-up', () => {
  const o = input(EN)
  const right = glassPlace({ ...o, agentX: 450 })!
  const left = glassPlace({ ...o, agentX: 100 })!
  assert.ok(right.cx > left.cx)
  assert.deepEqual(glassPlace({ ...o, agentX: 450, coveredRight: W - (right.cx - 30) }), left)
  assert.equal(glassPlace({ ...o, coveredLeft: left.cx + 30, coveredRight: W - (right.cx - 30) }), null)
})

test('the bottom covered by the timeline: the close-up stands on its top edge; covered by more than 40 px: none', () => {
  // without posts (the place of errors comes into a higher band: see below)
  const o = input(EN, { posts: [] })
  assert.equal(glassPlace({ ...o, coveredBottom: 25.4 })!.base, H - 25)
  assert.equal(glassPlace({ ...o, coveredBottom: 40 })!.base, H - 40)
  assert.equal(glassPlace({ ...o, coveredBottom: 41 }), null)
})

test('a band raised by a covered bottom (the control bar of the app covers 9 to 30 px of it) meets the place of errors: the gaps beside it narrow', () => {
  const o = input(EN)
  const right = glassPlace({ ...o, agentX: 450 })!
  assert.ok(right.left > 300, 'with nothing covering, the gap right of the lounge title')
  for (const covered of [10, 20, 30]) {
    const p = glassPlace({ ...o, agentX: 450, coveredBottom: covered })
    assert.ok(p, `${covered}`)
    assert.ok(p.right < 280, `${covered}: the right gap is closed by the outer post of the place of errors (feet at y 228), the left one is left`)
    const outer = o.posts.find((q) => q.x === 236 && q.y === 228)!
    assert.ok(span(p.cx)[1] <= outer.x - 10 + 1, `${covered}: clear of the post (${span(p.cx)[1]})`)
  }
  const blocked = glassPlace({ ...o, coveredBottom: 25, posts: [...o.posts, { x: 180, y: 260 }] })
  assert.equal(blocked, null, 'a post in the left gap too: none')
})

test('the burrow controls (or any cover) reaching into its band remove that gap; above the band they do not count', () => {
  const o = input(EN)
  const left = glassPlace({ ...o, agentX: 100 })!
  const right = glassPlace({ ...o, agentX: 450 })!
  const column = { x0: right.cx - 40, x1: W, y0: 20, y1: H - 50 }
  assert.deepEqual(glassPlace({ ...o, agentX: 450, covers: [column] }), left, 'the controls column reaches the band of the right gap')
  assert.deepEqual(glassPlace({ ...o, agentX: 450, covers: [{ ...column, y1: H - 90 }] }), right, 'a shorter column stays above the band')
  assert.equal(glassPlace({ ...o, covers: [column, { x0: 0, x1: left.cx + 20, y0: H - 60, y1: H - 20 }] }), null)
})

test('glassBand: the cell of the close-up and its big "?" above it, standing on its base', () => {
  assert.deepEqual(glassBand({ cx: 190, base: 300, left: 130, right: 250 }), [134, 212, 246, 300])
  const tallest = Math.max(...Object.values(BURROW_DATA.sprites.squirrel.glass!.poses).map((p) => p.h))
  assert.ok(300 - 212 >= tallest + 10 + 1, 'over the big "?" bobbing a pixel up')
})

test('the engine keeps the band of the close-up free: an animal standing there leaves it, no stroll or pastime stops there, and null gives the floor back', () => {
  const seeded = (seed: number) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } }
  const e = createBurrowEngine({ data: BURROW_DATA, titles: EN, rng: seeded(3) })
  const place = glassPlace(input(EN, { agentX: 300 }))!
  const band = glassBand(place)
  const inBand = (a: { x: number; y: number }) => a.x >= band[0] && a.x < band[2] && a.y >= band[1] && a.y < band[3]
  // strollers in the lounge, and the squirrel playing its pastimes: wait until one stands in the band
  e.setPastimes(true)
  for (let i = 0; i < 8; i++) e.addActor(`a${i}`, ['squirrel', 'fox', 'otter', 'frog', 'hedgehog', 'woodpecker', 'beetle', 'hare'][i], { inside: true })
  let found = false
  for (let t = 0; t < 600 && !found; t += 0.1) {
    e.update(0.1)
    found = e.actors.some((a) => (a.mode === 'idle' || a.mode === 'act') && inBand(a))
  }
  assert.ok(found, 'without the band an animal stops there now and then')
  e.setGlassBand(band)
  for (let t = 0; t < 2; t += 0.1) e.update(0.1)
  for (const a of e.actors) assert.ok(!((a.mode === 'idle' || a.mode === 'act' || a.mode === 'sit') && inBand(a)), `${a.key} left the band at once (${a.mode} ${a.x},${a.y})`)
  for (let t = 0; t < 600; t += 0.1) {
    e.update(0.1)
    for (const a of e.actors) assert.ok(!((a.mode === 'idle' || a.mode === 'act' || a.mode === 'sit') && inBand(a)), `${a.key} stops in the band at ${t.toFixed(1)} (${a.mode})`)
  }
  e.setGlassBand(null)
  let back = false
  for (let t = 0; t < 900 && !back; t += 0.1) {
    e.update(0.1)
    back = e.actors.some((a) => (a.mode === 'idle' || a.mode === 'act') && inBand(a))
  }
  assert.ok(back, 'the floor is given back')
})

// ---------------- what it does ----------------

const squirrel = BURROW_DATA.sprites.squirrel
const rects = BURROW_DATA.fx.rects
const at = (e: number, still = false) => glassFrame({ elapsed: e, still, meta: squirrel, rects })
type Frame = ReturnType<typeof at>
/** Every frame from `from` to `to`, 10 ms apart, half a step off the hundredths */
function sample(from: number, to: number, still = false): Array<{ t: number; f: Frame }> {
  const out: Array<{ t: number; f: Frame }> = []
  for (let i = Math.round(from * 100); i < Math.round(to * 100); i++) out.push({ t: (i + 0.5) / 100, f: at((i + 0.5) / 100, still) })
  return out
}
const timeline = sample(0, 300)
/** The first instants at which a test holds (rising edges) */
const onsets = (list: typeof timeline, ok: (f: Frame) => boolean): number[] =>
  list.filter((x, i) => ok(x.f) && (i === 0 || !ok(list[i - 1].f))).map((x) => x.t)
const near = (t: number, want: number, tol: number) => Math.abs(t - want) <= tol

test('the first 8 s it wonders at its post under "?" (step 2), no close-up; then it comes to the glass: the close-up rises (peek) and its first visit starts at 9.55 s', () => {
  for (const { t, f } of sample(0, 8)) {
    assert.equal(f.bust, null, `${t}`)
    assert.equal(f.room.sign, 'ask')
    assert.ok(f.room.pose === 'think' || f.room.pose === 'front', `${t} ${f.room.pose}`)
  }
  assert.equal(at(8.1).bust, null, 'it leaves its post for the glass first')
  const rise = sample(8.3, 9.55).map(({ f }) => f.bust)
  for (const b of rise) assert.equal(b?.pose, 'peek')
  assert.ok(rise[0]!.up < 0.2 && rise[rise.length - 1]!.up === 1, 'the bust rises')
  assert.deepEqual(at(9.56).bust, { pose: 'ready', up: 1 })
})

test('the crack: in the second, third and fourth visits (panes 1, 2, 3), each on a knock, at about 85 s, 129 s and 162 s; the tape in the fifth, on a knock, at about 191 s; never more after 600 s', () => {
  const panes = [...onsets(timeline, (f) => f.pane > 0), ...onsets(timeline, (f) => f.pane > 1), ...onsets(timeline, (f) => f.pane > 2)]
  assert.equal(panes.length, 3)
  panes.forEach((t, i) => assert.ok(near(t, [85, 129, 162][i], 1), `crack at ${t}`))
  for (const t of panes) {
    const f = at(t + 0.01)
    assert.ok(f.marks.some((m) => m.name === 'w_hitL'), `a knock makes the crack at ${t}`)
    assert.ok(f.bust && (f.bust.pose === 'knock' || f.bust.pose === 'acornHit'), `${t} ${f.bust?.pose}`)
  }
  panes.forEach((t, i) => assert.equal(at(t + 0.01).marks.find((m) => m.name.startsWith('w_bolt'))?.name, `w_bolt${i + 1}`))
  const tape = onsets(timeline, (f) => f.taped)
  assert.equal(tape.length, 1)
  assert.ok(tape[0] > 180 && tape[0] < 200, `tape at ${tape[0]}`)
  assert.equal(at(tape[0] + 0.01).bust?.pose, 'knock')
  for (const { t, f } of [...timeline, ...sample(300, 600).filter((_, i) => i % 7 === 0)]) {
    assert.ok(f.marks.filter((m) => m.name.startsWith('w_bolt')).length <= 1, `one crack at ${t}`)
    assert.ok(f.marks.filter((m) => m.name === 'w_tape').length <= 1, `at most one tape at ${t}`)
    if (t > tape[0] + 0.01) assert.deepEqual([f.pane, f.taped], [3, true])
  }
  const late = at(600)
  assert.deepEqual([late.pane, late.taped, late.marks.filter((m) => m.name === 'w_bolt3' || m.name === 'w_tape').length], [3, true, 2])
})

test('from the sixth visit on it waits calmly, every 37.65 s the same', () => {
  for (const e of [215, 228.7, 233.5, 240, 247.9]) {
    const a = at(e)
    for (let k = 1; k <= 3; k++) {
      const b = at(e + 37.65 * k)
      assert.deepEqual([b.room.pose, b.room.sign, b.bust, b.bigSign, b.pane, b.taped], [a.room.pose, a.room.sign, a.bust, a.bigSign, a.pane, a.taped], `${e} + ${k} periods`)
    }
  }
  for (const { f } of sample(211, 290)) assert.equal(f.marks.some((m) => m.name === 'w_hitL'), false, 'no knock any more')
})

test('flashes: two knock bursts on the glass are at least half a second apart, never more than two in any second', () => {
  const bursts = onsets(timeline, (f) => f.marks.some((m) => m.name === 'w_hitL'))
  assert.ok(bursts.length > 40, `${bursts.length} bursts`)
  for (let i = 1; i < bursts.length; i++) assert.ok(bursts[i] - bursts[i - 1] >= 0.5 - 1e-6, `${bursts[i - 1]} -> ${bursts[i]}`)
  for (const t of bursts) assert.ok(bursts.filter((x) => x >= t && x < t + 1).length <= 2, `at ${t}`)
  // a burst lasts 0.13 s, 0.22 s for a hard knock: never on screen for long
  for (const t of bursts) assert.equal(at(t + 0.25).marks.some((m) => m.name === 'w_hitL'), false, `${t}`)
})

test('the close-up and the squirrel at its post: the bust only during a visit, its big "?" only once fully up; at its post "..." while it taps its foot, nothing while it takes a run-up, "?" otherwise, never "!"; facing you without a sign while at the glass', () => {
  const rooms = new Set<string>()
  for (const { t, f } of timeline) {
    assert.equal(f.bigSign, f.bust !== null && f.bust.up >= 1, `${t}`)
    assert.notEqual(f.room.sign, 'alert')
    for (const m of [...f.marks, ...f.room.fx]) assert.notEqual(m.name, 'w_idea', 'the "!" of an idea is not used: "!" means a failure')
    assert.equal(f.room.line, undefined, 'no line is said')
    if (f.bust) { assert.deepEqual([f.room.pose, f.room.sign], ['front', null], `${t}`); continue }
    if (t < 8 || f.room.pose === 'front' && f.room.sign === null) continue
    rooms.add(String(f.room.pose))
    const want = f.room.pose === 'crossA' || f.room.pose === 'crossB' ? 'dots' : f.room.pose === 'windup' ? null : 'ask'
    assert.equal(f.room.sign, want, `${t} ${f.room.pose}`)
  }
  for (const p of ['crossA', 'crossB', 'think', 'front', 'gasp', 'rummage', 'acornB', 'windup']) assert.ok(rooms.has(p), `it ${p}s at its post`)
})

test('things fly out of its satchel and land beside it, the same each time; dust under its feet on its run-up; it digs a pixel up and down', () => {
  const items = timeline.filter(({ f }) => f.room.fx.some((x) => x.name.startsWith('w_item')))
  assert.ok(items.length > 0)
  for (const { t, f } of items.filter((_, i) => i % 13 === 0)) assert.deepEqual(at(t).room.fx, f.room.fx, 'deterministic')
  const runUp = timeline.filter(({ f }) => f.room.pose === 'windup')
  assert.ok(runUp.some(({ f }) => f.room.fx.some((x) => x.name === 'w_puff')))
  const dig = timeline.filter(({ f }) => f.room.pose === 'rummage').map(({ f }) => f.room.oy ?? 0)
  assert.deepEqual([...new Set(dig)].sort(), [0, 1])
})

test('the breath on the glass, the "?" wiped in it, the sweat drop after a crack: gentle marks of the motion scene', () => {
  const mist = onsets(timeline, (f) => f.marks.some((m) => m.name === 'w_mist' || m.name === 'w_mistQ'))
  assert.equal(mist.length, 1, 'once, in the first visit')
  assert.ok(timeline.some(({ f }) => f.marks.some((m) => m.name === 'w_mistQ')))
  const drops = onsets(timeline, (f) => f.marks.some((m) => m.name === 'w_drop'))
  assert.equal(drops.length, 3, 'after each of the three cracks')
})

test('the still scene: the wonder for 8 s, then the bust up in a steady pose with its big "?", the crack and tape reached, nothing that moves', () => {
  assert.deepEqual([at(3, true).bust, at(3, true).room.pose, at(3, true).room.sign], [null, 'think', 'ask'])
  assert.deepEqual(at(9, true).bust, { pose: 'ready', up: 1 })
  assert.equal(at(9, true).bigSign, true)
  assert.deepEqual([at(9, true).room.pose, at(9, true).room.sign, at(9, true).room.fx], ['front', null, []])
  assert.deepEqual(at(100, true).marks.map((m) => m.name), ['w_bolt1'])
  assert.deepEqual(at(170, true).marks.map((m) => m.name), ['w_bolt3'])
  assert.deepEqual(at(200, true).marks.map((m) => m.name), ['w_bolt3', 'w_tape'])
  assert.deepEqual(at(200, true).bust, { pose: 'rest', up: 1 })
  for (const { t, f } of sample(8, 300, true).filter((_, i) => i % 11 === 0)) {
    assert.equal(f.room.fx.length, 0, `${t}`)
    assert.equal(f.room.oy ?? 0, 0)
    for (const m of f.marks) assert.ok(m.name.startsWith('w_bolt') || m.name === 'w_tape', `${t} ${m.name}`)
    assert.deepEqual([f.pane, f.taped], [at(t).pane, at(t).taped], 'the same trace as with motion')
  }
})

test('glassDrawList: the bust on the base, its big "?" at its side, the crack and its tape on one point inside the gap, the breath kept in the gap', () => {
  const place = { cx: 360, base: 315, left: 311, right: 416 }
  const d = glassDrawList(place, at(200, true), squirrel, rects, 0, true)
  const rest = squirrel.glass!.poses.rest
  assert.deepEqual(d.bust, { sx: rest.col * 112, sy: 0, w: 112, h: 96, x: 304, y: 315 - 96 })
  const askL = d.items.find((i) => i.name === 'w_askL')!
  assert.deepEqual([askL.x, askL.y], [384, 315 - rest.h - 10])
  const bolt = d.items.find((i) => i.name === 'w_bolt3')!
  const tape = d.items.find((i) => i.name === 'w_tape')!
  assert.equal(bolt.x + (rects.w_bolt3[2] >> 1), tape.x + (rects.w_tape[2] >> 1), 'the tape on the crack')
  assert.equal(bolt.y + (rects.w_bolt3[3] >> 1), tape.y + (rects.w_tape[3] >> 1))
  assert.ok(d.items.indexOf(tape) > d.items.indexOf(bolt), 'over it')
  assert.ok(bolt.x >= place.left && bolt.x + rects.w_bolt3[2] <= place.right, 'the crack stays in the gap: no title under it')
  // the breath, near the right end of a gap
  const mistAt = timeline.find(({ f }) => f.marks.some((m) => m.name === 'w_mist'))!.t
  const m = glassDrawList(place, at(mistAt), squirrel, rects, 0, false).items.find((i) => i.name === 'w_mist')!
  assert.ok(m.x + rects.w_mist[2] <= place.right, 'the breath stays in the gap')
  // the "?" bobs with motion, not still
  const ys = new Set<number>()
  for (let c = 0; c < 2; c += 0.05) ys.add(glassDrawList(place, at(20), squirrel, rects, c, false).items.find((i) => i.name === 'w_askL')!.y)
  assert.ok(ys.size >= 2)
  // the rising bust: lower
  const rising = glassDrawList(place, at(8.5), squirrel, rects, 0, false).bust!
  assert.ok(rising.y > 315 - 96)
  assert.deepEqual(glassDrawList(place, at(3), squirrel, rects, 0, false), { bust: null, items: [] })
})

test('glassSoundsBetween: each knock on the glass once (a knock, a hard one, the crack), the tape and its presses as a pat; nothing at its post, nothing once it waits calmly', () => {
  const heard: Array<{ t: number; s: string }> = []
  let prev = 0
  for (let i = 1; i <= 300 * 60; i++) {
    const e = i / 60
    for (const s of glassSoundsBetween(prev, e)) heard.push({ t: e, s })
    prev = e
  }
  const count = (s: string) => heard.filter((h) => h.s === s).length
  assert.equal(count('crack'), 3)
  assert.equal(count('thud'), 2)
  assert.equal(count('pat'), 3, 'the tape and two presses')
  const bursts = onsets(timeline, (f) => f.marks.some((m) => m.name === 'w_hitL'))
  assert.equal(count('knock') + count('thud') + count('crack'), bursts.length, 'one sound per knock seen on the glass')
  assert.equal(heard.filter((h) => h.t > 211).length, 0)
  for (const h of heard) assert.ok(at(h.t - 1 / 120).bust !== null, `heard at the glass (${h.t})`)
  assert.deepEqual(glassSoundsBetween(20, 20), [])
  assert.deepEqual(glassSoundsBetween(30, 20), [])
  // a long gap (a hidden tab): only the last second is heard, not a burst of every knock missed
  assert.ok(glassSoundsBetween(0, 120).length <= 2)
})

test('glassHit: on the opaque part of the bust up, not beside it, not before it rises', () => {
  const place = { cx: 360, base: 315, left: 311, right: 416 }
  const f = at(20)
  const p = squirrel.glass!.poses[f.bust!.pose]
  assert.equal(glassHit(place, f, squirrel, 360 - 56 + (p.x0 + p.x1) / 2, 315 - p.h / 2), true)
  assert.equal(glassHit(place, f, squirrel, 360 - 56 + p.x0 - 2, 300), false)
  assert.equal(glassHit(place, f, squirrel, 360, 315 - p.h - 3), false)
  assert.equal(glassHit(place, at(3), squirrel, 360, 300), false)
})
