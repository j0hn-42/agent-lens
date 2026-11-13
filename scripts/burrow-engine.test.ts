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
