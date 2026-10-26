// Design-system tokens instead of repeated literals (#509, follow-up of #382): the 11 px type step, alpha on a
// colour, named z-indexes and the scrim. Nothing renders differently: each token has the value of the literal it replaces.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { withHexAlpha } from '../web/lib/color-alpha'
import { Z } from '../web/lib/agent-types'

const WEB = join(__dirname, '..', 'web')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return ['node_modules', '.next', 'tests-a11y', 'out'].includes(e.name) ? [] : sources(full)
    return /\.(ts|tsx)$/.test(e.name) ? [full] : []
  })
}
const FILES = [...sources(join(WEB, 'components')), ...sources(join(WEB, 'lib')), ...sources(join(WEB, 'app'))]

/** Lines of the web sources that match `re`, as "file:line" (files in `allowed` are skipped, each one is justified where it is listed). */
function offenders(re: RegExp, allowed: string[] = []): string[] {
  const out: string[] = []
  for (const file of FILES) {
    const rel = relative(WEB, file)
    if (allowed.includes(rel)) continue
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (re.test(line)) out.push(`${rel}:${i + 1}`) })
  }
  return out
}

test('the 11 px step is the text-2xs token, rendered at 11 px', () => {
  const css = readFileSync(join(WEB, 'app', 'globals.css'), 'utf8')
  assert.match(css, /--text-2xs:\s*11px;/)
  assert.deepEqual(offenders(/text-\[11px\]/), [])
})

test('withHexAlpha appends a two-digit hex alpha to a #rrggbb colour, exactly like the concatenation it replaces', () => {
  assert.equal(withHexAlpha('#ff8800', '80'), '#ff880080')
  assert.equal(withHexAlpha('#FF8800', '00'), '#FF880000')
})

test('withHexAlpha leaves a colour it cannot extend untouched (an invalid string would throw in addColorStop)', () => {
  assert.equal(withHexAlpha('rgba(1, 2, 3, 0.5)', '80'), 'rgba(1, 2, 3, 0.5)')
  assert.equal(withHexAlpha('var(--x)', '80'), 'var(--x)')
  assert.equal(withHexAlpha('#abc', '80'), '#abc')
})

test('no hex alpha is glued to a colour by hand: withHexAlpha is the one place', () => {
  assert.deepEqual(offenders(/\+ ?['"][0-9a-fA-F]{2}['"]/, ['lib/color-alpha.ts']), [])
  assert.deepEqual(offenders(/\$\{[^}]+\}[0-9a-fA-F]{2}[`']/, ['lib/color-alpha.ts']), [])
})

test('z-indexes are the named levels of Z: no numeric zIndex, no Z.x + n, no z-<n> class', () => {
  assert.deepEqual(offenders(/zIndex: ?-?\d/, ['lib/agent-types.ts']), [])
  assert.deepEqual(offenders(/Z\.\w+ ?[-+] ?\d/), [])
  assert.deepEqual(offenders(/\bz-\d+\b/, ['lib/agent-types.ts']), [])
})

test('the levels that used an offset keep their value, in order', () => {
  assert.equal(Z.dialog, Z.contextMenu + 1)
  assert.equal(Z.notice, Z.controlBar + 1)
  assert.equal(Z.toast, Z.controlBar + 5)
  assert.equal(Z.permissionBanner, Z.controlBar + 6)
  assert.equal(Z.tourHighlight, Z.detailCard - 1)
})

test('the --z-info CSS variable used by the z-(--z-info) classes equals Z.info', () => {
  const css = readFileSync(join(WEB, 'app', 'globals.css'), 'utf8')
  assert.match(css, new RegExp(`--z-info:\\s*${Z.info};`))
})

test('the modal scrim is the --lens-scrim theme token, never a black literal', () => {
  assert.deepEqual(offenders(/rgba\(0, ?0, ?0, ?0\.5\)/, ['lib/theme-tokens.ts', 'lib/theme-palette.ts']), [])
})
