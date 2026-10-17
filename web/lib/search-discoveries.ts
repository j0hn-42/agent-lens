import type { Discovery, ToolCallNode } from './agent-types'
import { canonicalTool, searchResultCount, RESULT_CAPTURE_LIMIT } from './action-summary'
import { SEARCH_DISCOVERY } from './canvas-constants'

/** What a Glob / Grep output proves it listed: the whole path lines under its header, and the header's count. */
interface ListedPaths {
  /** The paths, all distinct, in the order the output lists them */
  paths: string[]
  /** Files the tool's own `Found N files` header reports (may exceed `paths`: a limit or the capture cut) */
  reported: number
}

/**
 * A whole path line under the header: Grep prints paths relative to the working directory, so no prefix is
 * required. Empty, space-padded or control-character lines are not paths; a `path:12:` content or count line
 * is not one either.
 */
function isPathLine(line: string): boolean {
  if (!line || /^\s|\s$/.test(line)) return false
  if (/[\u0000-\u001f\u007f]/.test(line)) return false
  return !/:\d+(:|$)/.test(line)
}

/**
 * The paths a successful Glob / Grep output lists itself (#438). Null unless the output starts with the tool's own
 * `Found N files` header (a list without it is not proven to be paths), Grep is not in content or count mode, and
 * at least one whole path line follows. Lines are read up to the first one that is not a path line; the last
 * line of an output that reached the capture limit may be cut, so it is dropped. More paths than the header
 * reports, or a path listed twice, means the output is not what it claims: null. The caller checks the call succeeded.
 */
function provenListedPaths(toolName: string, inputData: Record<string, unknown> | undefined, result: string): ListedPaths | null {
  const tool = canonicalTool(toolName)
  if (tool !== 'Glob' && tool !== 'Grep') return null
  if (tool === 'Grep' && inputData?.output_mode !== undefined && inputData.output_mode !== 'files_with_matches') return null
  const reported = searchResultCount(toolName, result)
  if (!reported) return null
  const lines = result.split('\n').slice(1)
  const whole = result.length >= RESULT_CAPTURE_LIMIT ? lines.slice(0, -1) : lines
  const paths: string[] = []
  for (const line of whole) {
    if (!isPathLine(line)) break
    // A path listed twice: the output is not the list it claims to be
    if (paths.includes(line)) return null
    paths.push(line)
  }
  if (paths.length === 0 || paths.length > reported) return null
  return { paths, reported }
}

/** A Glob's structured listing as the extension forwards it (#451): the first files and the tool's own total */
interface SearchListingPayload {
  files: string[]
  count: number
}
const LISTING_MAX_FILES = 20
const LISTING_PATH_MAX = 300
const LISTING_COUNT_MAX = 1_000_000_000

/**
 * The listing of a `tool_call_end` payload, or null. Re-validated here whatever the source (the relay forwards
 * payloads untouched): 1 to 20 distinct single-line names within 300 characters, and an integer total at least
 * as large as the list, within a sane bound. It does not prove completeness: the extension forwards only an
 * untruncated list.
 */
function readSearchListing(v: unknown): SearchListingPayload | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const { files, count } = v as Record<string, unknown>
  if (!Array.isArray(files) || files.length === 0 || files.length > LISTING_MAX_FILES) return null
  if (typeof count !== 'number' || !Number.isInteger(count) || count < files.length || count > LISTING_COUNT_MAX) return null
  const seen = new Set<string>()
  for (const f of files) {
    if (typeof f !== 'string' || f.length === 0 || f.length > LISTING_PATH_MAX || /[\u0000-\u001f\u007f]/.test(f) || seen.has(f)) return null
    seen.add(f)
  }
  return { files: files as string[], count }
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * File cards for the paths a successful search call listed, at most SEARCH_DISCOVERY.maxPerCall, in a column to
 * the right of the tool card, born in place: they fade in but do not move (a slide comes with #384 and its
 * reduced-motion guard). Ids are `disc-<agent>-<tool_use_id>-<index>`, so a replayed result builds the same ids;
 * a call without a tool_use_id gets no card, since nothing would make its cards stable. The caller checks the call
 * succeeded and skips ids already on screen.
 */
export function searchDiscoveries(
  call: Pick<ToolCallNode, 'agentId' | 'toolName' | 'inputData' | 'toolUseId' | 'x' | 'y'>,
  result: string,
  time: number,
  listing?: unknown,
): Discovery[] {
  if (!call.toolUseId) return []
  // A Glob's structured listing (#451) is the only thing that proves its list and total; without a valid one the
  // text is read as before (a header is required)
  const structured = canonicalTool(call.toolName) === 'Glob' ? readSearchListing(listing) : null
  const listed = structured
    ? { paths: structured.files, reported: structured.count }
    : provenListedPaths(call.toolName, call.inputData, result)
  if (!listed) return []
  const shownPaths = listed.paths.slice(0, SEARCH_DISCOVERY.maxPerCall)
  const tool = canonicalTool(call.toolName)
  return shownPaths.map((path, i) => {
    const targetX = call.x + SEARCH_DISCOVERY.offsetX
    const targetY = call.y + (i - (shownPaths.length - 1) / 2) * SEARCH_DISCOVERY.gapY
    return {
      id: `disc-${call.agentId}-${call.toolUseId}-${i}`,
      agentId: call.agentId,
      type: 'file' as const,
      label: baseName(path),
      content: path,
      x: targetX,
      y: targetY,
      targetX,
      targetY,
      opacity: 0,
      timestamp: time,
      toolUseId: call.toolUseId,
      listing: { tool, position: i + 1, reported: listed.reported, shown: shownPaths.length },
    }
  })
}
