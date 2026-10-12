// #329: read-only triage of the open PRs of the fork. Sorts each PR by what it waits on,
// from GitHub facts only (checks, review decision, mergeability). Never writes to GitHub.
import { execFileSync } from 'node:child_process'

export interface GhCheck {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
}

export interface GhPr {
  number: number
  title: string
  isDraft: boolean
  headRefName: string
  reviewDecision: string
  mergeable: string
  labels: { name: string }[]
  statusCheckRollup: GhCheck[]
}

export type PrState = 'waiting-ci' | 'needs-fix' | 'draft-review' | 'awaiting-review' | 'ready-for-human' | 'no-checks'
export type WaitingOn = 'ci' | 'author' | 'squad' | 'human'

export interface Triage {
  number: number
  title: string
  state: PrState
  waitingOn: WaitingOn
  reason: string
  role?: string
}

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
const RUNNING = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED'])

const checkName = (c: GhCheck) => c.name ?? c.context ?? 'unnamed check'
// A CheckRun carries status + conclusion; a StatusContext carries only state.
const verdict = (c: GhCheck) => (c.conclusion || c.state || c.status || '').toUpperCase()
const running = (c: GhCheck) => RUNNING.has((c.status ?? '').toUpperCase()) || (c.__typename === 'StatusContext' && RUNNING.has(verdict(c)))

export function classifyPr(pr: GhPr): Triage {
  const base = { number: pr.number, title: pr.title, role: pr.labels.find(l => l.name.startsWith('agent:'))?.name.slice('agent:'.length) }
  const out = (state: PrState, waitingOn: WaitingOn, reason: string): Triage => ({ ...base, state, waitingOn, reason })

  const failed = pr.statusCheckRollup.filter(c => FAILED.has(verdict(c)))
  if (failed.length) return out('needs-fix', 'author', `failing: ${failed.map(checkName).join(', ')}`)
  if (pr.mergeable === 'CONFLICTING') return out('needs-fix', 'author', 'merge conflicts with the base branch')
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return out('needs-fix', 'author', 'changes requested by a reviewer')

  // A cancelled run is not a failure: wait for the next run instead of asking for a fix.
  const pending = pr.statusCheckRollup.filter(c => running(c) || verdict(c) === 'CANCELLED')
  if (pending.length) return out('waiting-ci', 'ci', `not finished: ${pending.map(checkName).join(', ')}`)

  if (!pr.statusCheckRollup.length) return out('no-checks', 'human', 'GitHub reports no check for this PR; nothing proves it is green')
  if (pr.isDraft) return out('draft-review', 'squad', 'checks pass, draft not reviewed yet')
  if (pr.reviewDecision === 'APPROVED') return out('ready-for-human', 'human', 'checks pass and approved: merge is yours')
  return out('awaiting-review', 'human', 'checks pass, no approval yet')
}

const SECTIONS: { on: WaitingOn; title: string }[] = [
  { on: 'human', title: 'Waiting on you' },
  { on: 'author', title: 'Waiting on the PR author' },
  { on: 'squad', title: 'Waiting on the squad (review)' },
  { on: 'ci', title: 'Waiting on CI' },
]

export function renderReport(prs: GhPr[]): string {
  if (!prs.length) return '# PR squad report\n\nNo open PR.\n'
  const rows = prs.map(classifyPr)
  const lines = ['# PR squad report', '', `${rows.length} open PR(s). Read-only: nothing was posted.`, '']
  for (const { on, title } of SECTIONS) {
    const group = rows.filter(r => r.waitingOn === on)
    if (!group.length) continue
    lines.push(`## ${title}`, '')
    for (const r of group) lines.push(`- #${r.number} ${r.title}${r.role ? ` [${r.role}]` : ''}: ${r.state}, ${r.reason}`)
    lines.push('')
  }
  return lines.join('\n')
}

const FIELDS = 'number,title,isDraft,headRefName,reviewDecision,mergeable,labels,statusCheckRollup'

function fetchOpenPrs(repo: string): GhPr[] {
  // Fixed argv, no shell. --repo is always passed: plain gh may target the upstream.
  const raw = execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', FIELDS], { encoding: 'utf8' })
  return JSON.parse(raw) as GhPr[]
}

if (require.main === module) {
  const repo = process.argv[2] ?? 'j0hn-42/agent-lens'
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.startsWith('patoles/')) {
    console.error(`refusing repo "${repo}": use owner/name of the fork, never the upstream`)
    process.exit(2)
  }
  process.stdout.write(renderReport(fetchOpenPrs(repo)))
}
