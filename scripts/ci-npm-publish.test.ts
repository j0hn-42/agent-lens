// The npm publication of the standalone app stays a deliberate act: it only runs when someone starts it by hand,
// needs a token that only the owner can add, and never runs from develop or from red code.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish-npm.yml'), 'utf8')

test('the npm workflow is started by hand only: no push, no tag, no schedule', () => {
  const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'))
  assert.match(on, /workflow_dispatch:/)
  assert.doesNotMatch(on, /push:|tags:|schedule:|pull_request/)
})

test('it never runs from develop and runs the CI first', () => {
  assert.match(workflow, /github\.ref != 'refs\/heads\/develop'/)
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ci\.yml/)
  assert.match(workflow, /needs: ci/)
})

test('it needs the NPM_TOKEN secret and stops with a message when it is missing, instead of doing nothing', () => {
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
  assert.match(workflow, /NPM_TOKEN secret is not set/)
  assert.match(workflow, /exit 1/)
})

test('it checks the versions, builds the app and publishes from app/ with provenance', () => {
  assert.match(workflow, /node scripts\/release-check\.js/)
  assert.match(workflow, /pnpm run build:app/)
  assert.match(workflow, /working-directory: app\n\s+run: npm publish --provenance/)
  // Provenance needs the OIDC token, and nothing else is granted beyond reading the repository
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /contents: read/)
})

test('the other workflows still publish nothing to npm', () => {
  for (const f of ['ci.yml', 'release.yml']) {
    const text = fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8')
    assert.doesNotMatch(text, /npm publish|NPM_TOKEN/, `${f} does not publish to npm`)
  }
})
