/**
 * Burrow view: the idle squirrel's pastimes, the owner's explicit exception to "nothing is invented". In the lounge the
 * squirrel of an idle agent may read, have tea, stretch, sweep, poke the fire or polish an acorn, a few seconds each:
 * it only means the agent is idle, never a task, and it says nothing (the source's muttering lines are dropped).
 * Table of Agents' Burrow (scene/src/engine.js PASTIMES and FLOOR): poses, durations and weights kept. The engine plays
 * them (burrow-engine, an 'act' step), only while the scene moves.
 */
import type { Seq } from './burrow-acts'
import type { BurrowDir, BurrowSpriteMeta } from './burrow-types'

export interface BurrowPastime {
  id: string
  /** Where: 'floor' = any free spot of PASTIME_FLOOR, else these lounge spots (POI ids) */
  spots: 'floor' | readonly string[]
  /** Which way it faces while it plays (default down, towards you) */
  face?: BurrowDir
  /** Its poses, looped until the duration runs out */
  seq: Seq
  /** Seconds, [min, max] */
  dur: readonly [number, number]
  /** Weight of the draw */
  weight: number
}

export const BURROW_PASTIMES: readonly BurrowPastime[] = [
  { id: 'read', spots: 'floor', seq: [['readA', 2.6], ['readB', 0.5]], dur: [10, 16], weight: 3 },
  { id: 'tea', spots: ['tea'], seq: [['teaA', 1.6], ['teaB', 1.3]], dur: [8, 12], weight: 2 },
  { id: 'stretch', spots: 'floor', seq: [['stretchA', 1.5], ['stretchB', 1.0], ['stretchC', 1.7]], dur: [4.2, 4.2], weight: 1 },
  { id: 'sweep', spots: 'floor', seq: [['sweepA', 1.1], ['sweepB', 1.1]], dur: [7, 11], weight: 2 },
  { id: 'poke', spots: ['fire-1'], face: 'right', seq: [['pokeA', 0.7], ['pokeB', 0.45]], dur: [6, 10], weight: 2 },
  { id: 'acorn', spots: 'floor', seq: [['acornA', 2.2], ['acornB', 1.2]], dur: [6, 9], weight: 2 },
]

/**
 * The open floor of the lounge where a 'floor' pastime may be played. The engine still drops a spot kept for a place of
 * its own (the telephone's callers, the place of errors) or one that would hide a room title.
 */
export const PASTIME_FLOOR: readonly string[] = ['rug-left', 'rug-right', 'south-left', 'south-right', 'middle-left', 'middle', 'middle-right', 'bottom-left', 'bottom-right']

/** Only a drawing with these poses plays pastimes: the squirrel today */
export const hasPastimes = (meta: Pick<BurrowSpriteMeta, 'poses'>): boolean => !!(meta.poses.readA && meta.poses.sweepA)
