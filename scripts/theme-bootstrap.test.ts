import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { themeBootstrapScript, THEME_STORAGE_KEY, DEFAULT_THEME, THEME_IDS } from '../extension/src/theme-bootstrap'

interface Env {
  stored?: string | null
  search?: string
  storageThrows?: boolean
  noBody?: boolean
  /** Host and system hints: they must NOT influence the result any more */
  bodyClass?: string
  systemDark?: boolean
}

/** Minimal DOM: just what the bootstrap touches. */
function run(env: Env = {}) {
  const classes = new Set<string>(['dark'])
  const root = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    classList: { toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c) } },
  }
  const sandbox = {
    document: { documentElement: root, body: env.noBody ? null : { className: env.bodyClass ?? '', getAttribute: () => null } },
    location: { search: env.search ?? '' },
    URLSearchParams,
    localStorage: {
      getItem: (k: string) => { if (env.storageThrows) throw new Error('denied'); return k === THEME_STORAGE_KEY ? env.stored ?? null : null },
    },
    matchMedia: () => ({ matches: env.systemDark ?? true, addEventListener: () => {} }),
  }
  vm.runInNewContext(themeBootstrapScript(), sandbox)
  return { root, classes }
}

test('theme: graphite is the default when nothing is stored or given', () => {
  assert.equal(DEFAULT_THEME, 'graphite')
  const r = run()
  assert.equal(r.root.dataset.theme, 'graphite')
  assert.equal(r.root.style.colorScheme, 'dark')
  assert.equal(r.classes.has('dark'), true)
})

test('theme: the system preference and the VS Code host mode no longer pick the theme', () => {
  assert.equal(run({ systemDark: false }).root.dataset.theme, 'graphite')
  assert.equal(run({ bodyClass: 'vscode-light', systemDark: false }).root.dataset.theme, 'graphite')
})

test('theme: the three ids are accepted from storage and from the URL parameter', () => {
  assert.deepEqual([...THEME_IDS], ['neon', 'graphite', 'paper'])
  for (const id of THEME_IDS) {
    assert.equal(run({ stored: id }).root.dataset.theme, id)
    assert.equal(run({ search: `?theme=${id}` }).root.dataset.theme, id)
  }
})

test('theme: neon and graphite stay dark, paper is light (dark class and color-scheme)', () => {
  for (const id of ['neon', 'graphite'] as const) {
    const r = run({ stored: id })
    assert.equal(r.classes.has('dark'), true, id)
    assert.equal(r.root.style.colorScheme, 'dark', id)
  }
  const p = run({ stored: 'paper' })
  assert.equal(p.classes.has('dark'), false)
  assert.equal(p.root.style.colorScheme, 'light')
})

test('theme: stored choice wins over the URL parameter', () => {
  assert.equal(run({ stored: 'paper', search: '?theme=neon' }).root.dataset.theme, 'paper')
})

test('theme: the URL parameter is used when nothing is stored', () => {
  assert.equal(run({ search: '?theme=neon' }).root.dataset.theme, 'neon')
})

test('theme: values stored by earlier versions still work (dark -> graphite, light -> paper)', () => {
  assert.equal(run({ stored: 'dark' }).root.dataset.theme, 'graphite')
  assert.equal(run({ stored: 'light' }).root.dataset.theme, 'paper')
  assert.equal(run({ search: '?theme=dark' }).root.dataset.theme, 'graphite')
  assert.equal(run({ search: '?theme=light' }).root.dataset.theme, 'paper')
})

test('theme: invalid stored or parameter values are ignored, not trusted', () => {
  assert.equal(run({ stored: 'purple', search: '?theme=<script>' }).root.dataset.theme, 'graphite')
  assert.equal(run({ stored: 'purple', search: '?theme=neon' }).root.dataset.theme, 'neon', 'an invalid stored value falls through to the parameter')
})

test('theme: unreadable storage (privacy mode) falls through instead of throwing', () => {
  assert.equal(run({ storageThrows: true }).root.dataset.theme, 'graphite')
  assert.equal(run({ storageThrows: true, search: '?theme=paper' }).root.dataset.theme, 'paper')
})

test('theme: works before <body> exists (script in head) without throwing', () => {
  assert.equal(run({ noBody: true, stored: 'neon' }).root.dataset.theme, 'neon')
})

test('theme: the script is self-contained text, safe to inline in an HTML shell', () => {
  const s = themeBootstrapScript()
  assert.ok(!s.includes('${'))
  assert.ok(!s.toLowerCase().includes('</script'))
})
