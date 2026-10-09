import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { themeBootstrapScript, THEME_STORAGE_KEY, DEFAULT_THEME, THEME_IDS, LEGACY_THEME_IDS } from '../extension/src/theme-bootstrap'

interface Env {
  stored?: string | null
  search?: string
  storageThrows?: boolean
  noBody?: boolean
  /** Start without the `dark` class on <html> */
  noDarkClass?: boolean
  /** Host and system hints: they must NOT influence the result any more */
  bodyClass?: string
  systemDark?: boolean
}

/** Minimal DOM: just what the bootstrap touches. */
function run(env: Env = {}) {
  const classes = new Set<string>(env.noDarkClass ? [] : ['dark'])
  const root = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => { classes.add(c) },
      toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c) },
    },
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

test('theme: macchiato is the default when nothing is stored or given', () => {
  assert.equal(DEFAULT_THEME, 'catppuccin-macchiato')
  const r = run()
  assert.equal(r.root.dataset.theme, 'catppuccin-macchiato')
  assert.equal(r.root.style.colorScheme, 'dark')
  assert.equal(r.classes.has('dark'), true)
})

test('theme: the system preference and the VS Code host mode no longer pick the theme', () => {
  assert.equal(run({ systemDark: false }).root.dataset.theme, 'catppuccin-macchiato')
  assert.equal(run({ bodyClass: 'vscode-light', systemDark: false }).root.dataset.theme, 'catppuccin-macchiato')
})

test('theme: the nine ids are accepted from storage and from the URL parameter', () => {
  assert.deepEqual([...THEME_IDS], ['catppuccin-macchiato', 'catppuccin-mocha', 'catppuccin-frappe', 'midnight', 'graphite', 'neon', 'ember', 'anthropic', 'contrast'])
  for (const id of THEME_IDS) {
    assert.equal(run({ stored: id }).root.dataset.theme, id)
    assert.equal(run({ search: `?theme=${id}` }).root.dataset.theme, id)
  }
})

test('theme: every theme is dark (dark class and color-scheme), even if the class was missing', () => {
  for (const id of THEME_IDS) {
    const r = run({ stored: id })
    assert.equal(r.classes.has('dark'), true, id)
    assert.equal(r.root.style.colorScheme, 'dark', id)
  }
  const bare = run({ stored: 'catppuccin-macchiato', noDarkClass: true })
  assert.equal(bare.classes.has('dark'), true)
})

test('theme: stored choice wins over the URL parameter', () => {
  assert.equal(run({ stored: 'ember', search: '?theme=neon' }).root.dataset.theme, 'ember')
  assert.equal(run({ stored: 'paper', search: '?theme=neon' }).root.dataset.theme, 'catppuccin-macchiato', 'a migrated stored value still wins')
})

test('theme: the URL parameter is used when nothing is stored', () => {
  assert.equal(run({ search: '?theme=neon' }).root.dataset.theme, 'neon')
})

test('theme: values stored by earlier versions migrate to catppuccin-macchiato (dark, light and the removed paper); a stored graphite stays graphite', () => {
  for (const old of ['dark', 'light', 'paper']) {
    const r = run({ stored: old, systemDark: false, bodyClass: 'vscode-light' })
    assert.equal(r.root.dataset.theme, 'catppuccin-macchiato', `stored ${old}`)
    assert.equal(r.root.style.colorScheme, 'dark', `stored ${old}`)
    assert.equal(r.classes.has('dark'), true, `stored ${old}`)
    assert.equal(run({ search: `?theme=${old}` }).root.dataset.theme, 'catppuccin-macchiato', `?theme=${old}`)
  }
  assert.deepEqual([...LEGACY_THEME_IDS], ['dark', 'light', 'paper'])
  assert.equal(run({ stored: 'graphite' }).root.dataset.theme, 'graphite', 'graphite is a real theme: it is kept')
  assert.equal(run({ search: '?theme=graphite' }).root.dataset.theme, 'graphite')
})

test('theme: an unknown stored value (matching is case-sensitive) falls through to the URL parameter', () => {
  assert.equal(run({ stored: 'Paper', search: '?theme=catppuccin-macchiato' }).root.dataset.theme, 'catppuccin-macchiato', 'case-sensitive: an unknown value falls through')
})

test('theme: invalid stored or parameter values are ignored, not trusted', () => {
  assert.equal(run({ stored: 'purple', search: '?theme=<script>' }).root.dataset.theme, 'catppuccin-macchiato')
  assert.equal(run({ stored: 'purple', search: '?theme=neon' }).root.dataset.theme, 'neon', 'an invalid stored value falls through to the parameter')
})

test('theme: unreadable storage (privacy mode) falls through instead of throwing', () => {
  assert.equal(run({ storageThrows: true }).root.dataset.theme, 'catppuccin-macchiato')
  assert.equal(run({ storageThrows: true, search: '?theme=contrast' }).root.dataset.theme, 'contrast')
})

test('theme: works before <body> exists (script in head) without throwing', () => {
  assert.equal(run({ noBody: true, stored: 'neon' }).root.dataset.theme, 'neon')
})

test('theme: the script is self-contained text, safe to inline in an HTML shell', () => {
  const s = themeBootstrapScript()
  assert.ok(!s.includes('${'))
  assert.ok(!s.toLowerCase().includes('</script'))
})
