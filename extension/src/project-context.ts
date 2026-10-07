/**
 * Project context of a session (#64): its CLAUDE.md and the auto-memory index, read on demand.
 * Nothing here is watched or cached: the caller (relay GET /context) decides when to load, the web
 * client caches 60 s. Reads are bounded and refuse symlinks; a file that cannot be read is reported
 * as not found, never as empty.
 */
import * as path from 'path'
import { readHeadTextSafe } from './fs-utils'
import { PROJECT_CONTEXT_MAX_FILE_BYTES, PROJECT_CONTEXT_MAX_ISSUES } from './constants'

export interface ProjectContextFile {
  kind: 'claude-md' | 'memory'
  /** Display name (never an absolute path) */
  name: string
  found: boolean
  /** First PROJECT_CONTEXT_MAX_FILE_BYTES of the file ('' when not found) */
  text: string
  /** Real size on disk */
  bytes: number
  truncated: boolean
}

export interface ProjectContext {
  files: ProjectContextFile[]
  /** Issue numbers (#n) cited in the text that was read; the issues themselves are not fetched */
  issues: number[]
}

/** Claude Code's directory name for a project path: /Users/simon/my_project -> -Users-simon-my-project */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Distinct #n references (n >= 1), ascending, capped. `#` must not follow a word character. */
export function extractIssueRefs(text: string): number[] {
  const found = new Set<number>()
  for (const m of text.matchAll(/(?<![\w&])#(\d{1,7})(?!\w)/g)) {
    const n = Number(m[1])
    if (n >= 1) found.add(n)
  }
  return [...found].sort((a, b) => a - b).slice(0, PROJECT_CONTEXT_MAX_ISSUES)
}

function readEntry(kind: ProjectContextFile['kind'], name: string, filePath: string | undefined, rootDir: string): ProjectContextFile {
  const read = filePath ? readHeadTextSafe(filePath, PROJECT_CONTEXT_MAX_FILE_BYTES, rootDir) : undefined
  if (!read) return { kind, name, found: false, text: '', bytes: 0, truncated: false }
  return { kind, name, found: true, text: read.text, bytes: read.bytes, truncated: read.truncated }
}

/** Load CLAUDE.md (in `cwd`) and MEMORY.md (in `<home>/.claude/projects/<encoded cwd>/memory`). */
export function readProjectContext(cwd: string, homeDir: string): ProjectContext {
  const usable = typeof cwd === 'string' && cwd.length > 0 && path.isAbsolute(cwd)
  const memoryRoot = path.join(homeDir, '.claude', 'projects')
  const files = [
    readEntry('claude-md', 'CLAUDE.md', usable ? path.join(cwd, 'CLAUDE.md') : undefined, cwd),
    readEntry('memory', 'MEMORY.md', usable ? path.join(memoryRoot, encodeProjectDir(cwd), 'memory', 'MEMORY.md') : undefined, memoryRoot),
  ]
  return { files, issues: extractIssueRefs(files.map(f => f.text).join('\n')) }
}
