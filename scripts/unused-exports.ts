/**
 * Dead-export finder (#221). An export of web/lib, web/hooks, web/components or extension/src must be
 * referenced from another production file; a reference from a test does not count, because a model that only
 * tests execute is code the product never runs. Textual (word match), so it errs on the side of "used".
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..')
const SCOPES = ['web/lib', 'web/hooks', 'web/components']
/** Everything that ships or runs: production code outside the scopes included (pages, relay, scripts). */
const REFERENCE_ROOTS = ['web/app', 'web/lib', 'web/hooks', 'web/components', 'web/src', 'extension/src', 'app/src', 'scripts']
const SKIP_DIR = new Set(['node_modules', '.next', 'dist', 'out', 'fixtures', 'tests-a11y', 'tests-e2e', 'e2e'])
const TEST_FILE = /\.(test|spec)\.[tj]sx?$/

function walk(dir: string, out: string[] = []): string[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return out }
  for (const n of names) {
    if (SKIP_DIR.has(n)) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n) && !n.endsWith('.d.ts') && !TEST_FILE.test(n)) out.push(p)
  }
  return out
}

const DECL = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|enum)\s+([A-Za-z_$][\w$]*)/gm
const LIST = /^export\s*(?:type\s*)?\{([^}]*)\}(?!\s*from)/gm

export function exportedNames(src: string): string[] {
  const names = new Set<string>()
  for (const m of src.matchAll(DECL)) names.add(m[1])
  for (const m of src.matchAll(LIST)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().replace(/^type\s+/, '')
      const name = seg.split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  return [...names]
}

export interface UnusedExport { file: string; name: string }

/** Exports of the scopes that no other production file mentions. `files` is injectable for tests. */
export function findUnusedExports(files?: Record<string, string>): UnusedExport[] {
  const sources: Record<string, string> = files ?? Object.fromEntries(
    [...new Set(REFERENCE_ROOTS.flatMap(r => walk(join(ROOT, r))))].map(f => [relative(ROOT, f), readFileSync(f, 'utf8')]))
  const inScope = (f: string) => SCOPES.some(s => f.startsWith(s + '/'))
  const unused: UnusedExport[] = []
  for (const [file, src] of Object.entries(sources)) {
    if (!inScope(file)) continue
    for (const name of exportedNames(src)) {
      const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`)
      const used = Object.entries(sources).some(([f, s]) => f !== file && re.test(s))
      if (!used) unused.push({ file, name })
    }
  }
  return unused.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))
}
