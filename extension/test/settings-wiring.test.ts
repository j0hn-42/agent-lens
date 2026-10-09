/**
 * Every setting declared in package.json (contributes.configuration) must be read by the
 * extension, and README "Settings" must list exactly the same keys (#174).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

const extRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(extRoot, '..')
const PREFIX = 'agentVisualizer.'

const pkg = JSON.parse(fs.readFileSync(path.join(extRoot, 'package.json'), 'utf8'))
const declared: string[] = Object.keys(pkg.contributes.configuration.properties)

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : []
  })
}
const sources = sourceFiles(path.join(extRoot, 'src')).map(f => fs.readFileSync(f, 'utf8')).join('\n')

describe('extension settings (#174)', () => {
  it('declares only agentVisualizer.* keys', () => {
    for (const key of declared) assert.ok(key.startsWith(PREFIX), key)
  })

  for (const key of declared) {
    it(`${key} is read in extension/src`, () => {
      const name = key.slice(PREFIX.length)
      const read = new RegExp(`\\.(?:get|has|inspect)(?:<[^>()]*>)?\\(\\s*['"]${name}['"]`)
      assert.ok(read.test(sources), `${key} is declared in package.json but never read`)
    })
  }

  it('README Settings table lists exactly the declared keys', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')
    const section = readme.slice(readme.indexOf('## Settings'))
    const table = section.slice(0, section.indexOf('\n## ', 3) === -1 ? undefined : section.indexOf('\n## ', 3))
    const listed = [...table.matchAll(/^\|\s*`(agentVisualizer\.[A-Za-z]+)`/gm)].map(m => m[1])
    assert.deepEqual([...listed].sort(), [...declared].sort())
  })

  it('devServerPort description names the port the web dev script really uses', () => {
    const webPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'web', 'package.json'), 'utf8'))
    const devScript: string = webPkg.scripts.dev
    const explicit = /(?:-p|--port)\s+(\d+)/.exec(devScript)
    const port = explicit ? explicit[1] : '3000'
    const description: string = pkg.contributes.configuration.properties[`${PREFIX}devServerPort`].description
    assert.ok(description.includes(port), `description should mention ${port}: ${description}`)
    assert.ok(!description.includes('3002') || port === '3002', 'stale 3002')
    const constants = fs.readFileSync(path.join(extRoot, 'src', 'constants.ts'), 'utf8')
    assert.match(constants, new RegExp(`DEFAULT_DEV_PORT = ${port}\\b`))
  })
})
