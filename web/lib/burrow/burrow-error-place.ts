/**
 * The place of an agent in error: a fixed row in the open floor of the lounge, under the rug and above the lounge's
 * title, in the middle of the picture, so an agent in error is spotted at a glance. An idle animal walks over it but
 * never stops there: an animal standing there is an agent in error. Scene pixels of the 560 x 315 picture (burrow-data).
 */
export const BURROW_ERROR_PLACE = {
  /** Where an agent in error stands, middle first, facing the viewer */
  spots: [
    { x: 280, y: 228 },
    { x: 258, y: 228 },
    { x: 302, y: 228 },
    { x: 269, y: 241 },
    { x: 291, y: 241 },
    { x: 236, y: 228 },
    { x: 324, y: 228 },
  ] as const,
  /** Floor kept for them [x0, y0, x1, y1) */
  reserved: [232, 210, 328, 246] as const,
}
