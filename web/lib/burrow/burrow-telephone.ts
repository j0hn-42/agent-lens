/**
 * The telephone of the burrow: an orchestrator that runs a dispatch tool (Agent, Task) stands there while the call
 * runs, and the sub-agent it sends walks in through the front door. A small side table with a red rotary telephone,
 * drawn as pixel art over the decor, at the left edge of the passage under the front door, against the root of the
 * workshop. Its callers stand on its right, facing it, off the doormat's title.
 * Scene pixels of the 560 x 315 picture (burrow-data).
 */

/** One letter per pixel, '.' = nothing drawn; the colours are those of the decor (the desks, the stools, the armchairs) */
const ROWS = [
  '.KKK.......KKK.',
  '.KkkKKKKKKKkkK.',
  '..KK.......KK..',
  '...hRRRRRRRr...',
  '..hRRRDDDRRRr..',
  '..RRRDdDdDRRr..',
  '.hRRRDDdDDRRRr.',
  '.RRRRDdDdDRRRr.',
  '.rRRRRDDDRRRrr.',
  '.rrrrrrrrrrrrr.',
  'WWWWWWWWWWWWWWW',
  'wwwwwwwwwwwwwww',
  'BBBBBBBBBBBBBBB',
  '.bB.........Bb.',
  '.bB.........Bb.',
  '.bb.........bb.',
] as const

const COLOURS: Readonly<Record<string, string>> = {
  K: '#2b1810', k: '#5a3a2a',                  // handset: near black, a warmer glint
  R: '#9c2f1d', r: '#5e1b10', h: '#c8553a',    // red body, its shade and its lit edge
  D: '#e9b775', d: '#7a4a0a',                  // the dial: the light wood of the desks, its finger holes
  W: '#c98a4b', w: '#a35722', B: '#613113', b: '#40200e',   // the table: top, edge, apron, legs (the stools' wood)
}

const X = 153
const Y = 125

export const BURROW_TELEPHONE = {
  /** Top-left corner of the drawing; its feet stand on the floor on its last row */
  x: X,
  y: Y,
  rows: ROWS,
  colours: COLOURS,
  /** Rows of the handset: they lift a pixel while the telephone rings */
  handsetRows: 3,
  /** Where the feet are (scene y): an animal lower than this is drawn in front of the telephone */
  base: Y + ROWS.length - 1,
  /** Centre of the drawing (scene x) */
  cx: X + (ROWS[0].length >> 1),
  /** The table and the telephone: nobody walks through them [x0, y0, x1, y1] (inclusive) */
  block: [152, 124, 167, 143] as const,
  /**
   * Where a caller stands, nearest first: on the right of the table, facing it, in the passage under the front door
   * (below the doormat, whose title an animal never hides)
   */
  posts: [
    { x: 176, y: 147 },
    { x: 190, y: 147 },
    { x: 204, y: 147 },
    { x: 183, y: 159 },
    { x: 197, y: 159 },
  ] as const,
  /** Floor kept for the callers: an idle animal does not stop there, so an animal at the telephone is a caller */
  reserved: [170, 142, 210, 166] as const,
}
