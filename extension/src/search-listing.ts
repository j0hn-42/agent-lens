/**
 * The files a Glob proved it listed (#451). A real Claude Code transcript entry carries, next to the text result,
 * a structured `toolUseResult`: `{ filenames: string[], numFiles, truncated, durationMs, ... }`. The text has no
 * "Found N files" header, so only this field proves the list and its total. Everything read from a transcript is
 * untrusted: the listing is forwarded only when it is whole and consistent, and bounded.
 */

/** Files forwarded per call: the web draws fewer (SEARCH_DISCOVERY.maxPerCall); the total travels as `count` */
export const SEARCH_LISTING_MAX_FILES = 20
/** A longer path makes the whole listing invalid (it would have to be cut: not what the tool listed) */
export const SEARCH_LISTING_PATH_MAX = 300

export interface SearchListing {
  /** The first files of the list, in the tool's order (at most SEARCH_LISTING_MAX_FILES) */
  files: string[]
  /** The number of files the tool returned, equal to the length of the list it returned */
  count: number
}

/**
 * The listing a successful Glob's structured result proves, or null. Null unless `truncated` is the boolean
 * false (a truncated list has an unknown total), every name is a distinct non-empty single-line string within
 * SEARCH_LISTING_PATH_MAX, and `numFiles` is an integer equal to the list length. The caller checks the call succeeded.
 */
export function globListingOf(toolName: string, toolUseResult: unknown): SearchListing | null {
  if (toolName !== 'Glob') return null
  if (typeof toolUseResult !== 'object' || toolUseResult === null || Array.isArray(toolUseResult)) return null
  const r = toolUseResult as Record<string, unknown>
  if (r.truncated !== false || !Array.isArray(r.filenames)) return null
  const names = r.filenames
  if (names.length === 0 || !Number.isInteger(r.numFiles) || r.numFiles !== names.length) return null
  const seen = new Set<string>()
  for (const n of names) {
    if (typeof n !== 'string' || n.length === 0 || n.length > SEARCH_LISTING_PATH_MAX) return null
    if (/[\u0000-\u001f\u007f]/.test(n) || seen.has(n)) return null
    seen.add(n)
  }
  return { files: (names as string[]).slice(0, SEARCH_LISTING_MAX_FILES), count: names.length }
}
