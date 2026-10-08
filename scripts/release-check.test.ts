import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkRelease, versionFromTag, changelogHasEntry } = require('./release-check.js')

const CHANGELOG = '# Changelog\n\n## 0.10.0\n\n- Tempo\n\n## 0.9.1\n\n- Fix\n'

function repo(ext: string, app: string, changelog = CHANGELOG): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-rel-'))
  fs.mkdirSync(path.join(dir, 'extension'))
  fs.mkdirSync(path.join(dir, 'app'))
  fs.writeFileSync(path.join(dir, 'extension/package.json'), JSON.stringify({ version: ext }))
  fs.writeFileSync(path.join(dir, 'app/package.json'), JSON.stringify({ version: app }))
  fs.writeFileSync(path.join(dir, 'extension/CHANGELOG.md'), changelog)
  return dir
}

test('versionFromTag strips the v prefix and rejects non-semver tags', () => {
  assert.equal(versionFromTag('v0.10.0'), '0.10.0')
  assert.equal(versionFromTag('refs/tags/v1.2.3'), '1.2.3')
  assert.equal(versionFromTag('v1.2.3-rc.1'), '1.2.3-rc.1')
  assert.equal(versionFromTag('0.10.0'), null)
  assert.equal(versionFromTag('vfoo'), null)
})

test('changelogHasEntry finds a "## <version>" heading only', () => {
  assert.equal(changelogHasEntry(CHANGELOG, '0.10.0'), true)
  assert.equal(changelogHasEntry(CHANGELOG, '0.9.1'), true)
  assert.equal(changelogHasEntry(CHANGELOG, '0.10'), false)
  assert.equal(changelogHasEntry('- mentions 0.11.0 in text', '0.11.0'), false)
})

test('checkRelease passes when versions agree and the changelog has the entry', () => {
  assert.deepEqual(checkRelease(repo('0.10.0', '0.10.0')), [])
})

test('checkRelease reports a version mismatch between extension and app', () => {
  const errors = checkRelease(repo('0.10.0', '0.9.1'))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /0\.10\.0.*0\.9\.1/)
})

test('checkRelease reports a missing changelog entry', () => {
  const errors = checkRelease(repo('0.11.0', '0.11.0'))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /CHANGELOG/)
})

test('checkRelease compares the tag with the version when one is given', () => {
  const dir = repo('0.10.0', '0.10.0')
  assert.deepEqual(checkRelease(dir, 'v0.10.0'), [])
  assert.match(checkRelease(dir, 'v0.10.1')[0], /tag/)
  assert.match(checkRelease(dir, 'release-1')[0], /tag/)
})

test('checkRelease reports unreadable files instead of throwing', () => {
  const dir = repo('0.10.0', '0.10.0')
  fs.rmSync(path.join(dir, 'app/package.json'))
  const errors = checkRelease(dir)
  assert.ok(errors.length >= 1)
  assert.match(errors.join('\n'), /app\/package\.json/)
})

test('the 0.10.0 CHANGELOG entry cites every ticket of the Tempo wave (#48 to #72, #86)', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'extension/CHANGELOG.md'), 'utf8')
  const entry = text.split(/^## /m).find((s) => s.startsWith('0.10.0')) ?? ''
  const cited = new Set((entry.match(/#\d+/g) ?? []).map((m) => Number(m.slice(1))))
  const expected = [...Array.from({ length: 25 }, (_, i) => 48 + i), 86]
  assert.deepEqual(expected.filter((n) => !cited.has(n)), [])
})
