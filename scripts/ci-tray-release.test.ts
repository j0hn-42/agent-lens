// Construction, signature et publication des binaires de barre système dans release.yml (#512). Le binaire avec
// interface n'existe pas encore : les jobs tray ne tournent que si son package main existe, la signature ne se fait
// que si tous les secrets d'une plateforme sont là (sinon le binaire est publié avec « -unsigned » dans son nom),
// et la release porte un SHA256SUMS vérifié. Ces tests lisent la structure du workflow ; aucun n'exécute GitHub Actions.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const ROOT = path.resolve(__dirname, '..')
const release = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')

function job(id: string): string {
  const m = release.match(new RegExp(`^  ${id}:\\n((?:(?:    .*|\\s*)\\n)*)`, 'm'))
  assert.ok(m, `release.yml defines the job ${id}`)
  return m[1]
}

/** The step whose `name:` is exactly `name`, up to the next step of the job. */
function step(jobText: string, name: string): string {
  const start = jobText.indexOf(`- name: ${name}\n`)
  assert.ok(start >= 0, `step "${name}" exists`)
  const rest = jobText.slice(start + 1)
  const next = rest.search(/^      - /m)
  return next < 0 ? rest : rest.slice(0, next)
}

const PKG = 'app-tray/native/cmd/agent-lens-tray'
const MAC_SECRETS = ['MACOS_CERTIFICATE_P12_BASE64', 'MACOS_CERTIFICATE_PASSWORD', 'MACOS_SIGNING_IDENTITY',
  'MACOS_NOTARY_APPLE_ID', 'MACOS_NOTARY_TEAM_ID', 'MACOS_NOTARY_PASSWORD']
const WIN_SECRETS = ['WINDOWS_CERTIFICATE_PFX_BASE64', 'WINDOWS_CERTIFICATE_PASSWORD']

test('tray-detect says whether the native binary package exists, and never fails without it (#512)', () => {
  const j = job('tray-detect')
  assert.match(j, /^    outputs:\n      present: \$\{\{ steps\.detect\.outputs\.present \}\}$/m)
  const s = step(j, 'Detect the native tray binary package')
  assert.match(s, /^\s+id: detect$/m)
  assert.ok(s.includes(`${PKG}/main.go`))
  assert.match(s, /present=true/)
  assert.match(s, /present=false/)
  assert.ok(!/secrets\./.test(j), 'no secret in the detection job')
})

test('tray-build runs only after the CI and only when the package exists, on the three desktops (#512)', () => {
  const j = job('tray-build')
  assert.match(j, /^    needs: \[ci, tray-detect\]$/m)
  assert.match(j, /^    if: github\.ref != 'refs\/heads\/develop' && needs\.tray-detect\.outputs\.present == 'true'$/m)
  assert.match(j, /^    runs-on: \$\{\{ matrix\.os \}\}$/m)
  for (const t of ['ubuntu-latest, goos: linux, goarch: amd64', 'macos-latest, goos: darwin, goarch: arm64',
    'windows-latest, goos: windows, goarch: amd64']) assert.ok(j.includes(t), t)
  assert.ok(!/^    permissions:/m.test(j), 'read-only contents, inherited from the workflow')
  const b = step(j, 'Build the tray binary')
  assert.ok(b.includes(`./cmd/agent-lens-tray`))
  assert.match(b, /^\s+working-directory: app-tray\/native$/m)
  assert.ok(!/secrets\./.test(b), 'the build sees no secret')
})

test('each signing step gets only its own platform secrets, through env, never inline in run (#512)', () => {
  const j = job('tray-build')
  const mac = step(j, 'Sign, verify and notarize (macOS)')
  const win = step(j, 'Sign and verify (Windows)')
  const lin = step(j, 'Label unsigned (Linux)')
  assert.match(mac, /^\s+if: runner\.os == 'macOS'$/m)
  assert.match(win, /^\s+if: runner\.os == 'Windows'$/m)
  assert.match(lin, /^\s+if: runner\.os == 'Linux'$/m)
  for (const s of MAC_SECRETS) {
    assert.ok(mac.includes(`${s}: \${{ secrets.${s} }}`), `macOS env ${s}`)
    assert.ok(!win.includes(s) && !lin.includes(s), `${s} only reaches the macOS step`)
  }
  for (const s of WIN_SECRETS) {
    assert.ok(win.includes(`${s}: \${{ secrets.${s} }}`), `Windows env ${s}`)
    assert.ok(!mac.includes(s) && !lin.includes(s), `${s} only reaches the Windows step`)
  }
  assert.ok(!/secrets\./.test(lin))
  for (const [s, platform] of [[mac, 'darwin'], [win, 'windows'], [lin, 'linux']] as const) {
    assert.ok(s.includes(`node app-tray/release/sign-tray.mjs --platform ${platform}`), platform)
    const run = s.slice(s.indexOf('run:'))
    assert.ok(!/secrets\./.test(run), 'no secret expanded in a run script')
    assert.ok(!/set -x|echo .*\$\{?(MACOS|WINDOWS)_/.test(run), 'no trace or echo of a secret')
  }
  // Only these two steps of the whole workflow see a secret (github.token aside)
  const withSecrets = release.split(/^(?=\s+- (?:name|uses):)/m).filter(s => /secrets\./.test(s))
  assert.equal(withSecrets.length, 2)
})

test('the tray artefacts uploaded are the labelled copies with their SHA256, never the raw build (#512)', () => {
  const j = job('tray-build')
  const u = step(j, 'Upload the tray binary')
  assert.match(u, /uses: actions\/upload-artifact@v4/)
  assert.match(u, /name: agent-lens-tray-\$\{\{ matrix\.goos \}\}-\$\{\{ matrix\.goarch \}\}/)
  assert.match(u, /^\s+path: dist-tray\/$/m)
  assert.match(u, /if-no-files-found: error/)
  assert.ok(j.indexOf('Upload the tray binary') > j.indexOf('Label unsigned (Linux)'))
})

test('the GitHub Release waits for the tray binaries when they exist, and goes without them otherwise (#512)', () => {
  const j = job('github-release')
  assert.match(j, /^    needs: \[package, tray-detect, tray-build\]$/m)
  const cond = j.match(/^    if: (.*)$/m)?.[1] ?? ''
  for (const part of ["github.ref_type == 'tag'", "needs.package.result == 'success'", "needs.tray-detect.result == 'success'",
    "needs.tray-build.result == 'success'", "needs.tray-build.result == 'skipped' && needs.tray-detect.outputs.present != 'true'"]) {
    assert.ok(cond.includes(part), part)
  }
  assert.ok(cond.startsWith('${{ !cancelled() &&'), 'evaluated even when tray-build was skipped')
  const dl = step(j, 'Download the tray binaries')
  assert.match(dl, /^\s+if: needs\.tray-detect\.outputs\.present == 'true'$/m)
  assert.match(dl, /pattern: agent-lens-tray-\*/)
  assert.match(dl, /merge-multiple: true/)
})

test('the release checks every tray checksum, then attaches a SHA256SUMS of every file it publishes (#512)', () => {
  const j = job('github-release')
  const c = step(j, 'Check the tray binaries checksums')
  assert.match(c, /^\s+if: needs\.tray-detect\.outputs\.present == 'true'$/m)
  assert.match(c, /set -eu/)
  assert.match(c, /sha256sum -c/)
  const r = step(j, 'Create the GitHub Release')
  assert.match(r, /set -eu/)
  assert.match(r, /sha256sum -- \* > SHA256SUMS/)
  assert.ok(r.indexOf('SHA256SUMS') < r.indexOf('gh release create'), 'the sums are computed before the upload')
  assert.ok(j.indexOf('Check the tray binaries checksums') < j.indexOf('Create the GitHub Release'))
})
