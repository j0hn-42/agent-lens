// Burrow view: the squirrel's close-up at the glass. Where it may stand: on the bottom edge of the picture (or on what
// covers the bottom), in a gap between two room titles, never over a title mat, a post, a docked panel, the timeline or
// the burrow's own controls; no close-up when no gap is free.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createBurrowEngine } from '../web/lib/burrow/burrow-engine'
import { glassBand, glassPlace } from '../web/lib/burrow/burrow-glass'
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

test('a band raised by a covered bottom meets the place of errors: the gaps beside it narrow, here to none', () => {
  const o = input(EN)
  assert.ok(glassPlace({ ...o, coveredBottom: 5 }))
  assert.equal(glassPlace({ ...o, coveredBottom: 25 }), null, 'the posts of the place of errors (feet at y 228 and 241) are in the band 210..290')
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

test('glassBand: the cell of the close-up over its 80 px band, standing on its base', () => {
  assert.deepEqual(glassBand({ cx: 190, base: 300, left: 130, right: 250 }), [134, 220, 246, 300])
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
