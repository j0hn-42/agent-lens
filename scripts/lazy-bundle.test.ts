// #662: what the first screen does not need is loaded on demand. The bundler only splits what no static import reaches,
// so these tests read the static import graph from every entry point (Next page, webview, standalone app) and check
// that the language not shown, the demo scenarios, the dialogs, the legend panel and the tour are outside it.
// Pure node:test, no build: the measured sizes are in the pull request.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LOCALE, LOCALES, isLocaleLoaded, loadLocale, translate, type Locale } from '../web/lib/messages'
import { MESSAGE_DOMAINS } from '../web/lib/messages/domains'

const WEB = path.join(__dirname, '..', 'web')
const rel = (p: string) => path.relative(WEB, p).split(path.sep).join('/')

/** The file a specifier names, or null for a package (react, next/dynamic): '@/x', './x', '../x', with or without extension */
function resolveSpecifier(from: string, spec: string): string | null {
  const bare = spec.replace(/\?.*$/, '')
  let base: string
  if (bare.startsWith('@/')) base = path.join(WEB, bare.slice(2))
  else if (bare.startsWith('.')) base = path.resolve(path.dirname(from), bare)
  else return null
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

/** Static value imports of a source file: `import type` and `import()` are left out, they are not in the eager bundle */
function staticImports(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8')
  const out: string[] = []
  const re = /^\s*(import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/gm
  for (const m of src.matchAll(re)) {
    if (m[2]) continue
    // `import { type A, type B } from` is erased as well
    const clause = m[0].replace(/from\s+['"][^'"]+['"]$/, '')
    const names = clause.match(/\{([^}]*)\}/)?.[1]
    if (names && !/(^|\s)import\s+[\w$]+\s*,/.test(clause) && names.split(',').every(n => !n.trim() || /^type\s/.test(n.trim()))) continue
    const target = resolveSpecifier(file, m[3])
    if (target && /\.(ts|tsx)$/.test(target)) out.push(target)
  }
  return out
}

function eagerGraph(entry: string): Set<string> {
  const seen = new Set<string>()
  const stack = [path.join(WEB, entry)]
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    stack.push(...staticImports(f))
  }
  return new Set([...seen].map(rel))
}

/** The modules #662 takes out of the first load */
const ON_DEMAND = [
  'lib/messages/locales/fr.ts',
  'lib/mock-scenario.ts',
  'lib/tour-scenario.ts',
  'lib/guided-scenario.ts',
  'lib/stress-test-scenario.ts',
  'components/agent-visualizer/settings-dialog.tsx',
  'components/agent-visualizer/command-palette.tsx',
  'components/agent-visualizer/shortcuts-dialog.tsx',
  'components/agent-visualizer/legend-panel.tsx',
  'components/agent-visualizer/guided-tour-card.tsx',
  'components/agent-visualizer/tour-highlight.tsx',
]

const ENTRIES = ['app/page.tsx', 'webview-entry.tsx', 'app-entry.tsx']

for (const entry of ENTRIES) {
  test(`${entry}: no static import reaches what is loaded on demand (#662)`, () => {
    const graph = eagerGraph(entry)
    assert.ok(graph.size > 1, `${entry} imports something`)
    for (const m of ON_DEMAND) {
      assert.ok(fs.existsSync(path.join(WEB, m)), `${m} exists`)
      assert.ok(!graph.has(m), `${m} is statically reachable from ${entry}`)
    }
  })
}

test('the Next page renders the visualizer on the client only, once the boot data is loaded (#662)', () => {
  const graph = eagerGraph('app/page.tsx')
  assert.ok(!graph.has('components/agent-visualizer/index.tsx'), 'the visualizer is a chunk of its own on the Next page')
  const client = fs.readFileSync(path.join(WEB, 'app', 'visualizer-client.tsx'), 'utf8')
  // A state, not Suspense: React 19 holds a Suspense reveal for 300 ms, next/dynamic would delay the first paint by that
  assert.match(client, /lazyComponent</)
  assert.doesNotMatch(client, /from 'next\/dynamic'/)
  assert.match(client, /import\('@\/components\/agent-visualizer'\)/)
  assert.match(client, /prepareBoot\(\)/)
})

for (const entry of ['webview-entry.tsx', 'app-entry.tsx']) {
  test(`${entry} renders once the boot data is loaded, so the first paint is in the right language (#662)`, () => {
    const src = fs.readFileSync(path.join(WEB, entry), 'utf8')
    assert.match(src, /prepareBoot\(\)/)
    assert.ok(src.indexOf('prepareBoot()') < src.indexOf('root.render('), 'prepareBoot comes before the render')
  })
}

test('the default locale is in the first load, the other one is not loaded until asked (#662)', async () => {
  assert.equal(isLocaleLoaded(DEFAULT_LOCALE), true)
  const other = LOCALES.find(l => l !== DEFAULT_LOCALE) as Locale
  assert.equal(isLocaleLoaded(other), false)
  // Not loaded: the default text, never a key and never a crash
  assert.equal(translate(other, 'tray.open'), translate(DEFAULT_LOCALE, 'tray.open'))
  await loadLocale(other)
  assert.equal(isLocaleLoaded(other), true)
  assert.notEqual(translate(other, 'tray.open'), translate(DEFAULT_LOCALE, 'tray.open'))
  await loadLocale(other) // idempotent
})

test('each locale table is every domain of domains.ts, in that language only (#662)', async () => {
  for (const l of LOCALES) {
    const mod = await import(`../web/lib/messages/locales/${l}`) as { TABLE: Record<string, string> }
    const expected = Object.assign({}, ...Object.values(MESSAGE_DOMAINS).map(d => d[l]))
    assert.deepEqual(mod.TABLE, expected, `locales/${l}.ts assembles every domain of domains.ts`)
    // Each domain is imported with the query of its language: the bundler keeps one instance per language, with that table only
    const src = fs.readFileSync(path.join(WEB, 'lib', 'messages', 'locales', `${l}.ts`), 'utf8')
    for (const name of Object.keys(MESSAGE_DOMAINS)) {
      assert.ok(src.includes(`'../${name}?locale=${l}'`), `locales/${l}.ts imports ../${name}?locale=${l}`)
    }
    for (const other of LOCALES.filter(o => o !== l)) assert.ok(!src.includes(`?locale=${other}`), `locales/${l}.ts names no ${other} module`)
  }
})

test('the effective locale is the wanted one only once its table is loaded: lang and text never disagree (#662)', async () => {
  const { effectiveLocale } = await import('../web/lib/messages')
  assert.equal(effectiveLocale(DEFAULT_LOCALE), DEFAULT_LOCALE)
  for (const l of LOCALES) assert.equal(effectiveLocale(l), isLocaleLoaded(l) ? l : DEFAULT_LOCALE)
  assert.equal(effectiveLocale('xx' as Locale), DEFAULT_LOCALE)
})

test('the demo scenario is empty until loaded, then the one mock-scenario.ts builds (#662)', async () => {
  const demo = await import('../web/lib/demo-scenario')
  assert.equal(demo.isMockScenarioLoaded(), false)
  assert.deepEqual(demo.getMockScenario(), [])
  assert.equal(demo.mockDuration(), 0)
  assert.deepEqual(demo.mockSessions(), [])
  await demo.loadMockScenario()
  const data = await import('../web/lib/mock-scenario')
  assert.equal(demo.isMockScenarioLoaded(), true)
  assert.equal(demo.getMockScenario(), data.MOCK_SCENARIO)
  assert.equal(demo.mockDuration(), data.MOCK_DURATION)
  assert.ok(demo.mockDuration() > 0)
})

test('the scenario name and the stress levels are read without loading the scenarios (#662)', async () => {
  const demo = await import('../web/lib/demo-scenario')
  const { STRESS_SCENARIOS } = await import('../web/lib/stress-test-scenario')
  const g = globalThis as { window?: unknown }
  const saved = g.window
  try {
    for (const level of [...Object.keys(STRESS_SCENARIOS), 'bogus']) {
      g.window = { location: { search: `?stress=${level}&scenario=tour` } }
      assert.equal(demo.getStressLevel(), level === 'bogus' ? null : level, `?stress=${level}`)
      assert.equal(demo.getScenarioName(), 'tour')
    }
  } finally { g.window = saved }
  const src = fs.readFileSync(path.join(WEB, 'lib', 'demo-scenario.ts'), 'utf8')
  assert.ok(!/^import\s+(?!type)[^\n]*from '\.\/(mock|tour|guided|stress-test)-scenario'/m.test(src), 'demo-scenario.ts only imports the scenarios on demand')
})
