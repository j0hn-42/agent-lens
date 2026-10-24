// Compilation croisée du module Go du binaire de menu (#511). Il n'existe pas encore de package main (le binaire
// natif avec interface n'est pas dans le dépôt) : la CI prouve seulement que le module compile et passe go vet pour
// les trois cibles, en Go pur, sans artefact. Les étapes vivent dans le job `test` pour ne pas toucher aux noms de
// checks exigés par la protection de branche (test, e2e-a11y).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const ROOT = path.resolve(__dirname, '..')
const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')

function job(id: string): string {
  const m = ci.match(new RegExp(`^  ${id}:\\n((?:(?:    .*|\\s*)\\n)*)`, 'm'))
  assert.ok(m, `ci.yml defines the job ${id}`)
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

const STEP = 'Tray protocol module cross-build (linux/amd64, darwin/arm64, windows/amd64)'

test('the test job builds and vets the tray Go module for the three desktop targets (#511)', () => {
  const s = step(job('test'), STEP)
  assert.match(s, /^\s+if: \$\{\{ !cancelled\(\) \}\}$/m)
  assert.match(s, /^\s+working-directory: app-tray\/native$/m)
  assert.match(s, /^\s+CGO_ENABLED: "0"$/m, 'pure Go: no C toolchain per target')
  for (const target of ['linux/amd64', 'darwin/arm64', 'windows/amd64']) {
    assert.ok(s.includes(target), `target ${target}`)
  }
  assert.match(s, /GOOS="\$\{target%\/\*\}" GOARCH="\$\{target#\*\/\}" go build \.\/\.\.\./)
  assert.match(s, /GOOS="\$\{target%\/\*\}" GOARCH="\$\{target#\*\/\}" go vet \.\/\.\.\./)
  assert.match(s, /set -eu/, 'the first failing target fails the step')
})

/** A Go command that writes a binary: `-o` in any spelling (`-o x`, `-o=x`, `-o\tx`, `-o"x"`), or `go install`. */
const WRITES_BINARY = /(^|\s)-o(?![\w-])|\bgo install\b/m
const WORKFLOWS = fs.readdirSync(path.join(ROOT, '.github/workflows')).filter(f => /\.ya?ml$/.test(f))
  .map(f => ({ file: f, text: fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8') }))

test('the binary-output detector catches every spelling of -o, which the old guard missed (#613)', () => {
  for (const run of ['go build -o tray ./...', 'go build -o=tray ./...', 'go build -o\ttray ./...', 'go build -o"tray" ./...', 'go install ./...']) {
    assert.ok(WRITES_BINARY.test(run), run)
  }
  for (const run of ['go build ./...', 'go vet ./...', 'go test -count=1 ./...', 'echo "-- done"']) {
    assert.ok(!WRITES_BINARY.test(run), run)
  }
  // The guard before #613 (only the cross-build step, only "-o" followed by a space) let these through
  assert.ok(!/upload-artifact|-o /.test('go build -o=tray ./...'))
})

test('the cross-build publishes nothing and runs after setup-go (#511, #512)', () => {
  const t = job('test')
  const s = step(t, STEP)
  assert.ok(!/upload-artifact/.test(s) && !WRITES_BINARY.test(s), 'no binary is written or published: artefacts and signing are #512')
  assert.ok(t.indexOf('actions/setup-go@') < t.indexOf(STEP), 'Go comes from app-tray/native/go.mod')
})

/** The one job allowed to write a tray binary (#512): release.yml's tray-build, gated on the main package existing. */
const TRAY_BUILD = /^  tray-build:\n(?:(?:    .*|\s*)\n)*/m

test('only the release tray-build job writes a tray binary, and only when its main package exists (#512)', () => {
  const release = WORKFLOWS.find(w => w.file === 'release.yml')!.text
  const j = release.match(TRAY_BUILD)?.[0] ?? ''
  assert.match(j, /^    if: github\.ref != 'refs\/heads\/develop' && needs\.tray-detect\.outputs\.present == 'true'$/m)
  const writers = j.split(/^(?=\s+- (?:name|uses|run):)/m).filter(s => WRITES_BINARY.test(s))
  assert.equal(writers.length, 1)
  assert.match(writers[0], /- name: Build the tray binary\n/)
  assert.ok(!/upload-artifact/.test(writers[0]), 'the raw build is not uploaded: sign-tray.mjs labels a copy first')
  assert.ok(!/^  tray-build:/m.test(ci), 'ci.yml writes no tray binary')
})

test('no workflow writes or publishes a tray binary: every step under app-tray/native, every upload (#613)', () => {
  for (const { file, text: raw } of WORKFLOWS) {
    const text = file === 'release.yml' ? raw.replace(TRAY_BUILD, '') : raw
    // Every step of every job: from one "- name:"/"- uses:" item to the next one at the same indent
    const steps = text.split(/^(?=\s+- (?:name|uses|run):)/m)
    for (const s of steps) {
      if (/app-tray/.test(s) || /\bgo (build|install)\b/.test(s)) {
        assert.ok(!WRITES_BINARY.test(s), `${file}: a step writes a Go binary:\n${s}`)
      }
      if (/upload-artifact/.test(s)) {
        assert.ok(!/app-tray|native/.test(s), `${file}: an upload publishes from app-tray:\n${s}`)
      }
    }
  }
})

test('the required checks keep their names (#511)', () => {
  assert.ok(!/^    (name|strategy):/m.test(job('test')), 'the test job stays a single check named test')
  job('e2e-a11y')
})
