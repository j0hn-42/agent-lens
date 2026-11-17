/**
 * Burrow view: acts, what an animal shows over its plain posture for a state it is observed in (an agent that waits for
 * you...). The view decides an act from the observed state and the wall clock, and hands it to the engine (setAct), which
 * shows it only while the animal stands. Pure: no DOM, no engine clock (it jumps under reduced motion), so the still
 * scene shows the same stage as the moving one.
 * The waiting poses come from Agents' Burrow: only the squirrel has drawings of its own (think, front, knockA, crossA...);
 * the other animals use what they have (their wave, else their standing frame).
 */
import type { BurrowFx, BurrowSpriteMeta } from './burrow-types'

/** A sign over the head, one meaning each: "?" waits for you, "..." still waits for you (it sulks), "!" a failure */
export type BurrowSign = 'ask' | 'dots' | 'alert'
const SIGN_FX: Readonly<Record<BurrowSign, string>> = { ask: 'w_ask', dots: 'w_dots', alert: 'w_alert' }
/**
 * Scene px by which the bubble of an animal with a sign is raised (the tallest sign, 13 px, and a 3 px gap): its state
 * bubble lasts as long as the state, it would hide the sign for ever
 */
export const SIGN_LIFT = 16

export interface BurrowActFrame {
  /** Pose drawn instead of the engine's: a pose the sheet has, null = standing frame of its direction, undefined = no override */
  pose?: string | null
  sign: BurrowSign | null
  /** Effects around the animal: fx rect, centre offset from its feet (scene px), alpha (default 1) */
  fx: ReadonlyArray<{ name: string; dx: number; dy: number; alpha?: number }>
  /** Bubble text while the act lasts, instead of the engine's */
  line?: string
  /** Sprite lifted by this many px */
  oy?: number
}

/** A sequence of poses: [pose, seconds, cue]; a cue fires when its step starts */
type Seq = ReadonlyArray<readonly [pose: string, seconds: number, cue?: string]>

/** Cues that draw a knock burst. Two of them are at least 0.5 s apart in every sequence: never more than two bursts a second (WCAG 2.3.1) */
const KNOCKS: ReadonlySet<string> = new Set(['hit', 'thud', 'crack'])
/** "Hey, over here!": three waves and a pause (an animal whose drawing has a wave) */
const WAVE_SEQ: Seq = [['wave', 0.45], ['front', 0.3], ['wave', 0.45], ['front', 0.3], ['wave', 0.45], ['front', 1.8]]
/**
 * The squirrel knocks three times on the air in front of it, looks at you, thinks. The source's gaps between two knocks
 * (0.22 s) are stretched so that two knocks are 0.5 s apart.
 */
const ROOM_SEQ: Seq = [['front', 0.34], ['knockA', 0.16, 'hit'], ['front', 0.34], ['knockA', 0.16, 'hit'], ['front', 0.34], ['knockA', 0.16, 'hit'], ['front', 1.0], ['think', 1.4]]
/** Arms crossed, a foot tapping */
const SULK_SEQ: Seq = [['crossA', 0.34], ['crossB', 0.16]]
/** It wonders, looking at you now and then */
const WONDER_SEQ: Seq = [['think', 2.6], ['front', 0.8]]

/** Seconds it only wonders before it calls */
const WONDER_S = 8
/** It calls for at least this long, and stops at the end of a round */
const CALL_MIN_S = 16
const SULK_S = 20
/** A knock burst lasts this long */
const BURST_S = 0.13
/** Where the fist meets the air, from the feet */
const FIST: readonly [number, number] = [-5, -13]

/** The pose if the drawing has it, else null (the standing frame of the animal's direction) */
function poseOr(meta: Pick<BurrowSpriteMeta, 'poses'>, name: string): string | null {
  return meta.poses[name] ? name : null
}
const length = (seq: Seq): number => seq.reduce((s, x) => s + x[1], 0)

/** The step of `seq` at `t` seconds (looped, or clamped to its end) */
function seqAt(seq: Seq, t: number, loop: boolean): { i: number; pose: string } {
  const L = length(seq)
  const u = loop ? ((t % L) + L) % L : Math.min(Math.max(t, 0), L)
  let start = 0
  for (let i = 0; i < seq.length; i++) {
    if (u < start + seq[i][1] || i === seq.length - 1) return { i, pose: seq[i][0] }
    start += seq[i][1]
  }
  return { i: 0, pose: seq[0][0] }
}

/** Seconds since the last cue named in `cues` at or before t (from t = 0 on, looped), null when none yet */
function sinceCue(seq: Seq, t: number, cues: ReadonlySet<string>, loop: boolean): number | null {
  if (t < 0) return null
  const L = length(seq)
  const u = loop ? t % L : t
  let best: number | null = null
  let start = 0
  for (const [, d, cue] of seq) {
    if (cue && cue.split('+').some((c) => cues.has(c))) {
      let since = u - start
      if (since < 0) since = loop ? since + L : -1
      if (since >= 0 && since <= t && (best === null || since < best)) best = since
    }
    start += d
  }
  return best
}

/** How it calls: the squirrel knocks, an animal with a wave waves, another stands */
const callSeq = (meta: BurrowSpriteMeta): Seq | null => (meta.poses.knockA ? ROOM_SEQ : meta.poses.wave ? WAVE_SEQ : null)
/** Its call lasts whole rounds, until the first round that starts at or after CALL_MIN_S */
const callLength = (seq: Seq | null): number => (seq ? Math.ceil(CALL_MIN_S / length(seq) - 1e-9) * length(seq) : CALL_MIN_S)

/**
 * What an agent that waits for you shows, `elapsed` seconds after the burrow first saw it waiting: it wonders under "?"
 * (WONDER_S), then calls under "?" (waves; the squirrel knocks, with a burst at each knock when `bursts`), then sulks
 * under "..." (SULK_S), then calls again, as long as the wait lasts. `still` (reduced motion, Freeze motion): one frame
 * per stage, without bursts.
 */
export function needsYouFrame(o: { elapsed: number; still: boolean; meta: BurrowSpriteMeta; bursts: boolean }): BurrowActFrame & { stage: 'wonder' | 'call' | 'sulk' } {
  const { still, meta } = o
  const e = Math.max(0, o.elapsed)
  if (e < WONDER_S) return { stage: 'wonder', pose: poseOr(meta, still ? 'think' : seqAt(WONDER_SEQ, e, true).pose), sign: 'ask', fx: [] }
  const seq = callSeq(meta)
  const call = callLength(seq)
  const u = (e - WONDER_S) % (call + SULK_S)
  if (u < call) {
    if (!seq) return { stage: 'call', pose: null, sign: 'ask', fx: [] }
    if (still) return { stage: 'call', pose: poseOr(meta, seq === ROOM_SEQ ? 'knockA' : 'wave'), sign: 'ask', fx: [] }
    const since = o.bursts ? sinceCue(seq, u, KNOCKS, true) : null
    const fx = since !== null && since < BURST_S ? [{ name: 'w_hitS', dx: FIST[0], dy: FIST[1] }] : []
    return { stage: 'call', pose: poseOr(meta, seqAt(seq, u, true).pose), sign: 'ask', fx }
  }
  return { stage: 'sulk', pose: poseOr(meta, still ? 'crossA' : seqAt(SULK_SEQ, u - call, true).pose), sign: 'dots', fx: [] }
}

/**
 * The one agent whose knocks show their bursts: the waiting agent with the squirrel that has waited longest (ties by
 * key). Beyond nine agents the squirrel is shared: the others knock without bursts, so the scene never shows more than
 * two bursts a second. `waits`: since when each agent waits (burrow-sync); null when no squirrel waits.
 */
export function glassOwner(waits: ReadonlyMap<string, number>, metaOf: (key: string) => BurrowSpriteMeta | undefined): string | null {
  let best: string | null = null
  let bestAt = Number.POSITIVE_INFINITY
  for (const [key, at] of waits) {
    if (!metaOf(key)?.poses.knockA) continue
    if (at < bestAt || (at === bestAt && best !== null && key < best)) { best = key; bestAt = at }
  }
  return best
}

/**
 * What to draw of a shown act, top-left corners in scene px: its effects, centred on their offset from the feet, then
 * its sign centred over the head of the drawn pose, bobbing a pixel with motion (`clock` only moves it), still when `still`.
 */
export function actDrawList(
  a: { x: number; y: number; meta: BurrowSpriteMeta; pose?: string | null },
  frame: BurrowActFrame,
  rects: BurrowFx['rects'],
  clock: number,
  still: boolean,
): Array<{ name: string; x: number; y: number; alpha: number }> {
  const out: Array<{ name: string; x: number; y: number; alpha: number }> = []
  const x = Math.round(a.x)
  const y = Math.round(a.y)
  for (const f of frame.fx) {
    const r = rects[f.name]
    if (r) out.push({ name: f.name, x: x + f.dx - (r[2] >> 1), y: y + f.dy - (r[3] >> 1), alpha: f.alpha ?? 1 })
  }
  if (frame.sign) {
    const name = SIGN_FX[frame.sign]
    const r = rects[name]
    const pose = frame.pose !== undefined ? frame.pose : a.pose ?? null
    const tall = (pose && a.meta.poses[pose]?.h) || a.meta.h
    const top = y - (frame.oy ?? 0) - tall
    const bob = still ? 0 : Math.round(Math.sin(clock * 5) * 1.4)
    if (r) out.push({ name, x: x - (r[2] >> 1), y: top - r[3] - 3 + bob, alpha: 1 })
  }
  return out
}
