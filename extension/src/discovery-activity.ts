/**
 * Newest write time among the subagent transcripts of a session whose main file is idle (#79).
 *
 * An orchestrator blocked on the Workflow tool leaves its own file idle while the agents under
 * subagents/workflows/<id>/ keep growing, so the relay must look at those files to decide whether the
 * session is still alive. The scan stops as soon as one file is recent enough (that is all the caller
 * needs), and examines at most DISCOVERY_MAX_TRANSCRIPT_STATS files as a safety bound: a fixed small cap
 * (it used to be 100) silently dropped sessions whose fresh files came later in directory order.
 */
import * as fs from 'fs'

/** Safety bound on files examined per session and scan (WORKFLOW_MAX_AGENTS x WORKFLOW_MAX_PER_SESSION is 4000) */
export const DISCOVERY_MAX_TRANSCRIPT_STATS = 5000

export interface StatLike { isFile(): boolean; mtimeMs: number }

export function newestTranscriptMtime(
  paths: Iterable<string>,
  startMtime: number,
  /** Stop once a file is newer than this (ms epoch): the session is alive, nothing more to learn */
  freshAfter: number,
  maxStats: number = DISCOVERY_MAX_TRANSCRIPT_STATS,
  lstat: (p: string) => StatLike = p => fs.lstatSync(p),
): number {
  let newest = startMtime
  let n = 0
  for (const p of paths) {
    if (++n > maxStats) break
    try {
      const st = lstat(p)
      // lstat + isFile: a symlink (to anything, inside or outside ~/.claude) never counts as activity
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs
    } catch { /* vanished between listing and stat */ }
    if (newest > freshAfter) break
  }
  return newest
}
