// #534: the REAL standalone bundle (web/vite.config.app.ts) must load in a browser, where `process` does not exist.
// A module-level `process.env.X` that the config does not define throws "ReferenceError: process is not defined"
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

let outDir = ''
let bundle = ''

before(() => {
  outDir = mkdtempSync(join(tmpdir(), 'agent-lens-bundle-'))
  execFileSync('npx', ['vite', 'build', '--config', 'vite.config.app.ts', '--outDir', outDir, '--emptyOutDir'], {
    cwd: WEB,
    stdio: 'pipe',
    timeout: 240_000,
  })
  bundle = readFileSync(join(outDir, 'index.js'), 'utf8')
})

after(() => { if (outDir) rmSync(outDir, { recursive: true, force: true }) })

test('the standalone bundle loads in a browser without error and consumes the #pair= fragment (#517)', async () => {
  // jsdom lives in web/ only: loaded from there, typed by what this test uses.
  const { JSDOM, VirtualConsole } = requireWeb('jsdom') as {
    JSDOM: new (html: string, options: object) => { window: { close: () => void } }
    VirtualConsole: new () => { on: (event: string, listener: (e: Error) => void) => void }
  }
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (e: Error) => errors.push(String(e.message)))
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: `http://127.0.0.1:3000/#pair=${TOKEN}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  })
  const win = dom.window as unknown as Record<string, unknown> & { eval: (code: string) => unknown; location: Location }
  assert.equal(typeof win.process, 'undefined', 'a browser has no process')
  const posted: string[] = []
  win.fetch = async (input: unknown) => { posted.push(String(input)); return { status: 204, ok: true, json: async () => ({}), text: async () => '' } }
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  win.EventSource = class { addEventListener() {} close() {} onerror = null; onmessage = null; onopen = null }

  assert.doesNotThrow(() => win.eval(bundle), 'loading the bundle must not throw (ReferenceError: process is not defined)')
  for (let i = 0; i < 50 && posted.length === 0; i++) await new Promise((r) => setTimeout(r, 20))

  assert.deepEqual(errors.filter((m) => /process is not defined/.test(m)), [])
  assert.equal(win.location.hash, '', 'the fragment leaves the address bar')
  assert.ok(posted.some((u) => u.endsWith('/pair')), 'the token is posted to /pair')
  dom.window.close()
})
