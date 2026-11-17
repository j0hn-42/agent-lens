// Burrow view: the idle squirrel's pastimes (the owner's explicit exception to "nothing is invented"). In the lounge the
// squirrel of an idle agent may read, have tea, stretch, sweep, poke the fire or polish an acorn: a pastime only means
// "idle". Only the squirrel (the drawing with these poses), only idle, only while the scene moves, never on floor kept for
// a place of its own nor on a room title, never in a work room; anything else ends it at once, and it says nothing.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { actShown, createBurrowEngine } from '../web/lib/burrow/burrow-engine'
import { BURROW_PASTIMES, PASTIME_FLOOR, hasPastimes } from '../web/lib/burrow/burrow-pastimes'
import { BURROW_DATA } from '../web/lib/burrow/burrow-data'
import { BURROW_ERROR_PLACE } from '../web/lib/burrow/burrow-error-place'
import { BURROW_TELEPHONE } from '../web/lib/burrow/burrow-telephone'

const FR = { lounge: 'Salon', office: 'Bureau', library: 'Bibliothèque', workshop: 'Atelier', lab: 'Labo', home: 'Maison' }
const EN = { lounge: 'Lounge', office: 'Office', library: 'Library', workshop: 'Workshop', lab: 'Laboratory', home: 'Home' }

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}
const make = (seed = 1, titles: Record<string, string> = FR) => {
  const e = createBurrowEngine({ data: BURROW_DATA, titles, rng: seeded(seed) })
  e.setPastimes(true)
  return e
}
type Engine = ReturnType<typeof make>
const actor = (e: Engine, key: string) => {
  const a = e.actors.find((x) => x.key === key)
  assert.ok(a, key)
  return a
}
const PASTIME_POSES = new Set(BURROW_PASTIMES.flatMap((p) => p.seq.map(([pose]) => pose)))
const poiAt = (x: number, y: number) => BURROW_DATA.map.poi.find((p) => p.x === x && p.y === y)
const keptFloor = (x: number, y: number): boolean =>
  [BURROW_TELEPHONE.reserved, BURROW_ERROR_PLACE.reserved].some((r) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3])
/** The engine's own rule: a character standing right in front of a mat would hide its title */
const hidesTitle = (e: Engine, x: number, y: number): boolean =>
  e.mats.some((m) => x > m.x - 10 && x < m.x + m.w + 10 && y > m.y - 2 && y < m.y + m.h + 30)

/** Runs `seconds` in steps of 0.1 s and records, at each step, what the actor `key` does */
function trace(e: Engine, key: string, seconds: number) {
  const out: Array<{ t: number; id: string | null; mode: string; pose: string | null; x: number; y: number; dir: string; said: string | null }> = []
  for (let t = 0; t < seconds; t += 0.1) {
    e.update(0.1)
    const a = actor(e, key)
    out.push({ t, id: e.pastimeOf(key), mode: a.mode, pose: a.pose, x: a.x, y: a.y, dir: a.dir, said: a.said })
  }
  return out
}
/** Each pastime played, in order: its id, where, which way it faced */
function plays(tr: ReturnType<typeof trace>) {
  const out: Array<{ id: string; x: number; y: number; dir: string; poses: Set<string> }> = []
  for (let i = 0; i < tr.length; i++) {
    const s = tr[i]
    if (s.id === null) continue
    if (i === 0 || tr[i - 1].id !== s.id || tr[i - 1].mode !== 'act') out.push({ id: s.id, x: s.x, y: s.y, dir: s.dir, poses: new Set() })
    if (s.pose) out[out.length - 1].poses.add(s.pose)
  }
  return out
}
const playing = async (e: Engine, key: string, limit = 400): Promise<void> => {
  for (let t = 0; t < limit && !(e.pastimeOf(key) !== null && actor(e, key).mode === 'act'); t += 0.1) e.update(0.1)
  assert.notEqual(e.pastimeOf(key), null, 'it plays a pastime at some point')
}

test('the table: six pastimes of the source, each with its poses, duration and weight; only the squirrel has their drawings', () => {
  assert.deepEqual(BURROW_PASTIMES.map((p) => p.id), ['read', 'tea', 'stretch', 'sweep', 'poke', 'acorn'])
  const byId = Object.fromEntries(BURROW_PASTIMES.map((p) => [p.id, p]))
  assert.deepEqual(byId.read.seq, [['readA', 2.6], ['readB', 0.5]])
  assert.deepEqual(byId.stretch.dur, [4.2, 4.2])
  assert.equal(byId.stretch.seq.reduce((s, x) => s + x[1], 0), 4.2, 'one stretch is exactly one pass')
  assert.deepEqual(byId.tea.spots, ['tea'])
  assert.deepEqual([byId.poke.spots, byId.poke.face], [['fire-1'], 'right'])
  assert.deepEqual(BURROW_PASTIMES.map((p) => p.weight), [3, 2, 1, 2, 2, 2])
  assert.deepEqual([...PASTIME_FLOOR], ['rug-left', 'rug-right', 'south-left', 'south-right', 'middle-left', 'middle', 'middle-right', 'bottom-left', 'bottom-right'])
  for (const p of BURROW_PASTIMES) for (const [pose] of p.seq) assert.ok(BURROW_DATA.sprites.squirrel.poses[pose], `${p.id}: ${pose}`)
  for (const p of BURROW_PASTIMES) for (const [, s] of p.seq) assert.ok(s >= 0.45, `${p.id}: never more than about two pose changes a second`)
  assert.equal(hasPastimes(BURROW_DATA.sprites.squirrel), true)
  for (const [name, meta] of Object.entries(BURROW_DATA.sprites)) if (name !== 'squirrel') assert.equal(hasPastimes(meta), false, name)
})

test('over ten minutes at rest an idle squirrel plays at least five different pastimes, only their poses, never the same twice in a row, and says nothing', () => {
  for (const seed of [1, 2, 3]) {
    const e = make(seed)
    e.addActor('sq', 'squirrel', { inside: true })
    const tr = trace(e, 'sq', 600)
    const list = plays(tr)
    assert.ok(new Set(list.map((p) => p.id)).size >= 5, `seed ${seed}: ${list.map((p) => p.id).join(' ')}`)
    for (let i = 1; i < list.length; i++) assert.notEqual(list[i].id, list[i - 1].id, `seed ${seed}: twice ${list[i].id}`)
    for (const p of list) {
      const allowed = new Set(BURROW_PASTIMES.find((q) => q.id === p.id)?.seq.map(([pose]) => pose))
      for (const pose of p.poses) assert.ok(allowed.has(pose), `${p.id}: ${pose}`)
    }
    for (const s of tr) {
      if (s.mode === 'act') assert.ok(s.pose !== null && PASTIME_POSES.has(s.pose), `${s.t}: ${s.pose}`)
      else assert.ok(s.pose === null || !PASTIME_POSES.has(s.pose), `${s.t}: a pastime pose outside a pastime (${s.mode} ${s.pose})`)
      assert.equal(s.said, null, 'no muttering')
    }
  }
})

test('a pastime is always on a lounge spot of its table, never on floor kept for a place of its own, a room title, a seat or the other fireside', () => {
  for (const [titles, seeds] of [[FR, [1, 4]], [EN, [5, 6]]] as const) {
    for (const seed of seeds) {
      const e = make(seed, titles)
      e.addActor('sq', 'squirrel', { inside: true })
      const tr = trace(e, 'sq', 600)
      const list = plays(tr)
      assert.ok(list.length >= 5, `${seed}: ${list.length}`)
      let lastStop: { x: number; y: number } | null = null
      for (let i = 0; i < tr.length; i++) {
        const s = tr[i]
        const starts = s.mode === 'act' && (i === 0 || tr[i - 1].mode !== 'act' || tr[i - 1].id !== s.id)
        if (starts) {
          const poi = poiAt(s.x, s.y)
          assert.ok(poi && poi.room === 'lounge', `${seed}: ${s.id} at ${s.x},${s.y}`)
          const p = BURROW_PASTIMES.find((q) => q.id === s.id)
          assert.ok(p)
          const spots: readonly string[] = p.spots === 'floor' ? PASTIME_FLOOR : p.spots
          assert.ok(spots.includes(poi.id), `${s.id} at ${poi.id}`)
          assert.equal(poi.perch, null, 'never on a seat')
          assert.notEqual(poi.id, 'fire-2')
          assert.notEqual(poi.id, 'middle', 'the middle spot is inside the place of errors')
          assert.equal(keptFloor(s.x, s.y), false, `${poi.id}: kept floor`)
          assert.equal(hidesTitle(e, s.x, s.y), false, `${poi.id}: on a title`)
          if (s.id === 'poke') assert.deepEqual([poi.id, s.dir], ['fire-1', 'right'])
          if (s.id === 'tea') assert.equal(poi.id, 'tea')
          if (s.id !== 'poke') assert.equal(s.dir, 'down')
          assert.ok(!lastStop || lastStop.x !== s.x || lastStop.y !== s.y, `${seed}: ${poi.id} twice in a row`)
        }
        // where it last stopped (stood, played or sat on a seat): a pastime never starts on the very spot it just left
        if ((s.mode === 'idle' || s.mode === 'act' || s.mode === 'sit') && (i + 1 === tr.length || tr[i + 1].mode !== s.mode)) lastStop = { x: s.x, y: s.y }
      }
    }
  }
})

test('only the squirrel plays: a fox and a hedgehog never do, even with pastimes on', () => {
  const e = make(7)
  e.addActor('f', 'fox', { inside: true })
  e.addActor('h', 'hedgehog', { inside: true })
  for (let t = 0; t < 400; t += 0.1) {
    e.update(0.1)
    for (const k of ['f', 'h']) { assert.equal(e.pastimeOf(k), null); assert.notEqual(actor(e, k).mode, 'act') }
  }
})

test('a squirrel that is not idle (seated, waving, asleep, in error, still), finished, at work or away never plays one', () => {
  const cases: Array<[string, (e: Engine) => void]> = [
    ['sit', (e) => e.setPosture('sq', 'sit')],
    ['wave', (e) => e.setPosture('sq', 'wave')],
    ['sleep', (e) => e.setPosture('sq', 'sleep')],
    ['error', (e) => e.setPosture('sq', 'error')],
    ['still', (e) => e.setPosture('sq', 'still')],
    ['resting', (e) => e.setResting('sq', true)],
    ['job', (e) => e.assign('sq', 'office')],
    ['door post', (e) => e.assign('sq', 'door')],
    ['away', (e) => e.setAvailable('sq', false)],
  ]
  for (const [name, set] of cases) {
    const e = make(8)
    e.addActor('sq', 'squirrel', { inside: true })
    set(e)
    for (let t = 0; t < 300; t += 0.1) {
      e.update(0.1)
      assert.equal(e.pastimeOf('sq'), null, `${name} at ${t.toFixed(1)}`)
      assert.notEqual(actor(e, 'sq').mode, 'act', name)
    }
  }
})

test('with pastimes off (reduced motion, Freeze motion) the engine plays none; off by default', () => {
  const e = createBurrowEngine({ data: BURROW_DATA, titles: FR, rng: seeded(9) })
  e.addActor('sq', 'squirrel', { inside: true })
  for (let t = 0; t < 400; t += 0.1) { e.update(0.1); assert.equal(e.pastimeOf('sq'), null) }
  e.setPastimes(false)
  e.fastForward(400)
  assert.equal(e.pastimeOf('sq'), null)
})

test('a job interrupts a pastime at once: half a second later it is on its way, with no pastime pose', async () => {
  const e = make(10)
  e.addActor('sq', 'squirrel', { inside: true })
  await playing(e, 'sq')
  e.assign('sq', 'office')
  for (let t = 0; t < 0.5; t += 0.1) e.update(0.1)
  const a = actor(e, 'sq')
  assert.equal(a.mode, 'walk')
  assert.equal(e.pastimeOf('sq'), null)
  assert.ok(a.pose === null || !PASTIME_POSES.has(a.pose))
  for (let t = 0; t < 30; t += 0.1) e.update(0.1)
  assert.equal(e.zoneOf(a.x, a.y), 'office')
})

test('a new posture (thinking: a seat) interrupts a pastime at once', async () => {
  const e = make(11)
  e.addActor('sq', 'squirrel', { inside: true })
  await playing(e, 'sq')
  e.setPosture('sq', 'sit')
  assert.equal(e.pastimeOf('sq'), null)
  assert.ok(actor(e, 'sq').pose === null || !PASTIME_POSES.has(actor(e, 'sq').pose as string))
  for (let t = 0; t < 0.5; t += 0.1) e.update(0.1)
  assert.notEqual(actor(e, 'sq').mode, 'act')
})

test('setPastimes(false) ends a pastime at once, and also one it walks to; none starts again', async () => {
  const e = make(12)
  e.addActor('sq', 'squirrel', { inside: true })
  await playing(e, 'sq')
  e.setPastimes(false)
  assert.equal(e.pastimeOf('sq'), null)
  assert.notEqual(actor(e, 'sq').mode, 'act')
  for (let t = 0; t < 400; t += 0.1) { e.update(0.1); assert.notEqual(actor(e, 'sq').mode, 'act'); assert.equal(e.pastimeOf('sq'), null) }
})

test('a failure (hold) ends a pastime: the animal stands held, its act shown, then decides anew; finished, unavailable or removed it stops too', async () => {
  const e = make(13)
  e.addActor('sq', 'squirrel', { inside: true })
  await playing(e, 'sq')
  e.setAct('sq', { pose: 'sheepish', sign: 'alert', fx: [] })
  assert.equal(e.hold('sq', 3.1), true)
  const a = actor(e, 'sq')
  assert.equal(e.pastimeOf('sq'), null)
  assert.notEqual(a.mode, 'act')
  assert.equal(actShown(a, e.clock)?.pose, 'sheepish')
  const at = { x: a.x, y: a.y }
  for (let t = 0; t < 3; t += 0.1) e.update(0.1)
  assert.deepEqual({ x: a.x, y: a.y }, at, 'held where it is')
  assert.equal(e.pastimeOf('sq'), null)

  for (const [name, stop] of [
    ['resting', (x: Engine) => x.setResting('sq', true)],
    ['unavailable', (x: Engine) => x.setAvailable('sq', false)],
    ['removed', (x: Engine) => x.removeActor('sq')],
  ] as const) {
    const x = make(14)
    x.addActor('sq', 'squirrel', { inside: true })
    x.addActor('other', 'fox', { inside: true })
    await playing(x, 'sq')
    stop(x)
    assert.equal(x.pastimeOf('sq'), null, name)
    assert.notEqual(actor(x, 'sq').mode, 'act', name)
  }
})

test('an act set by the view shows on a squirrel playing a pastime (it stands)', async () => {
  const e = make(15)
  e.addActor('sq', 'squirrel', { inside: true })
  await playing(e, 'sq')
  e.setAct('sq', { sign: 'alert', fx: [] })
  assert.equal(actShown(actor(e, 'sq'), e.clock)?.sign, 'alert')
})

test('the same seed gives the same scene, pastimes included', () => {
  const run = () => {
    const e = make(16)
    e.addActor('sq', 'squirrel', { inside: true })
    e.addActor('f', 'fox', { inside: true })
    return trace(e, 'sq', 300).map((s) => `${s.id}|${s.mode}|${s.pose}|${s.x.toFixed(2)}|${s.y.toFixed(2)}`).join('\n')
  }
  assert.equal(run(), run())
})

test('two squirrels never share a pastime spot at once', () => {
  const e = make(17)
  e.addActor('s1', 'squirrel', { inside: true })
  e.addActor('s2', 'squirrel', { inside: true })
  let both = 0
  for (let t = 0; t < 600; t += 0.1) {
    e.update(0.1)
    const a = actor(e, 's1')
    const b = actor(e, 's2')
    if (a.mode === 'act' && b.mode === 'act') { both++; assert.ok(a.x !== b.x || a.y !== b.y, `${t}`) }
  }
  assert.ok(both > 0, 'both played at the same time at some point')
})
