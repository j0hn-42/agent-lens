import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { themeBootstrapScript, THEME_STORAGE_KEY, LIGHT_PALETTE_AVAILABLE } from '../extension/src/theme-bootstrap'

interface Env {
  stored?: string | null
  search?: string
  bodyClass?: string
  vscodeKind?: string
  systemDark?: boolean
  storageThrows?: boolean
  noBody?: boolean
  lightPalette?: boolean
}

/** Minimal DOM: just what the bootstrap touches. Returns hooks to fire host / system changes. */
function run(env: Env = {}) {
  // precedence tests run with the light palette on; the default (clamp to dark) has its own test below
  const lightPalette = env.lightPalette ?? true
  const classes = new Set<string>(['dark'])
  const root = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    classList: { toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c) } },
  }
  let observerCb: (() => void) | null = null
  const body = {
    className: env.bodyClass ?? '',
    getAttribute: (n: string) => (n === 'data-vscode-theme-kind' ? env.vscodeKind ?? null : null),
  }
  let mqlCb: (() => void) | null = null
  const sandbox = {
    document: { documentElement: root, body: env.noBody ? null : body },
    location: { search: env.search ?? '' },
    URLSearchParams,
    localStorage: {
      getItem: (k: string) => { if (env.storageThrows) throw new Error('denied'); return k === THEME_STORAGE_KEY ? env.stored ?? null : null },
    },
    matchMedia: () => ({ matches: env.systemDark ?? true, addEventListener: (_: string, cb: () => void) => { mqlCb = cb } }),
    MutationObserver: class { constructor(cb: () => void) { observerCb = cb } observe() {} },
  }
  vm.runInNewContext(themeBootstrapScript(lightPalette), sandbox)
  return {
    root, classes,
    hostChanged(patch: { bodyClass?: string; vscodeKind?: string }) {
      if (patch.bodyClass !== undefined) body.className = patch.bodyClass
      if (patch.vscodeKind !== undefined) env.vscodeKind = patch.vscodeKind
      observerCb?.()
    },
    systemChanged(dark: boolean) { env.systemDark = dark; mqlCb?.() },
  }
}

test('theme: default with nothing set follows the system preference', () => {
  assert.equal(run({ systemDark: true }).root.dataset.theme, 'dark')
  assert.equal(run({ systemDark: false }).root.dataset.theme, 'light')
})

test('theme: stored choice wins over parameter, host and system', () => {
  const r = run({ stored: 'light', search: '?theme=dark', bodyClass: 'vscode-dark', systemDark: true })
  assert.equal(r.root.dataset.theme, 'light')
  assert.equal(r.root.style.colorScheme, 'light')
  assert.equal(r.classes.has('dark'), false)
})

test('theme: the URL parameter wins over host and system', () => {
  assert.equal(run({ search: '?theme=light', bodyClass: 'vscode-dark', systemDark: true }).root.dataset.theme, 'light')
})

test('theme: invalid stored or parameter values are ignored, not trusted', () => {
  assert.equal(run({ stored: 'purple', search: '?theme=<script>', systemDark: false }).root.dataset.theme, 'light')
})

test('theme: host mode (VS Code body class or data attribute) wins over the system', () => {
  assert.equal(run({ bodyClass: 'vscode-light', systemDark: true }).root.dataset.theme, 'light')
  assert.equal(run({ bodyClass: 'vscode-dark', systemDark: false }).root.dataset.theme, 'dark')
  assert.equal(run({ vscodeKind: 'vscode-light', systemDark: true }).root.dataset.theme, 'light')
  assert.equal(run({ bodyClass: 'vscode-high-contrast-light', systemDark: true }).root.dataset.theme, 'light')
  assert.equal(run({ bodyClass: 'vscode-high-contrast', systemDark: false }).root.dataset.theme, 'dark')
})

test('theme: unreadable storage (privacy mode) falls through instead of throwing', () => {
  assert.equal(run({ storageThrows: true, systemDark: false }).root.dataset.theme, 'light')
})

test('theme: tracks the host after load when nothing overrides it', () => {
  const r = run({ bodyClass: 'vscode-dark' })
  assert.equal(r.root.dataset.theme, 'dark')
  r.hostChanged({ bodyClass: 'vscode-light' })
  assert.equal(r.root.dataset.theme, 'light')
  assert.equal(r.classes.has('dark'), false)
  r.hostChanged({ bodyClass: 'vscode-high-contrast' })
  assert.equal(r.classes.has('dark'), true)
})

test('theme: tracks the system preference when the host gives no hint', () => {
  const r = run({ systemDark: true })
  r.systemChanged(false)
  assert.equal(r.root.dataset.theme, 'light')
})

test('theme: an explicit stored choice is not overridden by later host changes', () => {
  const r = run({ stored: 'dark', bodyClass: 'vscode-dark' })
  r.hostChanged({ bodyClass: 'vscode-light' })
  assert.equal(r.root.dataset.theme, 'dark')
})

test('theme: works before <body> exists (script in head) without throwing', () => {
  assert.equal(run({ noBody: true, systemDark: false }).root.dataset.theme, 'light')
})

test('theme: the script is self-contained text, safe to inline in an HTML shell', () => {
  const s = themeBootstrapScript()
  assert.ok(!s.includes('${'))
  assert.ok(!s.toLowerCase().includes('</script'))
})

test('theme: no light palette ships, so any light request (stored, parameter, host, system) resolves to dark', () => {
  assert.equal(LIGHT_PALETTE_AVAILABLE, false)
  assert.match(themeBootstrapScript(), /!false\)/, 'the shipped script clamps')
  for (const env of [{ stored: 'light' }, { search: '?theme=light' }, { bodyClass: 'vscode-light' }, { systemDark: false }]) {
    const r = run({ ...env, lightPalette: LIGHT_PALETTE_AVAILABLE })
    assert.equal(r.root.dataset.theme, 'dark')
    assert.equal(r.root.style.colorScheme, 'dark')
    assert.equal(r.classes.has('dark'), true, 'the dark class is never removed')
  }
})
