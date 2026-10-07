/** Pure helpers: compare jsx-a11y lint results with the per-violation baseline. */

export interface LintBaselineEntry {
  /** Path relative to web/, forward slashes */
  file: string
  /** Full rule id, e.g. jsx-a11y/no-noninteractive-tabindex */
  rule: string
  /** Exact number of violations of `rule` in `file` that are tolerated */
  count: number
  /** GitHub issue that will fix it */
  issue: number
  note?: string
}

export interface LintFinding {
  file: string
  rule: string
}

export interface LintComparison {
  /** More violations than the baseline allows (or none allowed at all): fix them */
  unexpected: string[]
  /** Fewer violations than the baseline lists: lower or remove the entry */
  stale: string[]
}

const key = (file: string, rule: string) => `${file}::${rule}`

export function countFindings(findings: readonly LintFinding[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const f of findings) counts.set(key(f.file, f.rule), (counts.get(key(f.file, f.rule)) ?? 0) + 1)
  return counts
}

export function compareLint(findings: readonly LintFinding[], baseline: readonly LintBaselineEntry[]): LintComparison {
  const found = countFindings(findings)
  const allowed = new Map(baseline.map(e => [key(e.file, e.rule), e.count] as const))
  const unexpected: string[] = []
  const stale: string[] = []
  for (const [k, n] of found) {
    const a = allowed.get(k) ?? 0
    if (n > a) unexpected.push(`${k}: ${n} found, ${a} allowed`)
  }
  for (const [k, a] of allowed) {
    const n = found.get(k) ?? 0
    if (n < a) stale.push(`${k}: ${n} found, ${a} listed`)
  }
  return { unexpected: unexpected.sort(), stale: stale.sort() }
}

export function validateLintBaseline(baseline: readonly LintBaselineEntry[]): string[] {
  const errors: string[] = []
  const keys = new Set<string>()
  baseline.forEach((e, i) => {
    if (!e.file || !e.rule) errors.push(`entry ${i}: file and rule are required`)
    if (!Number.isInteger(e.count) || e.count <= 0) errors.push(`entry ${i}: count must be a positive integer`)
    if (!Number.isInteger(e.issue) || e.issue <= 0) errors.push(`entry ${i}: issue must be a positive integer`)
    if (keys.has(key(e.file, e.rule))) errors.push(`entry ${i}: duplicate ${key(e.file, e.rule)}`)
    keys.add(key(e.file, e.rule))
  })
  return errors
}

/**
 * Next baseline after a fix or a new violation: keeps the issue and note of surviving
 * entries and drops entries that no longer occur. New (file, rule) pairs get `newIssue`
 * (0 when unknown, which validateLintBaseline rejects until a human fills it in).
 */
export function rebuildBaseline(
  findings: readonly LintFinding[],
  previous: readonly LintBaselineEntry[],
  newIssue = 0,
): LintBaselineEntry[] {
  const prev = new Map(previous.map(e => [key(e.file, e.rule), e] as const))
  return [...countFindings(findings)]
    .map(([k, count]) => {
      const [file, rule] = k.split('::')
      const old = prev.get(k)
      return { file, rule, count, issue: old?.issue ?? newIssue, ...(old?.note ? { note: old.note } : {}) }
    })
    .sort((a, b) => key(a.file, a.rule).localeCompare(key(b.file, b.rule)))
}
