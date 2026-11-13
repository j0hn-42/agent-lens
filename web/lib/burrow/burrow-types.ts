/** Types of the burrow scene: the picture data (burrow-data.ts) and the vocabulary the engine and the view share. */

export type BurrowDir = 'up' | 'down' | 'left' | 'right'

/**
 * The lounge is where an agent that works nowhere rests; the four others are workshops. 'door' is not a room of the
 * picture but a post: beside the front door, where an agent stands while it delegates (it sends a sub-agent out).
 */
export type BurrowRoomId = 'lounge' | 'office' | 'library' | 'workshop' | 'lab' | 'door'
export type BurrowWorkshopId = Exclude<BurrowRoomId, 'lounge'>

export interface BurrowPoi {
  id: string
  room: BurrowRoomId
  x: number
  y: number
  face: BurrowDir
  perch: { x: number; y: number; pose: string; nap?: boolean } | null
}

export interface BurrowMap {
  w: number
  h: number
  cell: number
  gw: number
  gh: number
  /** One string per row of cells, '1' = walkable */
  grid: string[]
  poi: BurrowPoi[]
  zones: Array<{ id: BurrowRoomId; x0: number; y0: number; x1: number; y1: number }>
  mats: Array<{ id: string; x: number; y: number }>
  door: { x: number; y: number; w: number; h: number; cx: number; front: number; deep: number; opening: [number, number, number, number] }
  fireRect: [number, number, number, number]
  lights: { fire: [number, number]; lanterns: Array<[number, number]>; mushrooms: Array<[number, number]>; furnace: [number, number] }
}

export interface BurrowSpriteMeta {
  cell: number
  anchor: [number, number]
  anims: Record<BurrowDir, { row: number; frames: number }>
  poses: Record<string, { row: number; col: number; h: number }>
  h: number
}

export interface BurrowFx {
  rects: Record<string, [number, number, number, number]>
  fire: [number, number]
  mat: {
    cap: number
    mid: number
    h: number
    pad: number
    textY: number
    inks: Record<string, { ink: string; shade: string }>
  }
}

export interface BurrowFont {
  cap: number
  spacing: number
  glyphs: Record<string, { w: number; t: number; r: number[] }>
}

export interface BurrowData {
  map: BurrowMap
  sprites: Record<string, BurrowSpriteMeta>
  fx: BurrowFx
  font: BurrowFont
}

/** The nine animals, in the order of the sprite sheets: one is picked for an agent from its key (see burrow-model) */
export const BURROW_ANIMALS = [
  { sprite: 'squirrel', speed: 36 },
  { sprite: 'hedgehog', speed: 30 },
  { sprite: 'otter', speed: 33 },
  { sprite: 'frog', speed: 31 },
  { sprite: 'fox', speed: 37 },
  { sprite: 'woodpecker', speed: 32 },
  { sprite: 'beetle', speed: 27 },
  { sprite: 'hare', speed: 40 },
  { sprite: 'raccoon', speed: 34 },
] as const
export type BurrowAnimal = (typeof BURROW_ANIMALS)[number]['sprite']
