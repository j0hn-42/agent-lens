// Per-action glyph on the canvas tool cards (#317): the shape is chosen from the call itself, MCP
// tools and unknown tools keep the generic card, and motion stops under reduced motion.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { toolGlyph, type ToolGlyph } from '../web/lib/action-summary'
import { drawToolGlyph } from '../web/components/agent-visualizer/canvas/draw-tool-glyph'

test('toolGlyph: one shape per native action', () => {
  assert.equal(toolGlyph('Read', {}), 'read')
  assert.equal(toolGlyph('Grep', {}), 'search')
  assert.equal(toolGlyph('Glob', {}), 'search')
  assert.equal(toolGlyph('Write', {}), 'write')
  assert.equal(toolGlyph('Edit', {}), 'edit')
  assert.equal(toolGlyph('MultiEdit', {}), 'edit')
  assert.equal(toolGlyph('Bash', { command: 'ls' }), 'shell')
})

test('toolGlyph: Bash running git or gh takes the git / gh shape, from the command only', () => {
  assert.equal(toolGlyph('Bash', { command: 'git status' }), 'git')
  assert.equal(toolGlyph('Bash', { command: 'cd x && gh pr view 1' }), 'gh')
  assert.equal(toolGlyph('Bash', { command: 'echo "git push"' }), 'shell')
  assert.equal(toolGlyph('Bash', undefined), 'shell')
})

test('toolGlyph: MCP and unknown tools have no glyph', () => {
  assert.equal(toolGlyph('mcp__srv__read', {}), null)
  assert.equal(toolGlyph('ExitPlanMode', {}), null)
})

/** A canvas context that records the drawing calls and ignores the rest. */
function recorder() {
  const calls: string[] = []
  const ctx = new Proxy({}, {
    get: (_t, prop: string) => (...args: unknown[]) => { calls.push(`${prop}(${args.map(a => (typeof a === 'number' ? a.toFixed(2) : String(a))).join(',')})`) },
    set: (_t, prop: string, value: unknown) => { calls.push(`${prop}=${String(value)}`); return true },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

const GLYPHS: ToolGlyph[] = [
  'read', 'search', 'write', 'edit', 'shell', 'git', 'gh',
  'todo', 'web', 'ask', 'task', 'notebook', 'python', 'test', 'docker', 'package',
]
const draw = (g: ToolGlyph, time: number, running: boolean, reducedMotion: boolean) => {
  const { ctx, calls } = recorder()
  drawToolGlyph(ctx, g, 0, 0, 12, '#fff', time, running, reducedMotion)
  return calls.join('|')
}

test('every glyph draws something', () => {
  for (const g of GLYPHS) assert.ok(draw(g, 0, false, false).includes('stroke'), g)
})

test('glyphs are distinct shapes', () => {
  const shapes = new Set(GLYPHS.map(g => draw(g, 0, false, false)))
  assert.equal(shapes.size, GLYPHS.length)
})

test('reduced motion: the drawing does not depend on time, even while running', () => {
  for (const g of GLYPHS) assert.equal(draw(g, 0, true, true), draw(g, 0.37, true, true), g)
})

test('a finished call is static whatever the motion setting', () => {
  for (const g of GLYPHS) assert.equal(draw(g, 0, false, false), draw(g, 0.37, false, false), g)
})

test('running with motion allowed animates the shell, search, git, web, ask, task, python and test glyphs', () => {
  for (const g of ['shell', 'search', 'git', 'web', 'ask', 'task', 'python', 'test'] as const) assert.notEqual(draw(g, 0, true, false), draw(g, 0.6, true, false), g)
})
