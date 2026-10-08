/**
 * Link an agent node to the GitHub issues / PRs that carry its `agent:<role>` label (#63).
 *
 * Read-only and defensive: the role is validated before it reaches a command line, gh runs without a
 * shell and with a timeout, the repository comes from the workspace `origin` remote and must be a plain
 * github.com URL, and every URL gh returns must be exactly `<repo>/issues/<n>` or `<repo>/pull/<n>`.
 * Anything else, or gh being absent / unauthenticated / slow, yields no link (silent degradation).
 */
import { execFile } from 'child_process'

/** Entries kept per kind (matches the `--limit` given to gh) */
export const ISSUE_LINKS_MAX = 50
const TITLE_MAX = 200
const GH_TIMEOUT_MS = 8_000
const GH_MAX_BUFFER = 1024 * 1024

export interface IssueLink {
  kind: 'issue' | 'pr'
  number: number
  title: string
  url: string
  /** Lower-cased GitHub state: open, closed, merged */
  state: string
  /** PRs only: true for a draft */
  draft?: boolean
}

/** Runs a program without a shell and resolves with its stdout; rejects on any failure. */
export type GhExec = (file: string, args: string[], opts?: { cwd?: string }) => Promise<string>

export const defaultExec: GhExec = (file, args, opts) => new Promise((resolve, reject) => {
  execFile(file, args, {
    cwd: opts?.cwd, timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, windowsHide: true,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
  }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
})

const ROLE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

/** The `<role>` of `agent:<role>`: lower-case letters, digits, `-` and `_`, never starting with a dash. */
export function sanitizeRole(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const role = value.toLowerCase()
  return ROLE_RE.test(role) ? role : undefined
}

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/

/** Session id of a request, or undefined when malformed (the id is only ever looked up, never run). */
export function sanitizeSessionParam(value: unknown): string | undefined {
  return typeof value === 'string' && SESSION_RE.test(value) ? value : undefined
}

/**
 * Which repository the links of a node come from. The node's own session decides (its cwd); a session
 * of an unknown project cannot be proven to belong to the relay's repository when the relay serves
 * every workspace, so nothing is shown rather than another project's issues.
 */
export type IssueScope = { kind: 'cwd'; cwd: string } | { kind: 'workspace' } | { kind: 'unknown' }
export function issueLinksScope(opts: { session?: string; cwd?: string; allWorkspaces: boolean }): IssueScope {
  if (opts.cwd) return { kind: 'cwd', cwd: opts.cwd }
  if (opts.session && opts.allWorkspaces) return { kind: 'unknown' }
  return { kind: 'workspace' }
}

const OWNER_REPO = '([A-Za-z0-9_.-]{1,100})/([A-Za-z0-9_.-]{1,100}?)'
const REMOTE_RES = [
  new RegExp(`^https://github\\.com/${OWNER_REPO}(?:\\.git)?/?$`),
  new RegExp(`^git@github\\.com:${OWNER_REPO}(?:\\.git)?$`),
  new RegExp(`^ssh://git@github\\.com/${OWNER_REPO}(?:\\.git)?$`),
]

/** Canonical `https://github.com/<owner>/<name>` of a remote URL, or undefined when it is anything else. */
export function normalizeRepoUrl(remote: unknown): string | undefined {
  if (typeof remote !== 'string') return undefined
  const value = remote.trim()
  for (const re of REMOTE_RES) {
    const m = re.exec(value)
    if (m && m[1] !== '.' && m[1] !== '..' && m[2] !== '.' && m[2] !== '..') return `https://github.com/${m[1]}/${m[2]}`
  }
  return undefined
}

/** The workspace's GitHub repository (its `origin` remote), or undefined. */
export async function resolveRepoUrl(cwd: string, exec: GhExec = defaultExec): Promise<string | undefined> {
  try {
    return normalizeRepoUrl(await exec('git', ['remote', 'get-url', 'origin'], { cwd }))
  } catch {
    return undefined
  }
}

/** Validate the JSON printed by `gh issue|pr list --json number,title,url,state[,isDraft]`. */
export function parseGhList(stdout: string, kind: IssueLink['kind'], repoUrl: string): IssueLink[] {
  let rows: unknown
  try { rows = JSON.parse(stdout) } catch { return [] }
  if (!Array.isArray(rows)) return []
  const segment = kind === 'issue' ? 'issues' : 'pull'
  const out: IssueLink[] = []
  for (const row of rows) {
    if (out.length >= ISSUE_LINKS_MAX) break
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const number = r.number
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) continue
    // Only the exact URL of this repository is trusted; gh's own claim is not enough
    if (r.url !== `${repoUrl}/${segment}/${number}`) continue
    const link: IssueLink = {
      kind, number,
      title: typeof r.title === 'string' ? r.title.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, TITLE_MAX) : '',
      url: r.url,
      state: typeof r.state === 'string' ? r.state.toLowerCase().slice(0, 16) : 'open',
    }
    if (kind === 'pr' && r.isDraft === true) link.draft = true
    out.push(link)
  }
  return out
}

export interface FetchIssueLinksOptions {
  /** Canonical repository URL (see {@link normalizeRepoUrl}) */
  repoUrl: string
  exec?: GhExec
}

/** Open PRs then open issues labelled `agent:<role>`; [] on invalid input or any gh failure. */
export async function fetchIssueLinks(role: unknown, opts: FetchIssueLinksOptions): Promise<IssueLink[]> {
  const clean = sanitizeRole(role)
  const repoUrl = normalizeRepoUrl(opts.repoUrl)
  if (!clean || !repoUrl) return []
  const exec = opts.exec ?? defaultExec
  const slug = repoUrl.slice('https://github.com/'.length)
  const list = async (kind: IssueLink['kind']): Promise<IssueLink[]> => {
    try {
      const sub = kind === 'issue' ? 'issue' : 'pr'
      const fields = kind === 'issue' ? 'number,title,url,state' : 'number,title,url,state,isDraft'
      const stdout = await exec('gh', [
        sub, 'list', '--repo', slug, '--label', `agent:${clean}`, '--state', 'open',
        '--limit', String(ISSUE_LINKS_MAX), '--json', fields,
      ])
      return parseGhList(stdout, kind, repoUrl)
    } catch {
      return []
    }
  }
  const [prs, issues] = await Promise.all([list('pr'), list('issue')])
  return [...prs, ...issues]
}
