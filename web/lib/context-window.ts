import { MODEL_FAMILY_CONTEXT, DEFAULT_CONTEXT_SIZE, FALLBACK_CONTEXT_SIZE } from './canvas-constants'

const ONE_MILLION = 1_000_000
const KNOWN_SIZES = [DEFAULT_CONTEXT_SIZE, ONE_MILLION]

/** Context window assumed for a model id. `CLAUDE_CODE_DISABLE_1M_CONTEXT` caps every window to 200k;
 *  an explicit `[1m]` suffix on the id means 1M; otherwise the family table decides. */
export function contextWindowSize(modelId: string | undefined, disable1M: boolean): number {
  const cap = (size: number) => (disable1M ? Math.min(size, DEFAULT_CONTEXT_SIZE) : size)
  if (!modelId) return cap(FALLBACK_CONTEXT_SIZE)
  const id = modelId.toLowerCase()
  if (id.includes('[1m]')) return cap(ONE_MILLION)
  for (const { pattern, size } of MODEL_FAMILY_CONTEXT) {
    if (pattern.test(id)) return cap(size)
  }
  return DEFAULT_CONTEXT_SIZE
}

/** A window cannot be smaller than what a reading shows was used. Returns `max` while the usage fits,
 *  else the next known size that holds it, else the usage itself (the only proven bound). */
export function windowCoveringUsage(max: number, used: number): number {
  if (!Number.isFinite(used) || used <= max) return max
  return KNOWN_SIZES.find(size => size >= used) ?? used
}
