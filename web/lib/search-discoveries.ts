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

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * File cards for the paths a successful search call listed, at most SEARCH_DISCOVERY.maxPerCall, in a column to
 * the right of the tool card, starting on it (they animate out). Ids are `disc-<agent>-<tool_use_id>-<index>`, so
 * a replayed result builds the same ids; a call without a tool_use_id gets no card, since nothing would make its
 * cards stable. The caller checks the call succeeded and skips ids already on screen.
 */
export function searchDiscoveries(
  call: Pick<ToolCallNode, 'agentId' | 'toolName' | 'inputData' | 'toolUseId' | 'x' | 'y'>,
  result: string,
  time: number,
): Discovery[] {
  if (!call.toolUseId) return []
  const listed = provenListedPaths(call.toolName, call.inputData, result)
  if (!listed) return []
  const shownPaths = listed.paths.slice(0, SEARCH_DISCOVERY.maxPerCall)
  const tool = canonicalTool(call.toolName)
  return shownPaths.map((path, i) => ({
    id: `disc-${call.agentId}-${call.toolUseId}-${i}`,
    agentId: call.agentId,
    type: 'file' as const,
    label: baseName(path),
    content: path,
    x: call.x,
    y: call.y,
    targetX: call.x + SEARCH_DISCOVERY.offsetX,
    targetY: call.y + (i - (shownPaths.length - 1) / 2) * SEARCH_DISCOVERY.gapY,
    opacity: 0,
    timestamp: time,
    toolUseId: call.toolUseId,
    listing: { tool, position: i + 1, reported: listed.reported, shown: shownPaths.length },
  }))
}
