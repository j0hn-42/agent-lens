/**
 * Journal of the agent launches (#229): JSONL, append only, mode 0600, bounded (one rotation, `<file>.1`).
 * Only a fixed set of fields is ever written, each bounded: the token, the issue text and the environment cannot
 * reach the file even if a caller hands them over. The file is opened with O_NOFOLLOW (a link planted at the path is
 * not followed). Every failure is a `false`, never an exception: the supervisor decides what a missing entry means
 * (no first entry, no launch).
 */
import * as fs from 'fs'
import * as path from 'path'
import type { Journal, JournalEntry } from './launch-supervisor'

export const JOURNAL_MAX_BYTES = 1024 * 1024
const STRING_MAX = 300
const ARGV_MAX_ITEMS = 80

const STRING_FIELDS = ['ts', 'event', 'id', 'repo', 'role', 'uuid', 'state', 'signal', 'reason'] as const
const NUMBER_FIELDS = ['issue', 'pid', 'exitCode', 'durationMs'] as const

function clip(s: string): string { return Array.from(s).slice(0, STRING_MAX).join('') }

/** The line to write: known fields only, bounded. Exported for the tests. */
export function journalLine(entry: JournalEntry): string {
  const src = entry as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of STRING_FIELDS) if (typeof src[k] === 'string') out[k] = clip(src[k] as string)
  for (const k of NUMBER_FIELDS) if (typeof src[k] === 'number' && Number.isFinite(src[k])) out[k] = src[k]
  if (Array.isArray(src.argv)) out.argv = src.argv.slice(0, ARGV_MAX_ITEMS).filter((a): a is string => typeof a === 'string').map(clip)
  return JSON.stringify(out) + '\n'
}

const O_NOFOLLOW: number = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

export function createFileJournal(opts: { file: string; maxBytes?: number }): Journal {
  const { file } = opts
  const maxBytes = opts.maxBytes ?? JOURNAL_MAX_BYTES

  function openAppend(): number {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | O_NOFOLLOW, 0o600)
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile()) throw new Error('not a regular file')
      if ((st.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600)
    } catch (err) { fs.closeSync(fd); throw err }
    return fd
  }

  return {
    append(entry) {
      let fd = -1
      try {
        const line = journalLine(entry)
        const bytes = Buffer.byteLength(line)
        fd = openAppend()
        if (fs.fstatSync(fd).size > 0 && fs.fstatSync(fd).size + bytes > maxBytes) {
          fs.closeSync(fd); fd = -1
          // Replaces the previous .1: at most two files, each under the cap
          fs.renameSync(file, `${file}.1`)
          fd = openAppend()
        }
        fs.writeSync(fd, line)
        return true
      } catch {
        return false
      } finally {
        if (fd >= 0) { try { fs.closeSync(fd) } catch { /* closed */ } }
      }
    },
  }
}
