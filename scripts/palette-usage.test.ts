// #382: a palette key nothing reads is a false guarantee (the contrast tests vouch for a colour that is never painted) and a
// colour to maintain for nothing. Every key of the palette is read by production code (`COLORS.<key>`, `SCENE.<key>`, `palette.<key>`, a
// destructuring of a palette object or a quoted index), or is listed in KNOWN_UNREAD below. The list is a ratchet: it only shrinks. A key that
// gets read again must leave the list, a new key must be read, and a dead key is deleted from theme-palette.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NEON_COLORS } from '../web/lib/theme-palette'

const ROOT = join(__dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'out', 'tests-a11y', 'tests-e2e'])

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) sources(p, out)
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) && !p.endsWith(join('lib', 'theme-palette.ts'))) out.push(p)
  }
  return out
}

const TEXT = ['web', 'extension/src', 'app']
  .flatMap(d => { try { return sources(join(ROOT, d)) } catch { return [] } })
  .map(f => readFileSync(f, 'utf8'))

// Only an access on a palette object counts: `.key` on any other object (`item.danger`, `this.delegate`, `PERF_OVERLAY.fpsWarning`)
// says nothing about the palette. Palette objects in the code: COLORS (interface), SCENE (canvas), NEON_COLORS, and the
// `palette` / `p` parameters and locals that receive one (colors.ts, scene-state-colors.ts, learn-more-link.tsx).
const OBJ = '(?:COLORS|SCENE|NEON_COLORS|palette|p)'

function isRead(key: string): boolean {
  const re = new RegExp(
    `\\b${OBJ}\\??\\.${key}\\b` +
    `|\\b${OBJ}\\[['"\`]${key}['"\`]\\]` +
    `|\\{[^{}]*\\b${key}\\b[^{}]*\\}\\s*=\\s*${OBJ}\\b`,
  )
  return TEXT.some(t => re.test(t))
}

/**
 * Kept on purpose although no component reads them: paletteFor reads them to give neon's interface the colours its canvas
 * draws thinking and waiting in (#381), and scripts/state-colors.test.ts pins them to the state tokens.
 */
const READ_BY_PALETTE_ONLY = ['stateThinking', 'stateWaitingPermission']

/** Dead keys not yet removed (#382). Do not add to it. */
const KNOWN_UNREAD: string[] = [
  'textHint', 'glassBg', 'glassHighlight', 'holoBorder12', 'toggleBorder', 'toggleBorderActive', 'tabInactiveBg',
  'tabSelectedBorder', 'tabInactiveBorder', 'playBtnBorder', 'reviewBtnBorder', 'cardBgError', 'cardBgSelectedHolo',
  'userMsgBg', 'userMsgBorder', 'userText', 'assistantLabel', 'thinkingBgExpanded', 'thinkingBgCollapsed',
  'thinkingBorder', 'thinkingLabel', 'thinkingArrow', 'thinkingPreview', 'thinkingTextExpanded', 'thinkingBorderLeft',
  'onAccent', 'shadowCard', 'glassBlur', 'depthShadow',
]

test('every palette key is read by production code or is a known leftover', () => {
  const unread = (Object.keys(NEON_COLORS) as string[]).filter(k => !READ_BY_PALETTE_ONLY.includes(k) && !isRead(k))
  const unexpected = unread.filter(k => !KNOWN_UNREAD.includes(k))
  assert.deepEqual(unexpected, [], `palette keys nothing reads (delete them from theme-palette.ts): ${unexpected.join(', ')}`)
})

test('KNOWN_UNREAD only lists keys that are still unread', () => {
  const stale = KNOWN_UNREAD.filter(k => !(k in NEON_COLORS) || isRead(k))
  assert.deepEqual(stale, [], `remove from KNOWN_UNREAD: ${stale.join(', ')}`)
})
