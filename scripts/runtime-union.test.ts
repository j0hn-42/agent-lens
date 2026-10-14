// #346: every closed list of runtimes names OpenCode too (a copy that forgets it hides the runtime silently).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..')

/** Files that copy the closed list of runtimes; each one that names gemini must name opencode. */
const RUNTIME_LIST_FILES = [
  'extension/src/session-runtime.ts',
  'extension/src/extension.ts',
  'extension/src/observations.ts',
  'extension/package.json',
  'scripts/mcp/server.ts',
]

for (const file of RUNTIME_LIST_FILES) {
  test(`${file}: names opencode wherever it names gemini`, () => {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    // Quoted occurrences only: a comment or a prose mention does not count as a list entry
    const gemini = (text.match(/['"]gemini['"]/g) ?? []).length
    const opencode = (text.match(/['"]opencode['"]/g) ?? []).length
    assert.ok(gemini > 0, `${file} no longer lists 'gemini': update RUNTIME_LIST_FILES`)
    assert.ok(opencode >= gemini, `${file} lists 'gemini' ${gemini} time(s) but 'opencode' only ${opencode} time(s)`)
  })
}
