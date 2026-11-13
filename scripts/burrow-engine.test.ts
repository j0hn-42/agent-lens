// Burrow engine: the animals go where the observed state sends them, and nowhere else on their own account.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createBurrowEngine } from '../web/lib/burrow/burrow-engine'
import { BURROW_DATA } from '../web/lib/burrow/burrow-data'

const HOME_AFTER_S = 4   // the engine's rest time in the lounge before an unavailable agent leaves
const TITLES = { lounge: 'Salon', office: 'Bureau', library: 'Bibliothèque', workshop: 'Atelier', lab: 'Labo', home: 'Maison' }

// small deterministic generator
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}
const layoutMats = (data: typeof BURROW_DATA, titles: Record<string, string>) => createBurrowEngine({ data, titles }).mats
const make = (seed = 1) => createBurrowEngine({ data: BURROW_DATA, titles: TITLES, rng: seeded(seed) })
function run(e: ReturnType<typeof make>, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.1) e.update(0.1)
}

test('layoutMats: one mat per titled room, the accents of the French titles are in the pixel font', () => {
  const mats = layoutMats(BURROW_DATA, TITLES)
  assert.deepEqual(mats.map((m) => m.id).sort(), ['home', 'lab', 'library', 'lounge', 'office', 'workshop'])
  assert.equal(mats.find((m) => m.id === 'library')?.label, 'BIBLIOTHÈQUE')
  for (const m of mats) assert.ok(m.w > 0 && m.h > 0, m.id)
  assert.deepEqual(layoutMats(BURROW_DATA, { office: 'Bureau' }).map((m) => m.id), ['office'])
})

test('an agent added inside with a room is at its post at once, in that room', () => {
  const e = make()
  e.addActor('a', 'fox', { inside: true, room: 'library' })
  assert.equal(e.zoneOf(e.actors[0].x, e.actors[0].y), 'library')
  assert.equal(e.jobOf('a'), 'library')
})

test('assign sends an agent to the workshop and keeps it there; release brings it back to the lounge', () => {
  const e = make()
  e.addActor('a', 'otter', { inside: true })
  run(e, 3)
  assert.equal(e.assign('a', 'office'), true)
  run(e, 40)
  assert.equal(e.zoneOf(e.actors[0].x, e.actors[0].y), 'office')
  run(e, 40)   // still there: the job does not expire by itself
  assert.equal(e.zoneOf(e.actors[0].x, e.actors[0].y), 'office')
  assert.equal(e.release('a'), true)
  assert.equal(e.jobOf('a'), null)
  run(e, 40)
  assert.equal(e.zoneOf(e.actors[0].x, e.actors[0].y), 'lounge')
})

test('assign refuses the lounge, an unknown agent and a leaving one', () => {
  const e = make()
  e.addActor('a', 'frog', { inside: true })
  assert.equal(e.assign('a', 'lounge' as never), false)
  assert.equal(e.assign('ghost', 'office'), false)
  e.removeActor('a')
  assert.equal(e.assign('a', 'office'), false)
})

test('an unavailable agent rests in the lounge, then leaves through the front door after HOME_AFTER_S', () => {
  const e = make()
  e.addActor('a', 'hare', { inside: true })
  run(e, 2)
  e.setAvailable('a', false)
  assert.equal(e.isOutside('a'), false)
  run(e, HOME_AFTER_S + 40)
  assert.equal(e.isOutside('a'), true)
  assert.equal(e.actors[0].mode, 'home')
})

test('an agent that comes back walks in through the front door', () => {
  const e = make()
  e.addActor('a', 'hare', { inside: true })
  run(e, 1)
  e.setAvailable('a', false)
  run(e, HOME_AFTER_S + 40)
  assert.equal(e.isOutside('a'), true)
  e.setAvailable('a', true)
  run(e, 30)
  assert.equal(e.isOutside('a'), false)
  assert.equal(e.zoneOf(e.actors[0].x, e.actors[0].y), 'lounge')
})

test('an agent added outside and made unavailable never enters the burrow', () => {
  const e = make()
  e.addActor('a', 'beetle', { inside: false })
  e.setAvailable('a', false)
  run(e, 60)
  assert.equal(e.isOutside('a'), true)
})

test('removeActor: the agent walks out and is dropped from the scene', () => {
  const e = make()
  e.addActor('a', 'raccoon', { inside: true })
  e.addActor('b', 'squirrel', { inside: true })
  run(e, 1)
  e.removeActor('a')
  let removed: string[] = []
  for (let t = 0; t < 120 && e.has('a'); t += 0.1) removed = removed.concat(e.update(0.1).removed)
  assert.equal(e.has('a'), false)
  assert.deepEqual(removed, ['a'])
  assert.equal(e.has('b'), true)
})

test('nothing is said on its own: a bubble exists only after say(), and ends with its duration', () => {
  const e = make(7)
  e.addActor('a', 'fox', { inside: true })
  e.addActor('b', 'frog', { inside: true, room: 'lab' })
  run(e, 120)
  assert.ok(e.actors.every((a) => a.said === null), 'no bubble without say()')
  e.say('a', 'Edit', 2)
  assert.equal(e.actors.find((a) => a.key === 'a')?.said, 'Edit')
  run(e, 3)
  assert.equal(e.actors.find((a) => a.key === 'a')?.said, null)
  e.say('a', 'Permission', Number.POSITIVE_INFINITY)
  run(e, 60)
  assert.equal(e.actors.find((a) => a.key === 'a')?.said, 'Permission')
  e.say('a', null)
  assert.equal(e.actors.find((a) => a.key === 'a')?.said, null)
})

test('a fast-forward (the still scene of reduced motion) brings the animals to rest but keeps a timed bubble, with its time left', () => {
  const e = make(7)
  e.addActor('a', 'fox', { inside: true, room: 'library' })
  e.say('a', 'Grep', 6)
  e.fastForward(40)
  assert.equal(e.actors.find((a) => a.key === 'a')?.said, 'Grep', 'still said after the jump')
  run(e, 7)
  assert.equal(e.actors.find((a) => a.key === 'a')?.said, null, 'then it ends with its duration')
})

test('the same seed gives the same scene (no hidden randomness)', () => {
  const trace = (): string => {
    const e = make(42)
    e.addActor('a', 'fox', { inside: true })
    e.addActor('b', 'hare', { inside: true })
    e.assign('a', 'workshop')
    run(e, 30)
    return e.actors.map((a) => `${a.key}:${a.x.toFixed(1)},${a.y.toFixed(1)},${a.mode}`).join('|')
  }
  assert.equal(trace(), trace())
})

test('many agents (more than the nine animals) all find a place and stay inside the walkable burrow', () => {
  const e = make(3)
  const rooms = ['office', 'library', 'workshop', 'lab'] as const
  for (let i = 0; i < 24; i++) {
    e.addActor(`k${i}`, ['fox', 'hare', 'otter'][i % 3], { inside: true, room: i % 2 ? rooms[i % 4] : undefined })
  }
  run(e, 60)
  assert.equal(e.actors.length, 24)
  for (const a of e.actors) {
    assert.ok(a.x >= 0 && a.x <= BURROW_DATA.map.w && a.y >= 0 && a.y <= BURROW_DATA.map.h, `${a.key} at ${a.x},${a.y}`)
  }
})

test('actorAt finds the agent under a point, nothing on empty floor', () => {
  const e = make()
  e.addActor('a', 'fox', { inside: true, room: 'office' })
  const a = e.actors[0]
  assert.equal(e.actorAt(a.x, a.y - 5)?.key, 'a')
  assert.equal(e.actorAt(a.x + 100, a.y), null)
})

test('setResting: the agent goes back to the lounge, then stands still (no stroll, no seat), until rested again', () => {
  const e = make()
  e.addActor('a', 'fox', { inside: true, room: 'office' })
  assert.equal(e.setResting('a', true), true)
  assert.equal(e.isResting('a'), true)
  assert.equal(e.jobOf('a'), null)
  run(e, 40)
  const a = e.actors.find((x) => x.key === 'a')!
  assert.equal(e.zoneOf(a.x, a.y), 'lounge')
  const { x, y } = a
  run(e, 60)
  assert.equal(a.x, x); assert.equal(a.y, y)
  assert.equal(a.pose, null)
  e.setResting('a', false)
  run(e, 60)
  assert.notEqual(`${a.x},${a.y}`, `${x},${y}`, 'rested again, it strolls')
  assert.equal(e.setResting('ghost', true), false)
})

test('an agent sent to the door post stands beside the front door, facing it, off the doorway lane; two get two posts', () => {
  const e = make(3)
  const door = BURROW_DATA.map.door
  e.addActor('a', 'fox', { inside: true })
  e.addActor('b', 'otter', { inside: true, room: 'door' })
  e.assign('a', 'door')
  run(e, 40)
  const a = e.actors.find((x) => x.key === 'a')!
  const b = e.actors.find((x) => x.key === 'b')!
  for (const x of [a, b]) {
    assert.ok(x.x < door.cx - 14, `${x.key} left of the door (${x.x})`)
    assert.ok(Math.abs(x.y - door.front) <= 30, `${x.key} level with the door (${x.y})`)
    assert.ok(Math.hypot(x.x - door.cx, x.y - door.front) < 110, `${x.key} near the door`)
  }
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 10, 'two posts, not one')
  assert.equal(e.jobOf('a'), 'door')
  e.release('a')
  run(e, 40)
  assert.equal(e.jobOf('a'), null)
})

test('has, jobOf, isGone and isOutside follow the agents through add, remove, the walk out and a new arrival under the same key', () => {
  const e = make(4)
  const keys = Array.from({ length: 30 }, (_, i) => `k${i}`)
  for (const k of keys) e.addActor(k, 'fox', { inside: true, room: 'office' })
  for (const k of keys) assert.equal(e.has(k), true, k)
  assert.equal(e.has('ghost'), false)
  assert.equal(e.jobOf('k3'), 'office')
  e.addActor('k3', 'otter', { inside: true })               // a key already there is not added twice
  assert.equal(e.actors.filter((a) => a.key === 'k3').length, 1)
  for (const k of keys.filter((_, i) => i % 2 === 0)) e.removeActor(k)
  assert.equal(e.isGone('k0'), true)                         // leaving: holds no place, still in the scene
  assert.equal(e.has('k0'), true)
  assert.equal(e.jobOf('k0'), null)
  assert.equal(e.isGone('k1'), false)
  run(e, 120)                                                // every leaving animal has walked out
  for (const [i, k] of keys.entries()) {
    assert.equal(e.has(k), i % 2 === 1, k)
    assert.equal(e.isGone(k), i % 2 === 0, k)
    assert.equal(e.isOutside(k), i % 2 === 0, k)
  }
  assert.equal(e.actors.length, 15)
  e.addActor('k0', 'otter', { inside: true, room: 'lab' })   // back under the same key: the new animal, not the old one
  assert.equal(e.has('k0'), true)
  assert.equal(e.jobOf('k0'), 'lab')
  assert.equal(e.isGone('k0'), false)
  assert.equal(e.assign('k0', 'library'), true)
  assert.equal(e.jobOf('k0'), 'library')
})

test('setTitles re-lays the mats on the same engine: actors and their jobs stay, labels and widths change', () => {
  const e = make()
  e.addActor('a', 'fox', { inside: true, room: 'library' })
  e.addActor('b', 'otter', { inside: true })
  run(e, 3)
  e.assign('b', 'office')
  const before = e.actors.map((a) => ({ x: a.x, y: a.y }))
  const w0 = e.mats.find((m) => m.id === 'library')?.w
  const mats = e.mats
  e.setTitles({ ...TITLES, library: 'Library of the burrow', lounge: 'Lounge' })
  assert.equal(e.mats, mats, 'the same array, refilled')
  const lib2 = e.mats.find((m) => m.id === 'library')
  assert.equal(lib2?.label, 'LIBRARY OF THE BURROW')
  assert.notEqual(lib2?.w, w0)
  assert.equal(e.mats.find((m) => m.id === 'lounge')?.label, 'LOUNGE')
  assert.deepEqual(e.actors.map((a) => ({ x: a.x, y: a.y })), before)
  assert.equal(e.jobOf('a'), 'library')
  assert.equal(e.jobOf('b'), 'office')
  run(e, 5)
  assert.equal(e.jobOf('b'), 'office')
})

test('setTitles: an animal holding a posture on a spot that a new, longer title covers moves off it', () => {
  const SHORT = { lounge: 'A', office: 'B', library: 'C', workshop: 'D', lab: 'E', home: 'F' }
  const LONG = { lounge: 'The lounge of the whole burrow', office: 'The office of the burrow', library: 'The library of the burrow', workshop: 'The workshop of the burrow', lab: 'The laboratory of it', home: 'Home sweet home' }
  const hides = (mats: ReadonlyArray<{ x: number; y: number; w: number; h: number }>, x: number, y: number) =>
    mats.some((m) => x > m.x - 10 && x < m.x + m.w + 10 && y > m.y - 2 && y < m.y + m.h + 30)
  const longMats = layoutMats(BURROW_DATA, LONG)
  // spots where strolling animals stop under the short titles (valid cells), and that the long titles cover
  const scout = createBurrowEngine({ data: BURROW_DATA, titles: SHORT, rng: seeded(3) })
  for (let i = 0; i < 6; i++) scout.addActor(`s${i}`, 'otter', { inside: true })
  let spot: { x: number; y: number } | undefined
  for (let t = 0; t < 600 && !spot; t++) {
    run(scout, 1)
    spot = scout.actors.filter((a) => a.mode === 'idle').map((a) => ({ x: a.x, y: a.y }))
      .find((p) => scout.zoneOf(p.x, p.y) === 'lounge' && hides(longMats, p.x, p.y) && !hides(scout.mats, p.x, p.y))
  }
  assert.ok(spot, 'a lounge spot free under the short titles and covered by the long ones')
  const e = createBurrowEngine({ data: BURROW_DATA, titles: SHORT, rng: seeded(5) })
  e.addActor('a', 'otter', { inside: true })
  e.setPosture('a', 'still')
  run(e, 40)
  const a = e.actors.find((x) => x.key === 'a')! as unknown as { x: number; y: number; mode: string; plan: unknown[] }
  // it holds its posture there (the end of a 'still' hold, with no end)
  a.x = spot.x; a.y = spot.y; a.mode = 'idle'; a.plan = [{ t: 'idle', dur: Number.POSITIVE_INFINITY, face: 'down' }]
  run(e, 5)
  assert.deepEqual({ x: a.x, y: a.y }, spot, 'held while the titles stay')
  e.setTitles(LONG)
  run(e, 40)
  assert.equal(hides(e.mats, a.x, a.y), false, `it moved off the new title (${a.x}, ${a.y})`)
  assert.equal(e.zoneOf(a.x, a.y), 'lounge')
})

// ---------------- postures: the observed state, held as long as it lasts ----------------
const SEAT_POSES = new Set(['sit', 'sitLeft'])
const FIRE = BURROW_DATA.map.poi.filter((p) => p.id.startsWith('fire'))
function towardDoor(x: number, y: number): string {
  const dx = BURROW_DATA.map.door.cx - x
  const dy = BURROW_DATA.map.door.front - y
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')
}
/** Settles the scene, then checks the animal holds its place and pose for two more minutes */
function settledAndKept(e: ReturnType<typeof make>, key: string) {
  run(e, 40)
  const a = e.actors.find((x) => x.key === key)!
  const held = { x: a.x, y: a.y, pose: a.pose, dir: a.dir, mode: a.mode }
  for (let i = 0; i < 12; i++) {
    run(e, 10)
    assert.deepEqual({ x: a.x, y: a.y, pose: a.pose, dir: a.dir, mode: a.mode }, held, `${key} kept its posture`)
  }
  assert.equal(e.zoneOf(a.x, a.y), 'lounge')
  return a
}

test('setPosture sit: the agent takes a free lounge seat and stays seated, no stroll', () => {
  const e = make(2)
  e.addActor('a', 'fox', { inside: true })
  assert.equal(e.setPosture('a', 'sit'), true)
  const a = settledAndKept(e, 'a')
  assert.equal(a.mode, 'sit')
  assert.ok(a.pose !== null && SEAT_POSES.has(a.pose), String(a.pose))
  assert.equal(e.setPosture('ghost', 'sit'), false)
})

test('setPosture sit: with every seat taken the agent stands still instead', () => {
  const e = make(2)
  const seats = BURROW_DATA.map.poi.filter((p) => p.room === 'lounge' && p.perch).length
  for (let i = 0; i < seats; i++) { e.addActor(`s${i}`, 'otter', { inside: true }); e.setPosture(`s${i}`, 'sit') }
  run(e, 40)
  assert.equal(e.actors.filter((x) => x.mode === 'sit').length, seats)
  e.addActor('late', 'hare', { inside: true })
  e.setPosture('late', 'sit')
  const a = settledAndKept(e, 'late')
  assert.equal(a.pose, null)
  assert.equal(a.mode, 'idle')
})

test('setPosture wave: the agent stands still facing the front door, waving when its sprite has the pose', () => {
  const e = make(4)
  e.addActor('fox', 'fox', { inside: true })
  e.addActor('sq', 'squirrel', { inside: true })
  e.setPosture('fox', 'wave')
  e.setPosture('sq', 'wave')
  const f = settledAndKept(e, 'fox')
  assert.equal(f.pose, 'wave')
  const s = settledAndKept(e, 'sq')
  assert.equal(BURROW_DATA.sprites.squirrel.poses.wave, undefined, 'the squirrel sheet has no wave')
  assert.equal(s.pose, null, 'no pose it does not have: it stands still')
  assert.equal(s.dir, towardDoor(s.x, s.y))
})

test('setPosture sleep: by the fireside asleep when the sprite has the pose, else standing still there', () => {
  const e = make(6)
  e.addActor('o', 'otter', { inside: true, room: 'lab' })
  e.addActor('sq', 'squirrel', { inside: true })
  e.setPosture('o', 'sleep')
  e.setPosture('sq', 'sleep')
  e.release('o')
  const o = settledAndKept(e, 'o')
  assert.equal(o.pose, 'sleep')
  assert.ok(FIRE.some((p) => p.x === o.x && p.y === o.y), `${o.x},${o.y} by the fire`)
  const s = settledAndKept(e, 'sq')
  assert.equal(s.pose, null)
  assert.ok(FIRE.some((p) => p.x === s.x && p.y === s.y), `${s.x},${s.y} by the fire`)
})

test('setPosture still: no stroll, no seat; stroll gives the idle wander back', () => {
  const e = make(8)
  e.addActor('a', 'beetle', { inside: true })
  e.setPosture('a', 'still')
  const a = settledAndKept(e, 'a')
  assert.equal(a.pose, null)
  assert.equal(a.mode, 'idle')
  const { x, y } = a
  e.setPosture('a', 'stroll')
  run(e, 60)
  assert.notEqual(`${a.x},${a.y}`, `${x},${y}`, 'idle again, it strolls')
})

test('a posture waits behind a job and behind resting: the room and the finished rest come first', () => {
  const e = make(9)
  e.addActor('a', 'fox', { inside: true, room: 'office' })
  e.setPosture('a', 'wave')
  run(e, 20)
  const a = e.actors.find((x) => x.key === 'a')!
  assert.equal(e.zoneOf(a.x, a.y), 'office')
  assert.equal(a.pose, null)
  e.release('a')
  run(e, 40)
  assert.equal(a.pose, 'wave')
  e.setResting('a', true)
  run(e, 40)
  assert.equal(a.pose, null, 'a finished agent keeps its plain dimmed rest')
})

test('an agent sent to a workshop runs: it reaches the room across the burrow within a few seconds, a stroll stays slow', () => {
  for (const room of ['office', 'library', 'workshop', 'lab'] as const) {
    const e = make(7)
    e.addActor('a', 'beetle', { inside: true })      // the slowest animal, from the lounge
    e.assign('a', room)
    run(e, 3.5)
    const a = e.actors.find((x) => x.key === 'a')!
    assert.equal(e.zoneOf(a.x, a.y), room, `in the ${room} after 3.5 s (${Math.round(a.x)},${Math.round(a.y)})`)
  }
})
