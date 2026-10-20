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

test('the cross-build publishes nothing and runs after setup-go (#511, #512)', () => {
  const t = job('test')
  const s = step(t, STEP)
  assert.ok(!/upload-artifact|-o /.test(s), 'no binary is written or published: artefacts and signing are #512')
  assert.ok(t.indexOf('actions/setup-go@') < t.indexOf(STEP), 'Go comes from app-tray/native/go.mod')
})

test('the required checks keep their names (#511)', () => {
  assert.ok(!/^    (name|strategy):/m.test(job('test')), 'the test job stays a single check named test')
  job('e2e-a11y')
})
