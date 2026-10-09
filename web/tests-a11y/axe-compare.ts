/** Pure helpers: compare axe results with the allow-list of known violations. */

export interface KnownViolation {
  scenario: string
  rule: string
  /** GitHub issue that will fix it */
  issue: number
  note?: string
}

export interface Comparison {
  /** Violations that are neither allow-listed nor fixed: the test must fail */
  unexpected: string[]
  /** Allow-listed violations that no longer occur: remove them from known-violations.json */
  stale: string[]
}

/** `found` is the list of rule ids axe reported for `scenario`. */
export function compareViolations(scenario: string, found: readonly string[], known: readonly KnownViolation[]): Comparison {
  const allowed = new Set(known.filter(k => k.scenario === scenario).map(k => k.rule))
  const seen = new Set(found)
  return {
    unexpected: [...seen].filter(r => !allowed.has(r)).sort(),
    stale: [...allowed].filter(r => !seen.has(r)).sort(),
  }
}

/** Issues a baseline entry may cite: the hand-maintained list of OPEN issues (open-baseline-issues.json). */
export function checkOpenIssue(issue: number, open: readonly number[] | undefined): string | null {
  return open && Number.isInteger(issue) && issue > 0 && !open.includes(issue)
    ? `issue #${issue} is not in open-baseline-issues.json (closed, or not listed): reopen it, file a new open issue, or remove the entry`
    : null
}

/**
 * Every entry must carry a scenario, a rule and a positive issue number. When `openIssues`
 * is given, the issue must also be one of the open issues.
 */
export function validateKnownViolations(known: readonly KnownViolation[], openIssues?: readonly number[]): string[] {
  const errors: string[] = []
  const keys = new Set<string>()
  known.forEach((k, i) => {
    if (!k.scenario || !k.rule) errors.push(`entry ${i}: scenario and rule are required`)
    if (!Number.isInteger(k.issue) || k.issue <= 0) errors.push(`entry ${i}: issue must be a positive integer`)
    const closed = checkOpenIssue(k.issue, openIssues)
    if (closed) errors.push(`entry ${i}: ${closed}`)
    const key = `${k.scenario}::${k.rule}`
    if (keys.has(key)) errors.push(`entry ${i}: duplicate ${key}`)
    keys.add(key)
  })
  return errors
}
