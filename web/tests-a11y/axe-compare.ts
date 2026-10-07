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

/** Every entry must carry a scenario, a rule and a positive issue number. */
export function validateKnownViolations(known: readonly KnownViolation[]): string[] {
  const errors: string[] = []
  const keys = new Set<string>()
  known.forEach((k, i) => {
    if (!k.scenario || !k.rule) errors.push(`entry ${i}: scenario and rule are required`)
    if (!Number.isInteger(k.issue) || k.issue <= 0) errors.push(`entry ${i}: issue must be a positive integer`)
    const key = `${k.scenario}::${k.rule}`
    if (keys.has(key)) errors.push(`entry ${i}: duplicate ${key}`)
    keys.add(key)
  })
  return errors
}
