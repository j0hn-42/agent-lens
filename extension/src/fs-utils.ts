import * as fs from 'fs'
import * as path from 'path'

/**
 * Read a chunk of bytes from a file at a given offset.
 * Uses try/finally to guarantee the file descriptor is always closed.
 */
export function readFileChunk(filePath: string, offset: number, length: number): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, offset)
    return buffer.toString('utf-8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Read new lines appended to a file since `lastSize` bytes.
 * Returns the new lines, updated file size, and any trailing partial line
 * (bytes past the last newline) as `tail` — pass it back on the next call as
 * `lastTail` to reassemble lines split across reads. If callers ignore `tail`,
 * they silently lose any line that wasn't fully flushed by the writer yet.
 * Handles truncation (file shrunk) by resetting to 0.
 */
export function readNewFileLines(
  filePath: string,
  lastSize: number,
  lastTail = '',
): { lines: string[]; newSize: number; tail: string } | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch { return null /* expected if file was removed */ }

  if (stat.size < lastSize) {
    // File was truncated — reset both size and tail
    return { lines: [], newSize: 0, tail: '' }
  }
  if (stat.size <= lastSize) {
    return null
  }

  const newContent = lastTail + readFileChunk(filePath, lastSize, stat.size - lastSize)
  const parts = newContent.split(/\r?\n/)
  // Last fragment is whatever follows the final newline — empty if the file
  // ended on a newline, otherwise a partial line we need to carry forward.
  const tail = parts.pop() ?? ''
  const lines = parts.filter(Boolean)
  return { lines, newSize: stat.size, tail }
}

/** Suivi d'un fichier JSONL lu en continu : offset et fragment de ligne non terminée. */
export interface TailedFile {
  fileSize: number
  /** Octets après le dernier saut de ligne de la lecture précédente. */
  fileTail: string
}

/**
 * Lit les nouvelles lignes de `filePath` en mettant à jour `state` (fileSize + fileTail) en place.
 * Point d'entrée unique des watchers : une ligne coupée entre deux lectures est réassemblée.
 * Retourne null s'il n'y a rien de nouveau, [] après une troncature (état remis à zéro).
 */
export function readTrackedLines(filePath: string, state: TailedFile): string[] | null {
  const result = readNewFileLines(filePath, state.fileSize, state.fileTail)
  if (!result) return null
  state.fileSize = result.newSize
  state.fileTail = result.tail
  return result.lines
}

/** Case-fold a path string for comparison on Windows, where the filesystem is
 *  case-insensitive and tools disagree on drive-letter case (VS Code reports
 *  `c:\...`, Claude Code and most shells report `C:\...`). Identity elsewhere. */
export function foldPathCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/** True when `child` is `root` or lies inside it (both absolute, already resolved). */
export function isPathInside(child: string, root: string): boolean {
  const rel = path.relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Subagent transcripts of a session: `<dir>/agent-*.jsonl` plus the ones of Workflow-tool agents,
 * which live in `<dir>/workflows/<wf_id>/agent-*.jsonl` (next to a `journal.jsonl` that is not a
 * transcript). Nothing deeper is read. Returns [] when the directory does not exist.
 */
export function listSubagentTranscripts(dir: string): string[] {
  const out: string[] = []
  const collect = (d: string) => {
    let names: string[]
    try { names = fs.readdirSync(d) } catch { return }
    for (const n of names) if (n.startsWith('agent-') && n.endsWith('.jsonl')) out.push(path.join(d, n))
  }
  collect(dir)
  const wfRoot = path.join(dir, 'workflows')
  let runs: fs.Dirent[]
  try { runs = fs.readdirSync(wfRoot, { withFileTypes: true }) } catch { return out }
  for (const r of runs) if (r.isDirectory()) collect(path.join(wfRoot, r.name))
  return out
}

/**
 * Read a small regular file defensively: lstat (symlinks are refused), size cap, optional
 * containment check on the real path (so a symlinked parent directory cannot escape `rootDir`),
 * O_NOFOLLOW where available. Returns the text, or undefined for anything unexpected.
 */
export function readTextFileSafe(filePath: string, maxBytes: number, rootDir?: string): string | undefined {
  try {
    const st = fs.lstatSync(filePath)
    if (!st.isFile() || st.size > maxBytes) return undefined
    if (rootDir && !isPathInside(fs.realpathSync(filePath), fs.realpathSync(rootDir))) return undefined
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    const fd = fs.openSync(filePath, flags)
    try {
      const buf = Buffer.alloc(Math.min(st.size, maxBytes))
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      return buf.toString('utf-8', 0, n)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/**
 * Like {@link readTextFileSafe} but for files above `maxBytes`: reads only the FIRST `maxBytes`
 * bytes. `bytes` is the real file size, `truncated` tells the caller that the tail was cut off
 * (a multibyte character split by the cut is dropped). Same symlink / containment guards.
 */
export function readHeadTextSafe(filePath: string, maxBytes: number, rootDir?: string): { text: string; truncated: boolean; bytes: number } | undefined {
  try {
    const st = fs.lstatSync(filePath)
    if (!st.isFile()) return undefined
    if (rootDir && !isPathInside(fs.realpathSync(filePath), fs.realpathSync(rootDir))) return undefined
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    const fd = fs.openSync(filePath, flags)
    try {
      const buf = Buffer.alloc(Math.min(st.size, maxBytes))
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      const truncated = st.size > maxBytes
      let text = buf.toString('utf-8', 0, n)
      if (truncated) text = text.replace(/�$/, '')
      return { text, truncated, bytes: st.size }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/** {@link readTextFileSafe} + JSON.parse; undefined when unreadable or malformed. */
export function readJsonFileSafe(filePath: string, maxBytes: number, rootDir?: string): unknown {
  const text = readTextFileSafe(filePath, maxBytes, rootDir)
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

/**
 * Like {@link readTextFileSafe} but for files above `maxBytes`: reads only the LAST `maxBytes`
 * bytes. `truncated` tells the caller that the head was cut off. Same symlink / containment guards.
 */
export function readTailTextSafe(filePath: string, maxBytes: number, rootDir?: string): { text: string; truncated: boolean } | undefined {
  try {
    const st = fs.lstatSync(filePath)
    if (!st.isFile()) return undefined
    if (rootDir && !isPathInside(fs.realpathSync(filePath), fs.realpathSync(rootDir))) return undefined
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    const fd = fs.openSync(filePath, flags)
    try {
      const start = Math.max(0, st.size - maxBytes)
      const buf = Buffer.alloc(st.size - start)
      const n = fs.readSync(fd, buf, 0, buf.length, start)
      return { text: buf.toString('utf-8', 0, n), truncated: start > 0 }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}
