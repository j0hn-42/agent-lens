/**
 * The place of an agent in error: a fixed row in the open floor of the lounge, under the rug and above the lounge's
 * title, in the middle of the picture, so an agent in error is spotted at a glance. An idle animal walks over it but
 * never stops there: an animal standing there is an agent in error. Scene pixels of the 560 x 315 picture (burrow-data).
 */
export const BURROW_ERROR_PLACE = {
  /** Where an agent in error stands, middle first, facing the viewer */
  spots: [
    { x: 280, y: 228 },
    { x: 262, y: 228 },
    { x: 298, y: 228 },
    { x: 271, y: 240 },
    { x: 289, y: 240 },
    { x: 244, y: 228 },
    { x: 316, y: 228 },
  ] as const,
  /** Floor kept for them [x0, y0, x1, y1) */
  reserved: [240, 210, 320, 246] as const,
}
