/**
 * Project identity of a session: the git common dir, hashed. A repository and all its
 * worktrees share one common dir, so their sessions share one identity; outside a git repository
 * there is none (null) and the session stays ungrouped.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export const PROJECT_ID_LENGTH = 12
const PROJECT_NAME_MAX = 80
const MAX_WALK_DEPTH = 64
const MAX_FILE_BYTES = 4096
const CACHE_MAX = 1000

export interface ProjectIdentity {
  /** Stable hash of the repository's common git dir (same for every worktree) */
  projectId: string
  /** Folder name of the main checkout (or of the bare repository) */
  projectName: string
}

/** Returns the git common dir of `cwd` (possibly relative to it); throws outside a repository. */
export type GitCommonDirRunner = (cwd: string) => string

const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory() } catch { return false } }
/** Only small regular files: a FIFO, a device or a huge file planted at `.git` must not block or exhaust the relay. */
const readText = (p: string): string | null => {
  try {
    const st = fs.statSync(p)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
    return fs.readFileSync(p, 'utf8')
  } catch { return null }
}

/**
 * Finds the common dir by reading `.git` on disk. No process is spawned: `cwd` comes from transcript
 * data, so running `git` there would honour that directory's own config (and resolve `git` on the PATH).
 */
const defaultRunner: GitCommonDirRunner = cwd => {
  let dir = path.resolve(cwd)
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const dotGit = path.join(dir, '.git')
    if (isDir(dotGit)) return dotGit
    const pointer = readText(dotGit) // a linked worktree or submodule: `gitdir: <path>`
    const match = pointer && /^gitdir:\s*(.+?)\s*$/m.exec(pointer)
    if (match) {
      const gitDir = path.resolve(dir, match[1])
      const common = readText(path.join(gitDir, 'commondir'))?.trim()
      return common ? path.resolve(gitDir, common) : gitDir
    }
    const bare = isDir(path.join(dir, 'objects')) && isDir(path.join(dir, 'refs')) && readText(path.join(dir, 'HEAD')) !== null
    if (bare) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('not a git repository')
}

// Insertion-ordered, oldest evicted first; failures are cached too so a non-repo cwd costs one git call
const cache = new Map<string, ProjectIdentity | null>()

export function clearProjectIdentityCache(): void {
  cache.clear()
}

function compute(cwd: string, run: GitCommonDirRunner): ProjectIdentity | null {
  let out: string
  try { out = run(cwd).trim() } catch { return null }
  if (!out) return null
  let commonDir = path.resolve(cwd, out)
  try { commonDir = fs.realpathSync(commonDir) } catch { /* keep the resolved path */ }
  const isDotGit = path.basename(commonDir) === '.git'
  const base = path.basename(isDotGit ? path.dirname(commonDir) : commonDir).replace(/\.git$/, '')
  // eslint-disable-next-line no-control-regex
  const projectName = base.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, PROJECT_NAME_MAX)
  if (!projectName) return null
  const key = process.platform === 'win32' ? commonDir.toLowerCase() : commonDir
  const projectId = crypto.createHash('sha256').update(key).digest('hex').slice(0, PROJECT_ID_LENGTH)
  return { projectId, projectName }
}

/** Identity of the project `cwd` belongs to, or null when unknown (no cwd, not a git repository, git missing). */
export function resolveProjectIdentity(cwd: string | undefined, run: GitCommonDirRunner = defaultRunner): ProjectIdentity | null {
  if (!cwd) return null
  if (cache.has(cwd)) return cache.get(cwd) ?? null
  const identity = compute(cwd, run)
  cache.set(cwd, identity)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return identity
}

/** The optional SessionInfo fields for a working directory ({} when it has no project). */
export function projectTags(cwd: string | undefined): { projectId?: string; projectName?: string } {
  const id = resolveProjectIdentity(cwd)
  return id ? { projectId: id.projectId, projectName: id.projectName } : {}
}
