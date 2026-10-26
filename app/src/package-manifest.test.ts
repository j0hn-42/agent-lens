// What `npm publish` ships, and the name `npx` runs: the manifest of the standalone app is what a user gets.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

const APP = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'))

test('the package is published as agent-lens and its only command is agent-lens, so `npx agent-lens` runs it', () => {
  assert.equal(pkg.name, 'agent-lens')
  assert.deepEqual(pkg.bin, { 'agent-lens': 'dist/app.js' })
})

test('the package ships the bundle and the license files, nothing else', () => {
  assert.deepEqual([...pkg.files].sort(), ['LICENSE', 'NOTICE', 'README.md', 'dist/'])
  // build.js copies them from the root next to dist/; git ignores the copies
  const build = fs.readFileSync(path.join(APP, 'build.js'), 'utf8')
  for (const file of ['LICENSE', 'NOTICE', 'README.md']) assert.ok(build.includes(`'${file}'`), `build.js copies ${file}`)
  const ignore = fs.readFileSync(path.join(APP, '..', '.gitignore'), 'utf8')
  for (const file of ['app/LICENSE', 'app/NOTICE', 'app/README.md']) assert.ok(ignore.split('\n').includes(file), `${file} is ignored`)
})

test('publishing builds first and is public, so a stale or private package cannot go out', () => {
  assert.equal(pkg.scripts.prepublishOnly, 'node build.js')
  assert.equal(pkg.publishConfig.access, 'public')
})

test('the package states its Node floor and where it lives', () => {
  assert.equal(pkg.engines.node, '>=20')
  assert.equal(pkg.license, 'Apache-2.0')
  assert.equal(pkg.repository.url, 'https://github.com/j0hn-42/agent-lens')
})
