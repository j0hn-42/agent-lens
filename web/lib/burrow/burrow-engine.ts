/**
 * Burrow view: the movement engine (no DOM, no drawing). Ported from the pixel-art burrow prototype with its demo removed:
 * nothing happens at random except where an idle agent strolls in the lounge. An agent works in a room only because it
 * was assigned there (assign) and goes back to the lounge when released; it is outside only when unavailable. A finished
 * agent rests (setResting): it goes back to the lounge and stands still, so nothing is invented for it. In the lounge an
 * agent holds the posture of its observed state (setPosture): seated, waving at the door, asleep by the fire or still;
 * only the 'stroll' posture wanders.
 * What the picture says is decided by burrow-model.ts, from observed states.
 */
import { BURROW_ANIMALS, type BurrowData, type BurrowDir, type BurrowPoi, type BurrowPosture, type BurrowRoomId, type BurrowSpriteMeta, type BurrowWorkshopId } from './burrow-types'
import { BURROW_TELEPHONE } from './burrow-telephone'

const LOUNGE: BurrowRoomId = 'lounge'
const WORKSHOPS: readonly BurrowWorkshopId[] = ['office', 'library', 'workshop', 'lab', 'phone', 'door']
/** Places made of fixed posts rather than of a room's furniture: the telephone, beside the front door */
type PostKind = 'phone' | 'door'
const isPostKind = (room: BurrowRoomId): room is PostKind => room === 'phone' || room === 'door'
/** Which way an animal at a post looks: callers face the telephone (on their left), the others the front door (on their right) */
const POST_FACE: Record<PostKind, BurrowDir> = { phone: 'left', door: 'right' }
/** Seconds an unavailable agent still waits in the lounge before it walks out through the front door */
const HOME_AFTER_S = 4
/** An agent on its way to a workshop or the door post moves this many times faster than a stroll */
const RUN_FACTOR = 3.5
const SAY_NEVER_ENDS = Number.POSITIVE_INFINITY

type Mode = 'idle' | 'queue' | 'walk' | 'doorOut' | 'doorIn' | 'home' | 'hopOn' | 'hopOff' | 'sit'
type Step =
  | { t: 'walk'; x: number; y: number }
  | { t: 'idle'; dur: number; face?: BurrowDir; pose?: string }
  | { t: 'door' }
  | { t: 'perch'; x: number; y: number; pose: string; dur: number }
type Pt = { x: number; y: number }

export interface BurrowActor {
  /** Identity given by the caller (the agent key) */
  readonly key: string
  readonly sprite: string
  readonly meta: BurrowSpriteMeta
  x: number
  y: number
  dir: BurrowDir
  mode: Mode
  alpha: number
  pose: string | null
  zone: BurrowRoomId | null
  animT: number
  fps: number
  /** Speech bubble: text and whether it is shown (the view draws it) */
  said: string | null
  sayUntil: number
  /** Doorstep progress, 0 = on the floor in front of the door, 1 = deep in the doorway */
  tp: number
  wait: number
  /** Finished agent: stands still in the lounge (drawn dimmed), no stroll and no seat */
  resting: boolean
}

interface Actor extends BurrowActor {
  speed: number
  plan: Step[]
  route: Pt[]
  poi: BurrowPoi | null
  lastPoi: BurrowPoi | null
  job: { room: BurrowWorkshopId } | null
  dx: number
  hop: { x: number; y: number; px: number; py: number } | null
  hopT: number
  awaySince: number | null
  goingHome: boolean
  leaving: boolean
  gone: boolean
  /** The post this agent holds (job 'phone' or 'door'), else null */
  post: { kind: PostKind; i: number } | null
  /** How it holds itself in the lounge when it has no job and does not rest (setPosture) */
  posture: BurrowPosture
}

export interface BurrowMat { id: string; label: string; x: number; y: number; w: number; h: number }

export interface BurrowEngineOptions {
  data: BurrowData
  /** Title woven in each room's mat (and the doormat 'home'); upper-cased by the engine */
  titles: Readonly<Record<string, string>>
  /** [0, 1): injectable so tests are deterministic */
  rng?: () => number
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export function textWidth(font: BurrowData['font'], text: string): number {
  let w = 0
  for (const ch of text) w += (font.glyphs[ch] ?? font.glyphs[' ']).w + font.spacing
  return Math.max(0, w - font.spacing)
}

/** Where each title mat lies, from the width of its lettering */
function layoutMats(data: BurrowData, titles: Readonly<Record<string, string>>): BurrowMat[] {
  const out: BurrowMat[] = []
  const M = data.fx.mat
  for (const m of data.map.mats) {
    const label = titles[m.id]
    if (label === undefined) continue
    const text = label.toUpperCase()
    const w = textWidth(data.font, text) + 2 * (M.cap + M.pad)
    out.push({ id: m.id, label: text, x: m.x - (w >> 1), y: m.y - (M.h >> 1), w, h: M.h })
  }
  return out
}

export function createBurrowEngine(opts: BurrowEngineOptions) {
  const { data } = opts
  const rng = opts.rng ?? Math.random
  const MAP = data.map
  const { gw: GW, gh: GH, cell: CELL } = MAP
  const rnd = (a: number, b: number): number => a + rng() * (b - a)
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]

  // ---------------- walk map ----------------
  const walk = new Uint8Array(GW * GH)
  MAP.grid.forEach((row, gy) => {
    for (let gx = 0; gx < GW; gx++) walk[gy * GW + gx] = row.charCodeAt(gx) === 49 ? 1 : 0
  })
  // the telephone's table stands on the floor: nobody walks through it
  {
    const [x0, y0, x1, y1] = BURROW_TELEPHONE.block
    for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) walk[gy * GW + gx] = 0
    }
  }
  const cellOk = (gx: number, gy: number): boolean => gx >= 0 && gy >= 0 && gx < GW && gy < GH && walk[gy * GW + gx] === 1
  const pointOk = (x: number, y: number): boolean => cellOk(Math.floor(x / CELL), Math.floor(y / CELL))
  function zoneOf(x: number, y: number): BurrowRoomId {
    for (const z of MAP.zones) if (x >= z.x0 && x < z.x1 && y >= z.y0 && y < z.y1) return z.id
    return LOUNGE
  }
  const cellPoint = (c: [number, number]): Pt => ({ x: c[0] * CELL + CELL / 2, y: c[1] * CELL + CELL / 2 })

  // The title-dependent parts (mats, where agents may stop, door posts) live in fixed containers that setTitles refills in place
  const mats: BurrowMat[] = []
  // a character standing right in front of a mat would hide its title: agents walk over the mats but never stop there
  const hidesTitle = (x: number, y: number): boolean => mats.some((m) => x > m.x - 10 && x < m.x + m.w + 10 && y > m.y - 2 && y < m.y + m.h + 30)
  // floor kept for a place of its own (the telephone's callers): an animal walks over it but stops there only to hold that place
  const KEPT: ReadonlyArray<readonly [number, number, number, number]> = [BURROW_TELEPHONE.reserved]
  const kept = (x: number, y: number): boolean => KEPT.some((r) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3])
  const zoneCells: Partial<Record<BurrowRoomId, Array<[number, number]>>> = {}
  const cellsOf = (room: BurrowRoomId): Array<[number, number]> => zoneCells[room] ?? zoneCells[LOUNGE] ?? [[Math.floor(GW / 2), Math.floor(GH / 2)]]
  // Posts: at the telephone (burrow-telephone), and a row beside the front door, facing it. Never on a title mat, never in
  // the lane in front of the doorway that agents use to come in and go out.
  const posts: Record<PostKind, Pt[]> = { phone: [], door: [] }

  function layTitles(titles: Readonly<Record<string, string>>): void {
    mats.length = 0
    mats.push(...layoutMats(data, titles))
    for (const k of Object.keys(zoneCells)) delete zoneCells[k as BurrowRoomId]
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        if (!cellOk(gx, gy)) continue
        const c = cellPoint([gx, gy])
        if (hidesTitle(c.x, c.y) || kept(c.x, c.y)) continue
        const z = zoneOf(c.x, c.y)
        ;(zoneCells[z] ??= []).push([gx, gy])
      }
    }
    posts.door.length = 0
    for (const dy of [6, 22]) {
      for (let dx = 30; dx <= 102; dx += 12) {
        const x = MAP.door.cx - dx
        const y = MAP.door.front + dy
        if (Math.abs(x - MAP.door.cx) > 14 && pointOk(x, y) && !hidesTitle(x, y)) posts.door.push({ x, y })
      }
    }
    posts.phone.length = 0
    for (const p of BURROW_TELEPHONE.posts) if (pointOk(p.x, p.y) && !hidesTitle(p.x, p.y)) posts.phone.push({ x: p.x, y: p.y })
  }
  layTitles(opts.titles)

  function nearestCell(x: number, y: number): [number, number] | null {
    const cx = Math.floor(x / CELL)
    const cy = Math.floor(y / CELL)
    if (cellOk(cx, cy)) return [cx, cy]
    for (let r = 1; r <= 16; r++) {
      let best: [number, number] | null = null
      let bd = 1e9
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !cellOk(cx + dx, cy + dy)) continue
          const d = dx * dx + dy * dy
          if (d < bd) { bd = d; best = [cx + dx, cy + dy] }
        }
      }
      if (best) return best
    }
    return null
  }
  function lineOk(x0: number, y0: number, x1: number, y1: number): boolean {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2))
    for (let i = 0; i <= n; i++) if (!pointOk(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n)) return false
    return true
  }
  /** A* on the grid, then path smoothing */
  function findPath(sx: number, sy: number, tx: number, ty: number): Pt[] | null {
    const s = nearestCell(sx, sy)
    const t = nearestCell(tx, ty)
    if (!s || !t) return null
    const N = GW * GH
    const si = s[1] * GW + s[0]
    const ti = t[1] * GW + t[0]
    const cost = new Float32Array(N).fill(Infinity)
    const came = new Int32Array(N).fill(-1)
    const closed = new Uint8Array(N)
    const heap: Array<[number, number]> = []
    const push = (f: number, i: number): void => {
      heap.push([f, i])
      let c = heap.length - 1
      while (c > 0) {
        const p = (c - 1) >> 1
        if (heap[p][0] <= heap[c][0]) break
        const tmp = heap[p]; heap[p] = heap[c]; heap[c] = tmp
        c = p
      }
    }
    const pop = (): [number, number] => {
      const top = heap[0]
      const last = heap.pop() as [number, number]
      if (heap.length) {
        heap[0] = last
        let p = 0
        for (;;) {
          const l = 2 * p + 1
          const r = l + 1
          let m = p
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r
          if (m === p) break
          const tmp = heap[p]; heap[p] = heap[m]; heap[m] = tmp
          p = m
        }
      }
      return top
    }
    const h = (i: number): number => {
      const dx = Math.abs((i % GW) - t[0])
      const dy = Math.abs(Math.floor(i / GW) - t[1])
      return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)
    }
    cost[si] = 0
    push(h(si), si)
    while (heap.length) {
      const cur = pop()[1]
      if (cur === ti) break
      if (closed[cur]) continue
      closed[cur] = 1
      const cx = cur % GW
      const cy = Math.floor(cur / GW)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = cx + dx
          const ny = cy + dy
          if (!cellOk(nx, ny)) continue
          if (dx && dy && (!cellOk(cx + dx, cy) || !cellOk(cx, cy + dy))) continue
          const ni = ny * GW + nx
          if (closed[ni]) continue
          const nc = cost[cur] + (dx && dy ? Math.SQRT2 : 1)
          if (nc < cost[ni]) { cost[ni] = nc; came[ni] = cur; push(nc + h(ni), ni) }
        }
      }
    }
    if (ti !== si && came[ti] < 0) return null
    const cells: number[] = []
    for (let i = ti; i >= 0; i = came[i]) { cells.push(i); if (i === si) break }
    cells.reverse()
    const pts: Pt[] = cells.map((i) => ({ x: (i % GW) * CELL + CELL / 2, y: Math.floor(i / GW) * CELL + CELL / 2 }))
    if (pointOk(tx, ty)) pts.push({ x: tx, y: ty })
    pts.unshift({ x: sx, y: sy })
    const out: Pt[] = []
    let i = 0
    while (i < pts.length - 1) {
      let j = pts.length - 1
      while (j > i + 1 && !lineOk(pts[i].x, pts[i].y, pts[j].x, pts[j].y)) j--
      out.push(pts[j])
      i = j
    }
    return out
  }

  // ---------------- agents ----------------
  const actors: Actor[] = []
  // the same actors by key, kept in step with `actors` (push / splice): the view asks about them inside loops over the agents
  const index = new Map<string, Actor>()
  let clock = 0
  const door: { user: Actor | null; closeAt: number } = { user: null, closeAt: 0 }
  const doorIsOpen = (): boolean => door.user !== null || clock < door.closeAt

  const byKey = (key: string): Actor | undefined => index.get(key)
  const canUse = (a: Actor, p: BurrowPoi & { taken?: Actor | null }): boolean => !p.taken && (!p.perch || !!a.meta.poses[p.perch.pose])
  // POIs are shared mutable data of the picture: the engine keeps its own copy so two engines never see each other's seats
  const pois: Array<BurrowPoi & { taken: Actor | null }> = MAP.poi.map((p) => ({ ...p, taken: null }))
  const freePois = (a: Actor, room: BurrowRoomId) => pois.filter((p) => p.room === room && canUse(a, p))
  const outside = (o: Actor): boolean => o.mode === 'home' || o.mode === 'doorOut' || o.mode === 'doorIn'
  const dueHome = (a: Actor): boolean => a.leaving || (a.awaySince !== null && clock - a.awaySince >= HOME_AFTER_S)
  // agents leave one after the other: nobody sets off for the door while a colleague is still walking to it
  const wayClear = (a: Actor): boolean => !actors.some((o) => o !== a && o.goingHome && o.mode !== 'doorOut')
  function takePoi(a: Actor, p: BurrowPoi & { taken: Actor | null }): void { p.taken = a; a.poi = p; a.zone = p.room }
  function releasePoi(a: Actor): void {
    if (a.poi) {
      const p = pois.find((q) => q.id === a.poi?.id)
      if (p) p.taken = null
      a.lastPoi = a.poi
      a.poi = null
    }
  }
  function stayOutside(a: Actor, delay: number): void {
    a.mode = 'home'; a.alpha = 0; a.wait = delay; a.plan = []; a.pose = null; a.zone = null
    a.x = MAP.door.cx; a.y = MAP.door.deep
  }
  const placeAt = (a: Actor, p: BurrowPoi & { taken: Actor | null }): void => { takePoi(a, p); a.x = p.x; a.y = p.y; a.dir = p.face }

  /**
   * Adds an agent. `inside`: it is in the burrow from the start (in the lounge, or at its post when `room` is given);
   * otherwise it is outside and walks in through the front door.
   */
  function addActor(key: string, sprite: string, opt: { inside: boolean; room?: BurrowWorkshopId }): void {
    if (byKey(key)) return
    const meta = data.sprites[sprite]
    const animal = BURROW_ANIMALS.find((c) => c.sprite === sprite)
    if (!meta || !animal) return
    const a: Actor = {
      key, sprite, meta, speed: animal.speed * rnd(0.94, 1.06),
      fps: Math.max(6, Math.min(11, Math.round(meta.anims.down.frames * 1.5))),
      x: 0, y: 0, dir: 'down', mode: 'idle', wait: 0, plan: [{ t: 'idle', dur: rnd(0.3, 2.5) }], route: [], animT: rng(), alpha: 1,
      pose: null, poi: null, lastPoi: null, zone: LOUNGE, job: null, tp: 0, dx: 0, hop: null, hopT: 0,
      awaySince: null, goingHome: false, leaving: false, gone: false, said: null, sayUntil: 0, resting: false, post: null, posture: 'stroll',
    }
    actors.push(a)
    index.set(key, a)
    if (!opt.inside) { stayOutside(a, 0.3 + 1.2 * actors.filter((o) => o.mode === 'home').length); return }
    const room = opt.room
    if (room && isPostKind(room)) {
      const p = takePost(a, room)
      if (p) {
        a.x = p.x; a.y = p.y; a.dir = POST_FACE[room]; a.zone = LOUNGE
        a.job = { room }
        a.plan = [{ t: 'idle', dur: Number.POSITIVE_INFINITY, face: POST_FACE[room] }]
        begin(a)
        return
      }
    }
    if (room) {
      const free = freePois(a, room)
      if (free.length) {
        placeAt(a, pick(free))
        a.job = { room }
        a.plan = [{ t: 'idle', dur: rnd(7, 13), face: a.dir }]
        begin(a)
        return
      }
    }
    const spots = pois.filter((q) => q.room === LOUNGE && !q.taken && !q.perch && !kept(q.x, q.y))
    if (spots.length) placeAt(a, pick(spots))
    else { const c = cellPoint(pick(cellsOf(LOUNGE))); a.x = c.x; a.y = c.y }
    if (room) { a.job = { room }; replan(a) } else begin(a)
  }

  /** The agent walks out through the front door for good (it is gone from the data) */
  function removeActor(key: string): void {
    const a = byKey(key)
    if (!a || a.leaving) return
    a.leaving = true; a.job = null
    if (a.mode === 'home') { a.gone = true }
  }

  function replan(a: Actor): void {                 // decide again without waiting for the end of what the agent was doing
    if (a.mode === 'walk' || a.mode === 'idle' || a.mode === 'queue') { a.pose = null; a.plan = []; begin(a) }
    else if (a.mode === 'sit') a.wait = 0
    else if (a.mode === 'hopOn') (a.plan[0] as { dur: number }).dur = 0.2
  }
  function comeBack(a: Actor): boolean {            // available again
    a.awaySince = null
    if (a.goingHome && (a.mode === 'walk' || a.mode === 'queue' || a.mode === 'idle')) { a.goingHome = false; return true }
    return false                                    // in the doorway or at home: it finishes going out, then walks straight back in
  }
  /** Sends the agent to a workshop; it stays there until release(). An agent that was away comes back in through the front door first. */
  function assign(key: string, room: BurrowWorkshopId): boolean {
    const a = byKey(key)
    if (!a || a.leaving || !WORKSHOPS.includes(room)) return false
    if (a.job?.room === room && a.awaySince === null && !a.resting) return true
    comeBack(a)
    a.resting = false
    a.job = { room }
    replan(a)
    return true
  }
  function release(key: string): boolean {
    const a = byKey(key)
    if (!a || !a.job) return false
    a.job = null
    replan(a)
    return true
  }
  /** A finished agent rests: back to the lounge, then it stands still until rested again (or sent away) */
  function setResting(key: string, resting: boolean): boolean {
    const a = byKey(key)
    if (!a || a.leaving) return false
    if (a.resting === resting) return true
    a.resting = resting
    if (resting) a.job = null
    replan(a)
    return true
  }
  function setAvailable(key: string, available: boolean): boolean {
    const a = byKey(key)
    if (!a || a.leaving) return false
    if (available) { if (a.awaySince !== null && comeBack(a)) replan(a); else a.awaySince = null }
    else if (a.awaySince === null) {
      a.awaySince = clock
      if (a.job) { a.job = null; replan(a) }          // it was working: back to the lounge right away
    }
    return true
  }
  /**
   * How the agent holds itself in the lounge, from its observed state (burrow-model postureOf). It waits behind a job,
   * a rest or a stay outside: the agent takes it up once it is back in the lounge with nothing else to do.
   */
  function setPosture(key: string, posture: BurrowPosture): boolean {
    const a = byKey(key)
    if (!a || a.leaving) return false
    if (a.posture === posture) return true
    a.posture = posture
    if (!a.job && !a.resting && !a.goingHome && !outside(a)) replan(a)
    return true
  }
  /** `dur` seconds (Infinity = until said again); null hushes */
  function say(key: string, text: string | null, dur = 6): void {
    const a = byKey(key)
    if (!a) return
    a.said = text
    a.sayUntil = text === null ? 0 : clock + dur
  }

  /** A post of that kind for `a`: the one it holds, else the first free one, nearest first (null when all are taken) */
  function takePost(a: Actor, kind: PostKind): Pt | null {
    const list = posts[kind]
    if (a.post?.kind === kind && list[a.post.i]) return list[a.post.i]
    for (let i = 0; i < list.length; i++) {
      if (!actors.some((o) => o !== a && o.post?.kind === kind && o.post.i === i)) { a.post = { kind, i }; return list[i] }
    }
    a.post = null
    return null
  }
  function goWork(a: Actor, room: BurrowWorkshopId): void {   // a free post in the room (failing that, a standing spot in it)
    if (isPostKind(room)) {                                   // at the telephone, or beside the front door: held until released
      const p = takePost(a, room)
      if (p) { a.zone = LOUNGE; a.plan = [{ t: 'walk', x: p.x, y: p.y }, { t: 'idle', dur: Number.POSITIVE_INFINITY, face: POST_FACE[room] }]; return }
      // every post taken: it stands still in the lounge, and looks again for a free post after a while
      const c = standingSpot(a)
      a.zone = LOUNGE
      a.plan = [{ t: 'walk', x: c.x, y: c.y }, { t: 'idle', dur: rnd(4, 8), face: 'down' }]
      return
    }
    const free = freePois(a, room)
    const others = free.filter((p) => p !== a.lastPoi)
    const p = free.length ? pick(others.length ? others : free) : null
    if (p) { takePoi(a, p); a.plan = [{ t: 'walk', x: p.x, y: p.y }, { t: 'idle', dur: rnd(7, 13), face: p.face }]; return }
    const c = cellPoint(pick(cellsOf(room)))
    a.zone = room
    a.plan = [{ t: 'walk', x: c.x, y: c.y }, { t: 'idle', dur: rnd(7, 13), face: 'up' }]
  }
  function goHome(a: Actor): void {                 // walks to the front door and leaves the burrow
    a.goingHome = true; a.job = null; a.zone = null; a.post = null
    a.dx = Math.round(rnd(-3, 3))
    a.plan = [{ t: 'walk', x: MAP.door.cx + a.dx, y: MAP.door.front }, { t: 'door' }]
  }
  function chooseGoal(a: Actor): void {
    releasePoi(a)
    if (a.post && a.job?.room !== a.post.kind) a.post = null

    if (dueHome(a) && wayClear(a)) { goHome(a); return }
    if (a.job) { goWork(a, a.job.room); return }      // next post in the same room, until released
    if (a.resting) {                                   // finished: a standing spot in the lounge, then nothing more
      const c = cellPoint(pick(cellsOf(LOUNGE)))
      a.zone = LOUNGE
      a.plan = [{ t: 'walk', x: c.x, y: c.y }, { t: 'idle', dur: Number.POSITIVE_INFINITY, face: 'down' }]
      return
    }
    if (a.posture !== 'stroll') { hold(a, a.posture); return }
    const r = rng()
    // settle somewhere in the lounge: sofa, armchair, pouf, fireside...
    if (r < 0.9) {
      const free = freePois(a, LOUNGE).filter((p) => p !== a.lastPoi && !kept(p.x, p.y))
      if (free.length) {
        const w = free.map((q) => (q.perch ? 2.2 : q.id.startsWith('fire') ? 1.6 : 1))
        let pickR = rng() * w.reduce((p, q) => p + q, 0)
        let chosen = free[free.length - 1]
        for (let i = 0; i < free.length; i++) { pickR -= w[i]; if (pickR <= 0) { chosen = free[i]; break } }
        takePoi(a, chosen)
        const tail: Step = chosen.perch
          ? { t: 'perch', x: chosen.perch.x, y: chosen.perch.y, pose: chosen.perch.pose, dur: rnd(9, 16) }
          : { t: 'idle', dur: rnd(5, 11), face: chosen.face }
        a.plan = [{ t: 'walk', x: chosen.x, y: chosen.y }, tail]
        return
      }
    }
    // a simple stroll in the lounge
    const c = cellPoint(pick(cellsOf(LOUNGE)))
    a.zone = LOUNGE
    a.plan = [{ t: 'walk', x: c.x, y: c.y }, { t: 'idle', dur: rnd(1.5, 4) }]
  }
  const nearest = <T extends Pt>(a: Actor, spots: readonly T[]): T | undefined => {
    let best: T | undefined
    let bd = Infinity
    for (const p of spots) { const d = Math.hypot(p.x - a.x, p.y - a.y); if (d < bd) { bd = d; best = p } }
    return best
  }
  const poseIf = (a: Actor, pose: string): string | undefined => (a.meta.poses[pose] ? pose : undefined)
  /** Where it stands in the lounge: where it is when that is a lounge spot that hides no title, else a lounge cell */
  function standingSpot(a: Actor): Pt {
    if (zoneOf(a.x, a.y) === LOUNGE && pointOk(a.x, a.y) && !hidesTitle(a.x, a.y) && !kept(a.x, a.y)) return { x: a.x, y: a.y }
    return cellPoint(pick(cellsOf(LOUNGE)))
  }
  /** The posture of a state other than idle, held until the state changes (no end, no wander) */
  function hold(a: Actor, posture: Exclude<BurrowPosture, 'stroll'>): void {
    a.zone = LOUNGE
    if (posture === 'sit') {                         // thinking: the nearest free seat; none free, it stands still
      const seat = nearest(a, freePois(a, LOUNGE).filter((p) => p.perch))
      if (seat?.perch) {
        takePoi(a, seat)
        a.plan = [{ t: 'walk', x: seat.x, y: seat.y }, { t: 'perch', x: seat.perch.x, y: seat.perch.y, pose: seat.perch.pose, dur: Number.POSITIVE_INFINITY }]
        return
      }
    }
    if (posture === 'sleep') {                       // last known state: by the fireside, asleep when the sprite can be
      const fire = nearest(a, freePois(a, LOUNGE).filter((p) => p.id.startsWith('fire')))
      const pose = poseIf(a, 'sleep')
      if (fire) { takePoi(a, fire); a.plan = [{ t: 'walk', x: fire.x, y: fire.y }, { t: 'idle', dur: Number.POSITIVE_INFINITY, face: fire.face, pose }]; return }
      const c = standingSpot(a)
      a.plan = [{ t: 'walk', x: c.x, y: c.y }, { t: 'idle', dur: Number.POSITIVE_INFINITY, face: 'down', pose }]
      return
    }
    const c = standingSpot(a)
    if (posture === 'wave') {                        // waiting for a permission: facing the front door, waving when it can
      const dx = MAP.door.cx - c.x
      const dy = MAP.door.front - c.y
      const toDoor: BurrowDir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')
      a.plan = [{ t: 'walk', x: c.x, y: c.y }, { t: 'idle', dur: Number.POSITIVE_INFINITY, face: toDoor, pose: poseIf(a, 'wave') }]
      return
    }
    a.plan = [{ t: 'walk', x: c.x, y: c.y }, { t: 'idle', dur: Number.POSITIVE_INFINITY, face: 'down' }]
  }
  function begin(a: Actor): void {
    if (!a.plan.length) chooseGoal(a)
    const st = a.plan[0]
    if (st.t === 'walk') {
      const p = findPath(a.x, a.y, st.x, st.y)
      if (!p) { releasePoi(a); a.goingHome = false; a.plan = [{ t: 'idle', dur: 1 }]; begin(a); return }
      a.route = p; a.mode = 'walk'
    } else if (st.t === 'door') {
      a.dir = 'up'
      if (door.user && door.user !== a) {             // someone is coming in: step aside, then come back to the door
        const T = MAP.door
        const sx = T.cx + 9
        const sy = T.front + 54
        if (pointOk(sx, sy)) {
          a.plan = [{ t: 'walk', x: sx, y: sy }, { t: 'idle', dur: 0.8, face: 'up' }, { t: 'walk', x: T.cx + a.dx, y: T.front }, { t: 'door' }]
          begin(a)
        } else { a.mode = 'queue'; a.wait = 0.4 }
      } else { door.user = a; a.mode = 'doorOut'; a.tp = 0; a.wait = 0.35 }
    } else if (st.t === 'perch') {
      a.hop = { x: a.x, y: a.y, px: st.x, py: st.y }; a.hopT = 0; a.mode = 'hopOn'
      a.dir = Math.abs(st.x - a.x) > Math.abs(st.y - a.y) ? (st.x > a.x ? 'right' : 'left') : (st.y > a.y ? 'down' : 'up')
    } else {
      a.mode = 'idle'; a.wait = st.dur; a.pose = st.pose ?? null
      if (st.face) a.dir = st.face
    }
  }
  function face(a: Actor, dx: number, dy: number): void {
    const side = a.dir === 'left' || a.dir === 'right'
    if (Math.abs(dx) > Math.abs(dy) * (side ? 0.55 : 1.3)) a.dir = dx > 0 ? 'right' : 'left'
    else a.dir = dy > 0 ? 'down' : 'up'
  }
  function tick(a: Actor, dt: number): void {
    if (a.said !== null && clock > a.sayUntil) a.said = null
    // time to go home: as soon as the way to the door is clear and what the agent is doing can be interrupted
    if (dueHome(a) && !a.goingHome && !outside(a) && wayClear(a)) replan(a)
    const done = (): void => { a.plan.shift(); begin(a) }
    const T = MAP.door
    switch (a.mode) {
      case 'idle':
        a.wait -= dt
        if (a.wait <= 0) { a.pose = null; done() }
        break
      case 'queue':
        a.wait -= dt
        if (a.wait <= 0) begin(a)
        break
      case 'walk': {
        // sent to work (a tool call is often over in a second): it runs, so the room it reaches is still the tool's
        const pace = a.job && !a.goingHome ? RUN_FACTOR : 1
        let d = a.speed * pace * dt
        a.animT += dt * pace
        while (d > 0 && a.route.length) {
          const p = a.route[0]
          const dx = p.x - a.x
          const dy = p.y - a.y
          const L = Math.hypot(dx, dy)
          if (L <= d) { a.x = p.x; a.y = p.y; a.route.shift(); d -= L }
          else { a.x += (dx / L) * d; a.y += (dy / L) * d; face(a, dx, dy); d = 0 }
        }
        if (!a.route.length) done()
        break
      }
      case 'doorOut': case 'doorIn': {                // through the front door: it opens, then the agent steps onto the doorstep (or off it)
        if (a.wait > 0) { a.wait -= dt; break }
        a.animT += dt
        a.tp += ((a.mode === 'doorOut' ? 1 : -1) * a.speed * 0.4 * dt) / (T.front - T.deep)
        const k = clamp01(a.tp)
        a.y = T.front + (T.deep - T.front) * k
        a.alpha = 1 - clamp01((k - 0.4) / 0.6)
        if (a.mode === 'doorOut' && a.tp >= 1) {      // gone
          a.said = null
          door.user = null; door.closeAt = clock + 0.35
          a.goingHome = false
          stayOutside(a, 0)
          if (a.leaving) a.gone = true
        } else if (a.mode === 'doorIn' && a.tp <= 0) { // inside
          a.y = T.front; a.alpha = 1; a.zone = LOUNGE
          door.user = null; door.closeAt = clock + 0.35
          a.plan = []; begin(a)
        }
        break
      }
      case 'home':                                    // outside the burrow
        if (a.wait > 0) { a.wait -= dt; break }
        if (a.awaySince === null && !door.user && !actors.some((o) => o.goingHome)) {   // available: walks in (once nobody is on the way out)
          door.user = a; a.mode = 'doorIn'; a.tp = 1; a.wait = 0.35; a.dir = 'down'; a.alpha = 0
          a.dx = Math.round(rnd(-3, 3)); a.x = T.cx + a.dx; a.y = T.deep
        }
        break
      case 'hopOn': case 'hopOff': {
        const hp = a.hop as NonNullable<Actor['hop']>
        const L = Math.hypot(hp.px - hp.x, hp.py - hp.y) || 1
        a.animT += dt
        a.hopT += ((a.mode === 'hopOn' ? 1 : -1) * 28 * dt) / L
        const k = clamp01(a.hopT)
        a.x = hp.x + (hp.px - hp.x) * k; a.y = hp.y + (hp.py - hp.y) * k
        if (a.mode === 'hopOn' && a.hopT >= 1) {
          const st = a.plan[0] as Extract<Step, { t: 'perch' }>
          a.mode = 'sit'; a.pose = st.pose; a.wait = st.dur
        } else if (a.mode === 'hopOff' && a.hopT <= 0) { a.hop = null; done() }
        break
      }
      case 'sit':
        a.wait -= dt
        if (a.wait <= 0) {
          const hp = a.hop as NonNullable<Actor['hop']>
          a.pose = null; a.mode = 'hopOff'
          a.dir = Math.abs(hp.x - hp.px) > Math.abs(hp.y - hp.py) ? (hp.x > hp.px ? 'right' : 'left') : (hp.y > hp.py ? 'down' : 'up')
        }
        break
    }
  }

  // ---------------- ambience: fire flicker ----------------
  const ambience = { fireFrame: 0, fireT: 0, fireGlow: 0.8, fireTarget: 0.8 }
  function stepAmbience(dt: number): void {
    ambience.fireT -= dt
    if (ambience.fireT <= 0) {
      ambience.fireT = rnd(0.09, 0.17)
      ambience.fireFrame = (ambience.fireFrame + 1 + Math.floor(rng() * 2)) % 3
      ambience.fireTarget = rnd(0.55, 1)
    }
    ambience.fireGlow += (ambience.fireTarget - ambience.fireGlow) * Math.min(1, dt * 14)
  }

  function update(dt: number): { removed: string[] } {
    clock += dt
    for (const a of actors) tick(a, dt)
    const removed: string[] = []
    for (let i = actors.length - 1; i >= 0; i--) {
      if (actors[i].gone) { releasePoi(actors[i]); removed.push(actors[i].key); index.delete(actors[i].key); actors.splice(i, 1) }
    }
    stepAmbience(dt)
    return { removed }
  }

  /**
   * Moves the scene `seconds` ahead at once (reduced motion: the resting state, no animation). The bubbles keep their
   * remaining time: they are not used up by a jump of the clock.
   */
  /**
   * A new language: the mats are laid again, and so are the cells and posts that depend on them. Actors and jobs stay;
   * one that stops (or is walking to stop) on a spot a new title covers, or that holds a post beside the door (posts
   * are laid again), decides again now: a held posture or a resting agent has no next goal to wait for.
   */
  function setTitles(titles: Readonly<Record<string, string>>): void {
    layTitles(titles)
    for (const a of actors) {
      if (outside(a) || a.leaving || a.goingHome) continue
      const step = a.plan[0]
      const goal = a.mode === 'walk' && step?.t === 'walk' ? step : a
      if (a.post !== null || ((a.mode === 'idle' || a.mode === 'walk') && hidesTitle(goal.x, goal.y))) replan(a)
    }
  }

  function fastForward(seconds: number): void {
    // the time left of each bubble is read before the jump: update() would end a timed one on its way
    const left = new Map(actors.filter((a) => a.said !== null).map((a) => [a, { said: a.said, left: a.sayUntil - clock }] as const))
    for (let t = 0; t < seconds; t += 0.1) update(0.1)
    for (const [a, b] of left) if (actors.includes(a)) { a.said = b.said; a.sayUntil = clock + b.left }
  }

  /** The agent whose sprite covers the point (scene pixels), nearest in front first */
  function actorAt(x: number, y: number): BurrowActor | null {
    let best: Actor | null = null
    for (const a of actors) {
      if (a.mode === 'home') continue
      const tall = (a.pose && a.meta.poses[a.pose]?.h) || a.meta.h
      const half = Math.max(8, Math.round(a.meta.cell / 4))
      if (Math.abs(x - a.x) <= half && y <= a.y + 4 && y >= a.y - tall && (!best || a.y > best.y)) best = a
    }
    return best
  }

  return {
    actors: actors as ReadonlyArray<BurrowActor>,
    mats,
    setTitles,
    door,
    ambience,
    get clock() { return clock },
    doorIsOpen,
    addActor, removeActor, assign, release, setAvailable, setResting, setPosture, say,
    update, fastForward, zoneOf, actorAt,
    /** Room an agent is assigned to now (null = not working) */
    jobOf: (key: string): BurrowWorkshopId | null => byKey(key)?.job?.room ?? null,
    /** True while the agent rests as finished */
    isResting: (key: string): boolean => byKey(key)?.resting === true,
    /** True when the agent is not in the burrow (outside, or on its way out) */
    /** Walks out for good, or is outside: it holds no place in the burrow */
    isGone: (key: string): boolean => { const a = byKey(key); return !a || a.leaving || outside(a) },
    isOutside: (key: string): boolean => { const a = byKey(key); return !a || outside(a) },
    has: (key: string): boolean => byKey(key) !== undefined,
  }
}

export type BurrowEngine = ReturnType<typeof createBurrowEngine>
