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
