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

test('no workflow writes or publishes a tray binary: every step under app-tray/native, every upload (#613)', () => {
  for (const { file, text } of WORKFLOWS) {
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
