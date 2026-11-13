/**
 * Burrow view: the name tag drawn under each animal, so that with several agents one can tell which animal is which.
 * Like the graph hides names that would overlap, a tag that would cover another tag or a bubble is hidden; the selected
 * and the hovered agent always keep theirs. No DOM here: the view measures the boxes and asks which tags to show.
 */

/** Longest tag, ellipsis included: a long agent name would cover its neighbours (the agent list carries the full name) */
const BURROW_TAG_MAX_CHARS = 16

/** `name` cut to `max` characters (code points), the last one being an ellipsis when it was cut */
export function truncateName(name: string, max = BURROW_TAG_MAX_CHARS): string {
  const chars = Array.from(name.trim())
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…'
}

/** An animal outside the burrow (mode home) or in the doorway has no tag: it is not on the floor of the scene */
export const showsTag = (mode: string): boolean => mode !== 'home' && mode !== 'doorIn' && mode !== 'doorOut'

export interface Box { x: number; y: number; w: number; h: number }
export interface TagBox extends Box { key: string }

/** Overlap of two boxes; sharing an edge is not overlapping */
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

export interface CullOptions {
  /** Keys whose tag is always shown (the selected and the hovered agent), in this order */
  always?: readonly (string | null | undefined)[]
  /** Keys shown at the previous frame: they keep their place against a newcomer, so tags do not flicker */
  previous?: ReadonlySet<string>
}

/**
 * Which tags to show: the `always` ones first, whatever they cover; then the others, previously shown first and by key,
 * each one only if it covers neither a bubble (`obstacles`) nor a tag already shown.
 */
export function cullTags(tags: readonly TagBox[], obstacles: readonly Box[], opts: CullOptions = {}): Set<string> {
  const shown = new Set<string>()
  const placed: Box[] = []
  const byKey = new Map(tags.map((t) => [t.key, t]))
  for (const key of opts.always ?? []) {
    const t = key ? byKey.get(key) : undefined
    if (!t || shown.has(t.key)) continue
    shown.add(t.key); placed.push(t)
  }
  const prev = opts.previous
  const rest = tags.filter((t) => !shown.has(t.key)).sort((a, b) =>
    Number(prev?.has(b.key) ?? false) - Number(prev?.has(a.key) ?? false) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const t of rest) {
    if (obstacles.some((o) => overlaps(t, o)) || placed.some((p) => overlaps(t, p))) continue
    shown.add(t.key); placed.push(t)
  }
  return shown
}

/**
 * The names the tags carry, refreshed from the list rows. `changed` says the tags must be placed again: under reduced
 * motion or Freeze motion nothing else would redraw them when only an agent's name changed.
 */
export function nextTagNames(prev: ReadonlyMap<string, string>, rows: readonly { id: string; name: string }[]): { names: Map<string, string>; changed: boolean } {
  let changed = rows.length !== prev.size
  if (!changed) for (const r of rows) if (prev.get(r.id) !== r.name) { changed = true; break }
  if (!changed) return { names: prev as Map<string, string>, changed }
  return { names: new Map(rows.map((r) => [r.id, r.name])), changed }
}

/**
 * Whether an animal's speech bubble is shown. A "last known state" bubble (the agent is silent, replayed or imported)
 * would otherwise stay up for good: it shows only on the hovered or selected animal. The sleeping posture and the agent
 * list already say the state is the last one known. Every other bubble is always shown.
 */
export function bubbleShown(key: string, stale: ReadonlySet<string>, selected: string | null, hovered: string | null): boolean {
  return !stale.has(key) || key === selected || key === hovered
}
