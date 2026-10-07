/**
 * Project identity of a session: `git rev-parse --git-common-dir`, hashed. A repository and all its
 * worktrees share one common dir, so their sessions share one identity; outside a git repository
 * there is none (null) and the session stays ungrouped.
 */
import { execFileSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export const PROJECT_ID_LENGTH = 12
const PROJECT_NAME_MAX = 80
const GIT_TIMEOUT_MS = 2000
const CACHE_MAX = 1000

export interface ProjectIdentity {
  /** Stable hash of the repository's common git dir (same for every worktree) */
  projectId: string
  /** Folder name of the main checkout (or of the bare repository) */
  projectName: string
}

/** Prints the `--git-common-dir` of `cwd` (possibly relative to it); throws outside a repository. */
export type GitCommonDirRunner = (cwd: string) => string

const defaultRunner: GitCommonDirRunner = cwd =>
  execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  })

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
