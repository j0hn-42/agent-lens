// Burrow view: an object of the room lights up briefly for each tool call received, wherever the animal is.
// One flash per received call, nothing else triggers one, and none in the still scene (reduced motion, Freeze motion).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { BURROW_DATA } from '../web/lib/burrow/burrow-data'
import { flashAlpha, flashesOf } from '../web/lib/burrow/burrow-flash'
import { BURROW_TELEPHONE } from '../web/lib/burrow/burrow-telephone'

type Room = 'office' | 'library' | 'workshop' | 'lab' | 'phone' | 'door'
/** Every object a room lights, read through flashesOf from many call ids */
const spotsOf = (room: Room) => {
  const seen = new Map<string, { x: number; y: number }>()
  for (let i = 0; i < 200; i++) for (const f of flashesOf([{ id: `call-${i}`, agentId: 'a', room }], false, 0)) seen.set(`${f.x},${f.y}`, { x: f.x, y: f.y })
  return [...seen.values()]
}
const BURROW_FLASH_SPOTS = Object.fromEntries((['office', 'library', 'workshop', 'lab', 'phone', 'door'] as const).map((r) => [r, spotsOf(r)])) as Record<Room, Array<{ x: number; y: number }>>

/** The room's floor, or its back wall just above it (where the screens, shelves and benches stand) */
const inRoom = (room: string, x: number, y: number) => BURROW_DATA.map.zones.some((z) => z.id === room && x >= z.x0 && x < z.x1 && y >= z.y0 - 45 && y < z.y1)

test('every room of a named tool has an object to light, inside its room of the picture', () => {
  for (const room of ['office', 'library', 'workshop', 'lab'] as const) {
    assert.ok(BURROW_FLASH_SPOTS[room].length > 0, room)
    for (const p of BURROW_FLASH_SPOTS[room]) assert.ok(inRoom(room, p.x, p.y), `${room} ${p.x},${p.y}`)
  }
  // a dispatch lights the telephone; a question to the user the lantern beside the front door
  const [phone] = BURROW_FLASH_SPOTS.phone
  assert.ok(phone.x >= BURROW_TELEPHONE.x && phone.x < BURROW_TELEPHONE.x + BURROW_TELEPHONE.rows[0].length)
  assert.ok(phone.y >= BURROW_TELEPHONE.y && phone.y <= BURROW_TELEPHONE.base)
  assert.ok(BURROW_DATA.map.lights.lanterns.some(([x, y]) => BURROW_FLASH_SPOTS.door.some((p) => p.x === x && p.y === y)))
})

test('one flash per received call, at an object of its room picked from the call id (the same call, the same object)', () => {
  const received = [
    { id: 'c1', agentId: 'a', room: 'office' as const },
    { id: 'c2', agentId: 'b', room: 'library' as const },
    { id: 'c3', agentId: 'a', room: 'phone' as const },
  ]
  const f = flashesOf(received, false, 12)
  assert.equal(f.length, 3)
  f.forEach((x, i) => {
    assert.ok(BURROW_FLASH_SPOTS[received[i].room].some((p) => p.x === x.x && p.y === x.y), received[i].room)
    assert.equal(x.t0, 12)
  })
  assert.deepEqual(flashesOf(received, false, 30).map((x) => [x.x, x.y]), f.map((x) => [x.x, x.y]))
  assert.deepEqual(flashesOf([], false, 12), [])
})

test('no flash in the still scene of reduced motion or Freeze motion', () => {
  assert.deepEqual(flashesOf([{ id: 'c1', agentId: 'a', room: 'workshop' }], true, 3), [])
})

test('a flash rises at once, fades, and is over in under a second', () => {
  assert.equal(flashAlpha(-0.1), 0)
  assert.ok(flashAlpha(0.1) > 0.5)
  assert.ok(flashAlpha(0.5) < flashAlpha(0.15))
  assert.equal(flashAlpha(1), 0)
})
