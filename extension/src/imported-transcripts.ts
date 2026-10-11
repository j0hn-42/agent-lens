/**
 * Imported transcripts (#294, track 1): JSONL session files fetched from a cloud agent and handed to the relay
 * on its command line (--import) or in AGENT_LENS_IMPORT. Never reached through HTTP.
 *
 * A path is a `<session id>.jsonl` file or a folder whose `*.jsonl` files (directly inside, regular files,
 * no symbolic links) are taken. Everything refused is reported as a problem, never silently dropped.
 */
import * as fs from 'fs'
import * as path from 'path'
import { isValidSessionId } from './relay-guards'
import { readLinesChunked } from './fs-utils'

export interface ImportedTranscript { sessionId: string; filePath: string }
export interface ImportResolution { transcripts: ImportedTranscript[]; problems: string[] }

/** Paths of AGENT_LENS_IMPORT: split on the platform delimiter (':' or ';'), blanks dropped. */
export function parseImportPaths(raw: string | undefined, delimiter: string = path.delimiter): string[] {
  if (!raw) return []
  return raw.split(delimiter).map(p => p.trim()).filter(p => p.length > 0)
}

export function resolveImportedTranscripts(
  inputs: readonly string[],
  opts: { maxFileBytes: number; maxSessions: number },
): ImportResolution {
  const transcripts: ImportedTranscript[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  let overLimit = 0

  const take = (filePath: string, stat: fs.Stats) => {
    const name = path.basename(filePath)
    const sessionId = name.slice(0, -'.jsonl'.length)
    if (!isValidSessionId(sessionId)) { problems.push(`${filePath}: the file name is not a session id`); return }
    if (stat.size > opts.maxFileBytes) { problems.push(`${filePath}: size ${stat.size} bytes exceeds the ${opts.maxFileBytes} bytes cap`); return }
    if (seen.has(sessionId)) { problems.push(`${filePath}: session ${sessionId} is already imported`); return }
    if (transcripts.length >= opts.maxSessions) { overLimit++; return }
    seen.add(sessionId)
    transcripts.push({ sessionId, filePath })
  }

  for (const input of inputs) {
    const resolved = path.resolve(input)
    let stat: fs.Stats
    try { stat = fs.statSync(resolved) } catch { problems.push(`${resolved}: not found`); continue }
    if (stat.isDirectory()) {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(resolved, { withFileTypes: true }) } catch { problems.push(`${resolved}: folder not readable`); continue }
      // Only regular files: a symbolic link could lead outside the imported folder
      const files = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => e.name).sort()
      for (const name of files) {
        const filePath = path.join(resolved, name)
        let fileStat: fs.Stats
        try { fileStat = fs.lstatSync(filePath) } catch { problems.push(`${filePath}: not readable`); continue }
        if (fileStat.isFile()) take(filePath, fileStat)
      }
    } else if (stat.isFile() && resolved.endsWith('.jsonl')) {
      take(resolved, stat)
    } else {
      problems.push(`${resolved}: not a .jsonl file or a folder`)
    }
  }
  if (overLimit > 0) problems.push(`${overLimit} transcript(s) not imported: limit of ${opts.maxSessions} imported sessions reached`)
  return { transcripts, problems }
}

/** First and last `timestamp` recorded in a transcript (ms since epoch); absent when none is readable. */
export function transcriptTimeRange(filePath: string): { first?: number; last?: number } {
  let first: number | undefined
  let last: number | undefined
  try {
    const size = fs.statSync(filePath).size
    for (const line of readLinesChunked(filePath, size)) {
      // Cheap filter before parsing: most lines of a large transcript carry a timestamp anyway
      if (!line.includes('"timestamp"')) continue
      let ts: unknown
      try { ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp } catch { continue }
      if (typeof ts !== 'string') continue
      const t = Date.parse(ts)
      if (!Number.isFinite(t)) continue
      if (first === undefined) first = t
      last = t
    }
  } catch { /* unreadable: nothing is claimed */ }
  return { ...(first !== undefined ? { first } : {}), ...(last !== undefined ? { last } : {}) }
}
