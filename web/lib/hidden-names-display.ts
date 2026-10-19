/**
 * What the "N names hidden" button of the canvas controls shows (#594), from the readings of the overlay plan's count
 * (planOverlays().hiddenAgentNames, read every 200 ms).
 *
 * - The button appears or goes only once the reading stayed the same for HIDDEN_NAMES_STABLE_MS with the camera at
 *   rest: a fit from under 35 % (a transient count of 1) or a zoom does not make it blink.
 * - A number is shown only when it is the latest reading. While the reading differs from it (not yet stable), the
 *   button keeps its place with the neutral label (`count: null`, no number): never a stale or unproven number.
 * - The button stays while it has the keyboard focus (neutral label when no name is hidden), so the focus is not lost.
 */
export const HIDDEN_NAMES_STABLE_MS = 500

export interface HiddenNamesDisplay {
  /** The button is drawn */
  shown: boolean
  /** The number on the button, the latest reading; null = the neutral label */
  count: number | null
}

export interface HiddenNamesState extends HiddenNamesDisplay {
  /** Latest reading, and since when it has had that value */
  candidate: number
  since: number
}

export const HIDDEN_NAMES_INITIAL: HiddenNamesState = { candidate: 0, since: Number.NEGATIVE_INFINITY, shown: false, count: null }

export const NO_HIDDEN_NAMES: HiddenNamesDisplay = { shown: false, count: null }

export function stepHiddenNames(
  prev: HiddenNamesState,
  { raw, now, cameraBusy, focused }: { raw: number; now: number; cameraBusy: boolean; focused: boolean },
): HiddenNamesState {
  const since = raw === prev.candidate ? prev.since : now
  const settled = !cameraBusy && now - since >= HIDDEN_NAMES_STABLE_MS
  const shown = settled ? raw > 0 || (prev.shown && focused) : prev.shown
  const count = shown && raw > 0 && (settled || raw === prev.count) ? raw : null
  return { candidate: raw, since, shown, count }
}
