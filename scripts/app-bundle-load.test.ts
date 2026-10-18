// #534: the REAL bundles (standalone: web/vite.config.app.ts, VS Code webview: web/vite.config.webview.ts) must load in a
// browser, where `process` does not exist. A module-level `process.env.X` that the config does not define throws "ReferenceError: process is not defined"
// before React starts, so the pairing of #517 (pairFromFragment) never ran and the #pair= fragment stayed in the bar.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const WEB = resolve(__dirname, '..', 'web')
const requireWeb = createRequire(join(WEB, 'package.json'))
const TOKEN = 'A'.repeat(43)

interface Target { name: string; config: string; entry: string }
const TARGETS: Target[] = [
  { name: 'standalone', config: 'vite.config.app.ts', entry: 'app-entry' },
  { name: 'webview', config: 'vite.config.webview.ts', entry: 'webview-entry' },
]

const outDirs: string[] = []
const bundles = new Map<string, string>()

before(() => {
  for (const t of TARGETS) {
    const outDir = mkdtempSync(join(tmpdir(), `agent-lens-bundle-${t.name}-`))
    outDirs.push(outDir)
    execFileSync('npx', ['vite', 'build', '--config', t.config, '--outDir', outDir, '--emptyOutDir'], {
      cwd: WEB,
      stdio: 'pipe',
      timeout: 240_000,
    })
    bundles.set(t.name, readFileSync(join(outDir, 'index.js'), 'utf8'))
  }
})

after(() => { for (const d of outDirs) rmSync(d, { recursive: true, force: true }) })

for (const t of TARGETS) {
  // The webview swallows a missing define behind a try/catch (mock-scenario.ts), so the load alone cannot show it:
  // no `process.env.X` read may be left in the bundle, the config must define every variable the code reads.
  test(`the ${t.name} bundle leaves no process.env read to the browser (#534)`, () => {
    const left = [...new Set(bundles.get(t.name)!.match(/process\.env\.[A-Za-z0-9_]+/g) ?? [])]
    assert.deepEqual(left, [], `${t.config} must define: ${left.join(', ')}`)
  })

  test(`the ${t.name} bundle loads in a browser without any error (#517, #534)`, async (ctx) => {
    // jsdom lives in web/ only: loaded from there, typed by what this test uses.
    const { JSDOM, VirtualConsole } = requireWeb('jsdom') as {
      JSDOM: new (html: string, options: object) => { window: { close: () => void } }
      VirtualConsole: new () => { on: (event: string, listener: (e: Error) => void) => void }
    }
    const errors: string[] = []
    const virtualConsole = new VirtualConsole()
    virtualConsole.on('jsdomError', (e: Error) => errors.push(String(e.message)))
    const standalone = t.name === 'standalone'
    const dom = new JSDOM('<!doctype html><div id="root"></div>', {
      url: `http://127.0.0.1:3000/${standalone ? `#pair=${TOKEN}` : ''}`,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole,
    })
    // Also on a failed assertion: an open window keeps its timers alive and the process never exits
    ctx.after(() => dom.window.close())
    const win = dom.window as unknown as Record<string, unknown> & { eval: (code: string) => unknown; location: Location }
    assert.equal(typeof win.process, 'undefined', 'a browser has no process')
    const posted: string[] = []
    const vscodeMessages: unknown[] = []
    win.fetch = async (input: unknown) => { posted.push(String(input)); return { status: 204, ok: true, json: async () => ({}), text: async () => '' } }
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
    win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
    win.EventSource = class { addEventListener() {} close() {} onerror = null; onmessage = null; onopen = null }
    // jsdom has no canvas: the webview (demo mode) draws at load. A null context is what a browser without canvas gives.
    ;(win.HTMLCanvasElement as { prototype: { getContext: () => null } }).prototype.getContext = () => null
    // The VS Code host provides this global; the webview entry calls it at load
    win.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => { vscodeMessages.push(m) } })

    assert.doesNotThrow(() => win.eval(bundles.get(t.name)!), 'loading the bundle must not throw (ReferenceError: process is not defined)')
    if (standalone) for (let i = 0; i < 50 && posted.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    else await new Promise((r) => setTimeout(r, 200))

    assert.deepEqual(errors, [], 'no load error at all, not only "process is not defined"')
    if (standalone) {
      assert.equal(win.location.hash, '', 'the fragment leaves the address bar')
      assert.ok(posted.some((u) => u.endsWith('/pair')), 'the token is posted to /pair')
    } else {
      assert.ok(vscodeMessages.some((m) => (m as { type?: string }).type === 'ready'), 'the webview tells the host it is ready')
    }
  })
}
