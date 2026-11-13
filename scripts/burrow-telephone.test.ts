// Burrow view: the telephone where an orchestrator stands while it dispatches a sub-agent. Pixel art over the decor,
// reachable on the walk grid, with standing places for several callers that never hide a room title.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { BURROW_DATA } from '../web/lib/burrow/burrow-data'
import { BURROW_TELEPHONE as T } from '../web/lib/burrow/burrow-telephone'
import { createBurrowEngine } from '../web/lib/burrow/burrow-engine'

const FR = { lounge: 'Salon', office: 'Bureau', library: 'Bibliothèque', workshop: 'Atelier', lab: 'Labo', home: 'Maison' }
const EN = { lounge: 'Lounge', office: 'Office', library: 'Library', workshop: 'Workshop', lab: 'Laboratory', home: 'Home' }
const MAP = BURROW_DATA.map
const walkable = (x: number, y: number): boolean => MAP.grid[Math.floor(y / MAP.cell)]?.[Math.floor(x / MAP.cell)] === '1'
const inBlock = (x: number, y: number): boolean => x >= T.block[0] && x <= T.block[2] && y >= T.block[1] && y <= T.block[3]
const inReserved = (x: number, y: number): boolean => x >= T.reserved[0] && x < T.reserved[2] && y >= T.reserved[1] && y < T.reserved[3]
const hides = (mats: ReadonlyArray<{ x: number; y: number; w: number; h: number }>, x: number, y: number) =>
  mats.some((m) => x > m.x - 10 && x < m.x + m.w + 10 && y > m.y - 2 && y < m.y + m.h + 30)
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}
const run = (e: ReturnType<typeof createBurrowEngine>, s: number, each?: () => void) => { for (let t = 0; t < s; t += 0.1) { e.update(0.1); each?.() } }

test('the drawing is a rectangle of pixels whose every letter has a colour, inside the picture, standing on the floor', () => {
  const w = T.rows[0].length
  for (const r of T.rows) assert.equal(r.length, w, r)
  for (const ch of T.rows.join('')) if (ch !== '.') assert.match(T.colours[ch] ?? '', /^#[0-9a-f]{6}$/, ch)
  assert.ok(T.x >= 0 && T.y >= 0 && T.x + w <= MAP.w && T.y + T.rows.length <= MAP.h)
  assert.equal(T.base, T.y + T.rows.length - 1)
  assert.ok(walkable(T.cx, T.base), 'its feet are on the floor of the burrow')
  // never over a room title, in either language
  for (const titles of [FR, EN]) {
    for (const m of createBurrowEngine({ data: BURROW_DATA, titles }).mats) {
      const apart = T.x + w <= m.x || m.x + m.w <= T.x || T.y + T.rows.length <= m.y || m.y + m.h <= T.y
      assert.ok(apart, `over the ${m.id} title`)
    }
  }
})

test('every caller post is on the floor, outside the table, beside it, and hides no room title in French or English', () => {
  assert.ok(T.posts.length >= 4, 'room for several orchestrators')
  for (const p of T.posts) {
    assert.ok(walkable(p.x, p.y), `${p.x},${p.y} walkable`)
    assert.ok(!inBlock(p.x, p.y), `${p.x},${p.y} outside the table`)
    assert.ok(inReserved(p.x, p.y), `${p.x},${p.y} on the floor kept for the callers`)
    assert.ok(p.x > T.cx && Math.hypot(p.x - T.cx, p.y - T.base) < 60, `${p.x},${p.y} on its right, near it`)
    for (const titles of [FR, EN]) assert.ok(!hides(createBurrowEngine({ data: BURROW_DATA, titles }).mats, p.x, p.y), `${p.x},${p.y} hides a title`)
  }
})

test('an orchestrator sent to the telephone stands at a post beside it, facing it; five get five posts, a sixth waits in the lounge', () => {
  const e = createBurrowEngine({ data: BURROW_DATA, titles: FR, rng: seeded(3) })
  for (let i = 0; i < 6; i++) { e.addActor(`o${i}`, 'fox', { inside: true }); e.assign(`o${i}`, 'phone') }
  e.addActor('in', 'otter', { inside: true, room: 'phone' })   // drawn at once (reduced motion): at a post too, when one is free
  run(e, 40)
  const callers = e.actors.filter((a) => T.posts.some((p) => p.x === a.x && p.y === a.y))
  assert.equal(callers.length, T.posts.length, 'every post taken once')
  assert.equal(new Set(callers.map((a) => `${a.x},${a.y}`)).size, T.posts.length)
  for (const a of callers) { assert.equal(a.dir, 'left', `${a.key} faces the telephone`); assert.equal(a.pose, null) }
  for (const a of e.actors) assert.equal(e.jobOf(a.key), 'phone')
  const rest = e.actors.filter((a) => !callers.includes(a))
  for (const a of rest) assert.equal(e.zoneOf(a.x, a.y), 'lounge', `${a.key} waits in the lounge`)
  // released, a caller leaves its post to another one
  const first = callers[0]
  e.release(first.key)
  run(e, 40)
  assert.ok(!T.posts.some((p) => p.x === first.x && p.y === first.y), 'the released caller left the telephone')
  assert.equal(e.actors.filter((a) => T.posts.some((p) => p.x === a.x && p.y === a.y)).length, T.posts.length, 'a waiting orchestrator took the free post')
})

test('nobody walks through the telephone, and an idle animal never stops on the floor kept for its callers', () => {
  const e = createBurrowEngine({ data: BURROW_DATA, titles: FR, rng: seeded(11) })
  const sprites = ['fox', 'otter', 'frog', 'hare', 'beetle', 'raccoon', 'hedgehog', 'woodpecker', 'squirrel']
  for (let i = 0; i < 14; i++) e.addActor(`a${i}`, sprites[i % sprites.length], { inside: true })
  // some go to work and back, through the passage beside the telephone
  let n = 0
  run(e, 400, () => {
    n++
    if (n % 300 === 0) for (let i = 0; i < 14; i += 3) { if (e.jobOf(`a${i}`)) e.release(`a${i}`); else e.assign(`a${i}`, i % 2 ? 'office' : 'workshop') }
    for (const a of e.actors) {
      assert.ok(!inBlock(a.x, a.y), `${a.key} inside the telephone at ${a.x},${a.y}`)
      if (a.mode === 'idle' && !e.jobOf(a.key)) assert.ok(!inReserved(a.x, a.y), `${a.key} idle at the telephone ${a.x},${a.y}`)
    }
  })
})
