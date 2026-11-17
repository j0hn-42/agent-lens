/**
 * Burrow view: the squirrel's close-up at the glass of your screen, for the agent with the squirrel that waits for you
 * longest. Pure: no DOM, no engine clock. Ported from Agents' Burrow.
 * Where it may stand (glassPlace): on the bottom edge of the picture, or on the top edge of what covers the bottom (the
 * timeline, the control bar), in a gap of that edge between two room titles, never behind a panel, the burrow's own
 * controls or any other cover, never over a title mat or a post. It is canvas, under every HTML element: standing only
 * where nothing covers it, it hides no panel or control and no panel hides it.
 * What it does (glassFrame): 8 s wondering at its post (as any agent that waits for you), then visits to the glass, each
 * after a scene at its post, five of them up to a crack and a piece of tape, then calm visits. The crack and the tape
 * only count the time waited (from when the burrow first saw it waiting): nothing is broken, no line is said. Every
 * frame is a pure function of that time, so the still scene of reduced motion and Freeze motion shows the same trace.
 * Changed from the source: two knocks are at least 0.5 s apart (two bursts a second at most), no jolt, no blinking, no
 * "!" of an idea (it shows "?": "!" means a failure), no lines.
 */
import type { BurrowMat } from './burrow-engine'
import { needsYouFrame, poseOr, type BurrowActFrame, type Seq } from './burrow-acts'
import type { BurrowFx, BurrowSpriteMeta } from './burrow-types'

/** The picture's size in scene px (burrow-data's map) */
const W = 560
const H = 315
/** The close-up's cell is 112 px wide: half of it either side of its centre */
const HALF = 56
/** Height of the band it takes over its base (the tallest close-up, 74 px, and a little room) */
const BAND_H = 80
/** Height of the floor kept free under it: the band and its big "?" above the close-up (10 px over its head, bobbing) */
const KEPT_H = 88
/**
 * The narrowest gap: all the close-up's poses together span 98 px of its cell, and their outermost columns (a waving paw,
 * the acorn) may reach a pixel into the margins below
 */
const MIN_GAP = 96
/** The opaque columns of all the close-up's poses together, from its centre: [-45, 53] (squirrel.glass x0..x1): its middle is 4 px right of the centre */
const OPAQUE_MID = 4
/** More of the bottom covered than this: it would rise into the lounge, there is no close-up */
const MAX_COVERED = 40
/** Margin kept around a title mat, and around a post's feet (an animal there is about 20 px wide) */
const MAT_MARGIN = 4
const POST_MARGIN = 10

/**
 * Where the close-up stands, in scene px: its centre on the bottom edge (cx), that edge (base), and the ends of the free
 * gap it stands in (left, right), which what it leaves on the glass keeps to
 */
export interface GlassPlace { cx: number; base: number; left: number; right: number }

/**
 * The place of the close-up for an agent at `agentX`, or null when no gap of the bottom edge is free. `coveredBottom`,
 * `coveredLeft`, `coveredRight`: scene px of the picture the panels, the top bar and the timeline cover at each edge
 * (the graph's overlay insets); `covers`: other rectangles over the picture (the burrow's controls column, the
 * collapsed Conversation pill), in scene px; `mats`: the woven room titles; `posts`: the feet of every post (front
 * door, telephone, place of errors). Among the free gaps of its band at least MIN_GAP wide, the one nearest the agent,
 * the opaque part of the close-up centred on it.
 */
export function glassPlace(o: {
  agentX: number
  mats: readonly BurrowMat[]
  posts: ReadonlyArray<{ x: number; y: number }>
  covers: ReadonlyArray<{ x0: number; x1: number; y0: number; y1: number }>
  coveredBottom: number
  coveredLeft: number
  coveredRight: number
}): GlassPlace | null {
  const covered = Math.max(0, o.coveredBottom || 0)
  if (covered > MAX_COVERED) return null
  const base = Math.round(H - covered)
  const top = base - BAND_H
  const blocked: Array<[number, number]> = []
  for (const c of o.covers) if (c.y0 < base && c.y1 > top) blocked.push([c.x0, c.x1])
  for (const m of o.mats) if (m.y - MAT_MARGIN < base && m.y + m.h + MAT_MARGIN > top) blocked.push([m.x - MAT_MARGIN, m.x + m.w + MAT_MARGIN])
  for (const p of o.posts) if (p.y >= top && p.y <= base) blocked.push([p.x - POST_MARGIN, p.x + POST_MARGIN])
  blocked.sort((a, b) => a[0] - b[0])
  // the free gaps of the edge, left to right
  const gaps: Array<[number, number]> = []
  let x = Math.max(0, o.coveredLeft || 0)
  const end = W - Math.max(0, o.coveredRight || 0)
  for (const [b0, b1] of blocked) {
    if (b0 > x) gaps.push([x, Math.min(b0, end)])
    x = Math.max(x, b1)
    if (x >= end) break
  }
  if (x < end) gaps.push([x, end])
  let best: [number, number] | null = null
  let bestD = Number.POSITIVE_INFINITY
  for (const g of gaps) {
    if (g[1] - g[0] < MIN_GAP) continue
    const d = o.agentX < g[0] ? g[0] - o.agentX : o.agentX > g[1] ? o.agentX - g[1] : 0
    if (d < bestD) { best = g; bestD = d }
  }
  return best ? { cx: Math.round((best[0] + best[1]) / 2 - OPAQUE_MID), base, left: best[0], right: best[1] } : null
}

/**
 * The floor the close-up and its big "?" stand over, [x0, y0, x1, y1) in scene px: kept free while it may show
 * (engine.setGlassBand), so no animal stops behind them
 */
export function glassBand(place: GlassPlace): readonly [number, number, number, number] {
  return [place.cx - HALF, place.base - KEPT_H, place.cx + HALF, place.base]
}

// ---------------- the timeline ----------------

/** Seconds it only wonders at its post before its first visit */
const WONDER_S = 8
/** A knock is held this long; the gap before it is at least KNOCK_GAP: two knocks are at least 0.5 s apart */
const KN = 0.16
const KNOCK_GAP = 0.34
const series = (n: number, up: string, down: string, gap: number): Seq =>
  Array.from({ length: n }, () => [[up, Math.max(gap, KNOCK_GAP)], [down, KN, 'hit']] as const).flat()
const waves = (n: number): Seq => Array.from({ length: n }, () => [['waveA', 0.3], ['waveB', 0.3]] as const).flat()
/** It taps its foot, arms crossed */
const tapping = (seconds: number): Seq => Array.from({ length: Math.ceil(seconds / 0.5) }, () => [['crossA', 0.34], ['crossB', 0.16]] as const).flat()
const wondering = (n: number): Seq => Array.from({ length: n }, () => [['think', 2.6], ['front', 0.8]] as const).flat()
/** It looks for something in its satchel: it digs, things fly out, it looks up, digs again */
const SEARCH: Seq = [['rummage', 1.6], ['rummage', 1.2, 'toss'], ['rummage', 0.9, 'toss'], ['front', 0.8], ['rummage', 1.4], ['rummage', 1.1, 'toss'],
  ['rummage', 1.0, 'toss'], ['front', 0.7], ['rummage', 1.5], ['rummage', 1.3, 'toss'], ['rummage', 1.2]]
const SORRY = ['shrug', 1.7, 'sorry'] as const

/**
 * Its visits to the glass, one per cycle (the sixth and later repeat the last): cues 'hit' a knock, 'thud' a hard one,
 * 'crack' the knock that marks the glass, 'sorry' a drop of sweat, 'mist' its breath, 'doodle' a "?" wiped in it,
 * 'tape' the patch, 'pat' a gentle press. 1) polite, 2) insistent: a crack, 3) with its acorn: it grows, 4) the big one:
 * it spreads, 5) sorry: the tape, 6 and on) a calm wait.
 */
const VISITS: readonly Seq[] = [
  [['ready', 0.5], ...series(3, 'ready', 'knock', 0.24), ['ready', 1.4], ['squish', 1.6], ['ready', 0.5], ['shrug', 1.2], ['ready', 0.4],
    ...series(3, 'ready', 'knock', 0.24), ['ready', 1.2], ...waves(4), ['ready', 0.9], ['breath', 1.8, 'mist'], ['finger', 2.2, 'doodle'], ['rest', 4.2], ['shrug', 1.4]],
  [['ready', 0.4], ...series(3, 'ready', 'knock', 0.2), ['ready', 1.2], ['squish', 1.6], ['ready', 0.4], ...series(4, 'ready', 'knock', 0.15),
    ['ready', 1.0], ['shrug', 1.1], ['ready', 0.4], ...series(5, 'ready', 'knock', 0.13), ['ready', 0.9], ...waves(2), ['ready', 0.4],
    ...series(4, 'ready', 'knock', 0.12), ['ready', 1.0], ['squish', 1.4], ['ready', 0.4], ...series(3, 'ready', 'knock', 0.11),
    ['ready', KNOCK_GAP], ['knock', 1.0, 'crack'], SORRY],
  [['acornUp', 0.7], ...series(3, 'acornUp', 'acornHit', 0.3), ['acornUp', 1.6], ...series(4, 'acornUp', 'acornHit', 0.24), ['acornUp', 1.2],
    ...series(3, 'acornUp', 'acornHit', 0.22), ['acornUp', 1.0], ...series(2, 'acornUp', 'acornHit', 0.2), ['acornUp', KNOCK_GAP], ['acornHit', 1.0, 'crack'], SORRY],
  [['ready', 0.7], ['knock', 0.3, 'thud'], ['ready', 0.9], ['knock', 0.3, 'thud'], ['ready', 1.1], ['knock', 0.6, 'crack'], ['shock', 1.6], ['shrug', 1.8, 'sorry']],
  [['ready', 0.6], ['knock', 1.1, 'tape'], ['ready', 0.4], ['knock', 0.3, 'pat'], ['ready', 0.3], ['knock', 0.3, 'pat'], ['ready', 1.4],
    ['rest', 6.0], ['shrug', 1.2], ['rest', 4.0], ...waves(2), ['rest', 3.0]],
  [['rest', 5.0], ['shrug', 1.2], ['rest', 4.0], ...waves(2), ['rest', 4.0]],
]
/**
 * Its scene at its post before each visit from the second on ('toss': something flies out of its satchel, 'puff': dust
 * under its feet); the fourth ends with a run-up, and its trip to the glass is a dash
 */
const INDOORS: readonly Seq[] = [
  [],
  [...tapping(13), ...wondering(1), ['crossA', 0.34], ['crossB', 0.16], ...tapping(12), ['front', 0.8]],
  [...wondering(2), ['think', 2.6], ['gasp', 1.1], ...SEARCH, ['rummage', 1.0, 'toss'], ['rummage', 1.2], ['acornB', 2.2], ['front', 0.5]],
  [...tapping(11), ...wondering(1), ['crossA', 0.34], ['crossB', 0.16], ...tapping(9), ['windup', 0.8, 'puff'], ['windup', 0.8, 'puff'], ['windup', 0.8, 'puff']],
  [['front', 1.0], ...wondering(2), ['think', 2.6], ['front', 0.8], ['gasp', 1.0], ...SEARCH.slice(0, 7), ['rummage', 1.2], ['gasp', 1.6], ['front', 0.4]],
  wondering(6),
]
const DASH_CYCLE = 4
/** Its trip from its post to the glass, the rise of the close-up and how long it peeks before its act, and the drop after */
const TO_GLASS_S = 0.3
const DASH_TO_GLASS_S = 0.18
const PEEK_S = 1.25
const DASH_PEEK_S = 0.3
const RISE_S = 0.35
const DASH_RISE_S = 0.14
const DROP_S = 0.3

type Part = 'wonder' | 'room' | 'toGlass' | 'peek' | 'act' | 'drop'
interface Step { t0: number; t1: number; part: Part; pose: string; cue?: string; rise?: number }

/** Every step from the start of the wait to the end of the sixth visit; from the sixth cycle on it repeats every PERIOD */
const STEPS: Step[] = []
let LOOP_FROM = 0
{
  let t = WONDER_S
  STEPS.push({ t0: 0, t1: t, part: 'wonder', pose: 'think' })
  const add = (part: Part, seq: Seq): void => {
    for (const [pose, d, cue] of seq) { STEPS.push({ t0: t, t1: t + d, part, pose, cue }); t += d }
  }
  for (let c = 1; c <= VISITS.length; c++) {
    if (c === VISITS.length) LOOP_FROM = t
    add('room', INDOORS[c - 1])
    const dash = c === DASH_CYCLE
    add('toGlass', [['front', dash ? DASH_TO_GLASS_S : TO_GLASS_S]])
    STEPS.push({ t0: t, t1: t + (dash ? DASH_PEEK_S : PEEK_S), part: 'peek', pose: 'peek', rise: dash ? DASH_RISE_S : RISE_S })
    t += dash ? DASH_PEEK_S : PEEK_S
    add('act', VISITS[c - 1])
    add('drop', [[VISITS[c - 1][VISITS[c - 1].length - 1][0], DROP_S]])
  }
}
const END = STEPS[STEPS.length - 1].t1
const PERIOD = END - LOOP_FROM
/** Every cue, when it fires (the start of its step); a toss also has its rank among the tosses */
const CUES: ReadonlyArray<{ t: number; name: string; part: Part; rank: number }> = (() => {
  const out: Array<{ t: number; name: string; part: Part; rank: number }> = []
  let tosses = 0
  for (const s of STEPS) for (const name of s.cue?.split('+') ?? []) out.push({ t: s.t0, name, part: s.part, rank: name === 'toss' ? tosses++ : 0 })
  return out
})()
/** The same instant in the first period, from the sixth cycle on (no cue fires there: the trace is complete by then) */
const folded = (e: number): number => (e < END ? e : LOOP_FROM + ((e - LOOP_FROM) % PERIOD))
function stepAt(e: number): Step {
  let lo = 0
  let hi = STEPS.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (STEPS[mid].t0 <= e) lo = mid
    else hi = mid - 1
  }
  return STEPS[lo]
}
/** The last cue named one of `names` at or before e, and how long ago */
function lastCue(e: number, names: ReadonlySet<string>): { t: number; name: string; age: number } | null {
  for (let i = CUES.length - 1; i >= 0; i--) if (CUES[i].t <= e && names.has(CUES[i].name)) return { t: CUES[i].t, name: CUES[i].name, age: e - CUES[i].t }
  return null
}
const KNOCKS: ReadonlySet<string> = new Set(['hit', 'thud', 'crack'])
const ONE = (name: string): ReadonlySet<string> => new Set([name])

// ---------------- frames ----------------

/** Something it leaves on the glass, centred on (cx + dx, base + dy); `pin`: on the crack's point, or its mouth's */
interface GlassMark { name: string; dx: number; dy: number; alpha: number; pin?: 'crack' | 'mouth' }
export interface GlassFrame {
  /** The squirrel at its post: its act (burrow-acts), drawn by the engine like any act */
  room: BurrowActFrame
  /** The close-up: its pose (squirrel.glass) and how far it has risen (0..1); null while it is at its post */
  bust: { pose: string; up: number } | null
  marks: readonly GlassMark[]
  /** The big "?" beside the close-up, once it is fully up */
  bigSign: boolean
  /** How far the crack has grown (0: no crack), and whether the tape is on it */
  pane: 0 | 1 | 2 | 3
  taped: boolean
}

/** Where its fist meets the glass, from the bottom of the close-up (the crack is made, and later knocks land, there) */
const FIST: readonly [number, number] = [-26, -25]
/** Where its breath mists the glass */
const MOUTH: readonly [number, number] = [42, -47]
const BURST_S = { hit: 0.13, thud: 0.22, crack: 0.22 } as const
const MIST_FULL_S = 7.8
const MIST_S = 9.2
const SWEAT_S = 1.7
const PUFF_S = 0.55
/** A thing from the satchel: thrown up and sideways (by its rank), falls 3 px below its start, lies there, then fades */
const TOSS_VX = [-32, -24, 28, -40, -20] as const
const TOSS_VY = -110
const TOSS_G = 330
const TOSS_FALL = 3
const TOSS_AIR = (-TOSS_VY + Math.sqrt(TOSS_VY * TOSS_VY + 2 * TOSS_G * TOSS_FALL)) / TOSS_G
const TOSS_FULL_S = 3.2
const TOSS_FADE_S = 1
const ITEMS = 5

const roomSign = (pose: string): BurrowActFrame['sign'] => (pose === 'crossA' || pose === 'crossB' ? 'dots' : pose === 'windup' ? null : 'ask')
const trace = (e: number): { pane: GlassFrame['pane']; taped: boolean } => {
  let pane = 0
  let taped = false
  for (const c of CUES) {
    if (c.t > e) break
    if (c.name === 'crack') pane = Math.min(3, pane + 1)
    if (c.name === 'tape' && pane > 0) taped = true
  }
  return { pane: pane as GlassFrame['pane'], taped }
}
const traceMarks = (pane: number, taped: boolean): GlassMark[] => [
  ...(pane > 0 ? [{ name: `w_bolt${pane}`, dx: FIST[0], dy: FIST[1], alpha: 1, pin: 'crack' as const }] : []),
  ...(taped ? [{ name: 'w_tape', dx: FIST[0], dy: FIST[1], alpha: 1, pin: 'crack' as const }] : []),
]

/**
 * What the squirrel of the agent that waits for you longest shows `elapsed` seconds after the burrow first saw it
 * waiting: at its post (`room`, its act) and at the glass (`bust`, `marks`, `bigSign`). `still` (reduced motion, Freeze
 * motion): the wonder for WONDER_S, then the close-up up, steady (ready, then rest once taped), with its big "?" and the
 * crack and tape reached, the squirrel at its post facing you; nothing that moves.
 */
export function glassFrame(o: { elapsed: number; still: boolean; meta: BurrowSpriteMeta; rects: BurrowFx['rects'] }): GlassFrame {
  const { meta, still, rects } = o
  const e = Math.max(0, o.elapsed)
  const { pane, taped } = trace(e)
  if (e < WONDER_S) {
    const wonder = needsYouFrame({ elapsed: e, still, meta, bursts: false })
    return { room: { pose: wonder.pose, sign: wonder.sign, fx: wonder.fx }, bust: null, marks: [], bigSign: false, pane, taped }
  }
  const front = poseOr(meta, 'front')
  if (still) {
    return { room: { pose: front, sign: null, fx: [] }, bust: { pose: taped ? 'rest' : 'ready', up: 1 }, marks: traceMarks(pane, taped), bigSign: true, pane, taped }
  }
  const u = folded(e)
  const step = stepAt(u)
  const t = u - step.t0
  // at its post: things from its satchel, wherever they landed
  const fx: Array<{ name: string; dx: number; dy: number; alpha?: number }> = []
  for (const c of CUES) {
    if (c.name !== 'toss' || c.t > u || u - c.t >= TOSS_AIR + TOSS_FULL_S + TOSS_FADE_S) continue
    const age = u - c.t
    const fly = Math.min(age, TOSS_AIR)
    const name = `w_item${c.rank % ITEMS}`
    const h = rects[name]?.[3] ?? 0
    const y = -8 + TOSS_VY * fly + (TOSS_G * fly * fly) / 2
    const alpha = age > TOSS_AIR + TOSS_FULL_S ? Math.max(0, (TOSS_AIR + TOSS_FULL_S + TOSS_FADE_S - age) / TOSS_FADE_S) : 1
    fx.push({ name, dx: Math.round(9 + TOSS_VX[c.rank % TOSS_VX.length] * fly), dy: Math.round(y) - h + (h >> 1), alpha })
  }
  let room: BurrowActFrame
  if (step.part === 'room') {
    const puff = lastCue(u, ONE('puff'))
    if (puff && puff.age < PUFF_S) {                // two puffs of dust either side of its feet, drifting apart and up, fading
      const k = puff.age / PUFF_S
      const d = Math.round(5 * k)
      fx.push({ name: 'w_puff', dx: -11 - d, dy: -7 - d, alpha: 1 - k }, { name: 'w_puff', dx: 11 + d, dy: -7 - d, alpha: 1 - k })
    }
    room = { pose: poseOr(meta, step.pose), sign: roomSign(step.pose), fx, ...(step.pose === 'rummage' ? { oy: Math.floor(u * 8) % 2 } : {}) }
  } else room = { pose: front, sign: null, fx }
  const bust = step.part === 'peek' ? { pose: 'peek', up: Math.min(1, t / (step.rise ?? RISE_S)) }
    : step.part === 'act' ? { pose: step.pose, up: 1 }
      : step.part === 'drop' ? { pose: step.pose, up: Math.max(0, 1 - t / DROP_S) }
        : null
  const marks: GlassMark[] = []
  const mist = lastCue(u, ONE('mist'))
  if (mist && mist.age < MIST_S) {
    const doodle = lastCue(u, ONE('doodle'))
    const wiped = doodle !== null && doodle.t > mist.t && doodle.t < mist.t + MIST_FULL_S
    marks.push({ name: wiped ? 'w_mistQ' : 'w_mist', dx: MOUTH[0], dy: MOUTH[1], alpha: mist.age < MIST_FULL_S ? 1 : (MIST_S - mist.age) / (MIST_S - MIST_FULL_S), pin: 'mouth' })
  }
  marks.push(...traceMarks(pane, taped))
  const knock = bust ? lastCue(u, KNOCKS) : null
  if (knock && knock.age < BURST_S[knock.name as keyof typeof BURST_S]) marks.push({ name: 'w_hitL', dx: FIST[0], dy: FIST[1], alpha: 1, pin: 'crack' })
  const sorry = lastCue(u, ONE('sorry'))
  const glass = meta.glass?.poses[bust?.pose ?? '']
  if (bust && bust.up >= 1 && glass && sorry && sorry.age < SWEAT_S) {   // a drop of sweat runs down, twice
    marks.push({ name: 'w_drop', dx: -27, dy: -glass.h + 20 + Math.round((sorry.age % 0.85) * 9), alpha: 1 })
  }
  return { room, bust, marks, bigSign: bust !== null && bust.up >= 1, pane, taped }
}

/**
 * What to draw of a frame at its place, in scene px: the cell of the close-up (from `<sprite>-glass.png`), then its big
 * "?" (bobbing a pixel with motion: `clock` only moves it) and its marks, top-left corners. The crack, its tape and the
 * bursts share one point, kept inside the gap with the biggest crack; the breath too stays in the gap.
 */
export function glassDrawList(place: GlassPlace, frame: GlassFrame, meta: BurrowSpriteMeta, rects: BurrowFx['rects'], clock: number, still: boolean): {
  bust: { sx: number; sy: number; w: number; h: number; x: number; y: number } | null
  items: Array<{ name: string; x: number; y: number; alpha: number }>
} {
  const G = meta.glass
  const pose = frame.bust && G?.poses[frame.bust.pose]
  if (!frame.bust || !G || !pose) return { bust: null, items: [] }
  const [cw, ch] = G.cell
  const { cx, base } = place
  const bust = { sx: pose.col * cw, sy: 0, w: cw, h: ch, x: cx - (cw >> 1), y: base - ch + Math.round((1 - frame.bust.up) * pose.h) }
  const items: Array<{ name: string; x: number; y: number; alpha: number }> = []
  if (frame.bigSign) {
    const r = rects.w_askL
    const bob = still ? 0 : Math.round(Math.sin(clock * 5) * 1.4)
    if (r) items.push({ name: 'w_askL', x: Math.min(W - r[2] - 2, cx + 24), y: base - pose.h - 10 + bob, alpha: 1 })
  }
  const crackHalf = (rects.w_bolt3?.[2] ?? 0) >> 1
  const crackX = Math.max(place.left + crackHalf, Math.min(place.right - crackHalf, cx + FIST[0]))
  for (const m of frame.marks) {
    const r = rects[m.name]
    if (!r) continue
    let x = cx + m.dx
    if (m.pin === 'crack') x = crackX
    else if (m.pin === 'mouth') x = Math.min(x, place.right - (r[2] - (r[2] >> 1)), W - 28)
    items.push({ name: m.name, x: x - (r[2] >> 1), y: base + m.dy - (r[3] >> 1), alpha: Math.max(0, Math.min(1, m.alpha)) })
  }
  return { bust, items }
}

/** True when the scene point (x, y) is on the opaque part of the close-up (it selects its agent, like its animal) */
export function glassHit(place: GlassPlace, frame: GlassFrame, meta: BurrowSpriteMeta, x: number, y: number): boolean {
  const pose = frame.bust && meta.glass?.poses[frame.bust.pose]
  if (!frame.bust || !pose || !meta.glass) return false
  const left = place.cx - (meta.glass.cell[0] >> 1)
  return x >= left + pose.x0 && x <= left + pose.x1 && y >= place.base - Math.round(frame.bust.up * pose.h) && y <= place.base
}
