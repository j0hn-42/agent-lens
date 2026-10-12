import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { exportedNames, findUnusedExports } from './unused-exports'

test('exportedNames reads value declarations and export lists (type and interface declarations are erased, so they are not counted)', () => {
  const src = `export function a() {}\nexport const b = 1\nexport type C = string\nexport { d, e as f }\nexport type { G }\nfunction h() {}`
  assert.deepEqual(exportedNames(src).sort(), ['G', 'a', 'b', 'd', 'f'])
})

test('an export that no other production file mentions is reported (tests are not production files)', () => {
  const found = findUnusedExports({
    'web/lib/a.ts': 'export function used() {}\nexport function dead() {}',
    'web/lib/b.ts': "import { used } from './a'\nused()",
  })
  assert.deepEqual(found, [{ file: 'web/lib/a.ts', name: 'dead' }])
})

test('a name that only appears in its own file does not count as used', () => {
  assert.deepEqual(findUnusedExports({ 'web/lib/a.ts': 'export const x = 1\nconsole.log(x)' }), [{ file: 'web/lib/a.ts', name: 'x' }])
})

const baseline: string[] = JSON.parse(readFileSync(join(__dirname, 'unused-exports-baseline.json'), 'utf8'))

test('no new export of web/lib, web/hooks or web/components is used only by tests', () => {
  const known = new Set(baseline)
  const fresh = findUnusedExports().map(x => `${x.file}:${x.name}`).filter(k => !known.has(k))
  assert.deepEqual(fresh, [], 'import it from production code, wire it into the UI, or delete it with its test')
})

test('the baseline only shrinks: an entry that is now used, or gone, must be removed from it', () => {
  const still = new Set(findUnusedExports().map(x => `${x.file}:${x.name}`))
  assert.deepEqual(baseline.filter(k => !still.has(k)), [], 'delete these lines from scripts/unused-exports-baseline.json')
})
