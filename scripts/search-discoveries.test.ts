import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { searchDiscoveries } from '../web/lib/search-discoveries'
import { SEARCH_DISCOVERY } from '../web/lib/canvas-constants'
import { RESULT_CAPTURE_LIMIT } from '../web/lib/action-summary'
import { listedFileText } from '../web/lib/ui-glossary'

// #438: discovery cards come only from paths a successful Glob / Grep output lists itself, never from a guess

/** The paths the cards of one call show, with the count they say the call reported; null when no card. */
function provenListedPaths(toolName: string, inputData: Record<string, unknown> | undefined, result: string) {
  const ds = searchDiscoveries({ agentId: 's1:a', toolName, inputData, toolUseId: 'tu', x: 0, y: 0 }, result, 1)
  return ds.length === 0 ? null : { paths: ds.map(d => d.content), reported: ds[0].listing!.reported }
}

// Outputs copied from real transcripts: Grep prints paths relative to the working directory
const GREP_1 = 'Found 1 file\nbackend/src/routes/auth.helpers.ts'
const GREP_3 = 'Found 3 files\nsrc/services/matches.ts\nsrc/services/seasons.ts\nsrc/routes/matches.ts'

test('provenListedPaths: a real Grep output (relative paths) gives one path per line under its header', () => {
  assert.deepEqual(provenListedPaths('Grep', { pattern: 'x' }, GREP_1), { paths: ['backend/src/routes/auth.helpers.ts'], reported: 1 })
  assert.deepEqual(provenListedPaths('Grep', { pattern: 'x' }, GREP_3), { paths: ['src/services/matches.ts', 'src/services/seasons.ts', 'src/routes/matches.ts'], reported: 3 })
})

test('provenListedPaths: the paths listed under the tool\'s own "Found N files" header', () => {
  assert.deepEqual(provenListedPaths('Grep', { pattern: 'x' }, 'Found 1 file\nsrc/a.ts\n'), { paths: ['src/a.ts'], reported: 1 })
  assert.deepEqual(provenListedPaths('Grep', { pattern: 'x', output_mode: 'files_with_matches' }, 'Found 2 files\nsrc/a.ts\nsrc/b.ts'), { paths: ['src/a.ts', 'src/b.ts'], reported: 2 })
  // Absolute paths are paths too
  assert.deepEqual(provenListedPaths('Grep', { pattern: 'x' }, 'Found 1 file\n/r/a.ts'), { paths: ['/r/a.ts'], reported: 1 })
  // Copilot lower-case name, Windows paths
  assert.deepEqual(provenListedPaths('glob', undefined, 'Found 1 file\nC:\\repo\\a.ts'), { paths: ['C:\\repo\\a.ts'], reported: 1 })
  // The header may carry a limit suffix (real output: 'Found 10 files limit: 10'); the count read is the header's
  const limited = 'Found 10 files limit: 10\n' + Array.from({ length: 10 }, (_, i) => `src/services/s${i}.ts`).join('\n')
  assert.equal(provenListedPaths('Grep', { pattern: 'x', head_limit: 10 }, limited)?.reported, 10)
})

test('provenListedPaths: no header, no paths, a failure or another tool give nothing', () => {
  // A real Glob output is a bare list, without the header: no card
  assert.equal(provenListedPaths('Glob', {}, 'src/a.ts\nsrc/b.ts'), null, 'a list without the header is not proven to be paths')
  assert.equal(provenListedPaths('Glob', {}, '/r/a.ts\n/r/b.ts'), null)
  assert.equal(provenListedPaths('Glob', {}, 'No files found'), null)
  assert.equal(provenListedPaths('Glob', {}, 'Found 0 files'), null)
  assert.equal(provenListedPaths('Glob', {}, 'Found 2 files'), null, 'a header without lines lists nothing')
  assert.equal(provenListedPaths('Grep', {}, '[FAILED] Found 2 files\n/r/a.ts'), null)
  assert.equal(provenListedPaths('Bash', { command: 'ls' }, 'Found 2 files\n/r/a.ts\n/r/b.ts'), null)
  assert.equal(provenListedPaths('Read', { file_path: '/r/a.ts' }, 'Found 1 file\n/r/a.ts'), null)
})

test('provenListedPaths: Grep in content or count mode gives nothing', () => {
  assert.equal(provenListedPaths('Grep', { pattern: 'x', output_mode: 'content' }, 'Found 2 files\n/r/a.ts\n/r/b.ts'), null)
  assert.equal(provenListedPaths('Grep', { pattern: 'x', output_mode: 'count' }, 'Found 2 files\n/r/a.ts\n/r/b.ts'), null)
  // A content line is not a path, whatever the input says
  assert.equal(provenListedPaths('Grep', { pattern: 'x' }, 'Found 1 file\n/r/a.ts:12:const x = 1'), null)
})

test('provenListedPaths: only whole path lines, read up to the first line that is not one', () => {
  assert.deepEqual(provenListedPaths('Grep', {}, 'Found 3 files\nsrc/a.ts\n\nsrc/c.ts'), { paths: ['src/a.ts'], reported: 3 }, 'an empty line ends the list')
  assert.deepEqual(provenListedPaths('Grep', {}, 'Found 3 files\nsrc/a.ts\n  (more)\nsrc/c.ts'), { paths: ['src/a.ts'], reported: 3 }, 'a line with leading space is not a path')
  assert.deepEqual(provenListedPaths('Grep', {}, 'Found 3 files\nsrc/a.ts\nsrc/b.ts \nsrc/c.ts'), { paths: ['src/a.ts'], reported: 3 }, 'nor one with trailing space')
  assert.equal(provenListedPaths('Grep', {}, 'Found 1 file\nsrc/a\u0007.ts'), null, 'a control character is not in a path')
  assert.deepEqual(provenListedPaths('Glob', {}, 'Found 2 files\n/r/a.ts\n/r/a.ts'), { paths: ['/r/a.ts'], reported: 2 }, 'a repeated line is one path')
  assert.equal(provenListedPaths('Glob', {}, 'Found 1 file\n/r/a.ts\n/r/b.ts'), null, 'more paths than the header reports: the output is not what it claims')
})

test('provenListedPaths: an output cut at the capture limit keeps only its whole lines', () => {
  const long = '/r/' + 'x'.repeat(60)
  const result = `Found 47 files\n${long}1.ts\n${long}2.ts\n${long}3.ts\n${long}4.ts`.slice(0, RESULT_CAPTURE_LIMIT)
  assert.equal(result.length, RESULT_CAPTURE_LIMIT)
  const listed = provenListedPaths('Glob', {}, result)!
  assert.deepEqual(listed, { paths: [`${long}1.ts`, `${long}2.ts`], reported: 47 }, 'the last, possibly cut line is dropped')
  // Cut right after the header: nothing whole is left
  const cut = `Found 47 files\n${'/r/' + 'y'.repeat(300)}`.slice(0, RESULT_CAPTURE_LIMIT)
  assert.equal(provenListedPaths('Glob', {}, cut), null)
})

const call = { agentId: 's1:a', toolName: 'Glob', inputData: { pattern: '*.ts' }, toolUseId: 'tu1', x: 100, y: 50 }

test('searchDiscoveries: one file card per proven path, starting at the tool card, with the call it comes from', () => {
  const ds = searchDiscoveries(call, 'Found 2 files\n/r/src/a.ts\n/r/b.ts', 7)
  assert.equal(ds.length, 2)
  assert.deepEqual(ds.map(d => d.id), ['disc-s1:a-tu1-0', 'disc-s1:a-tu1-1'])
  assert.deepEqual(ds.map(d => [d.type, d.label, d.content]), [['file', 'a.ts', '/r/src/a.ts'], ['file', 'b.ts', '/r/b.ts']])
  for (const d of ds) {
    assert.equal(d.agentId, 's1:a')
    assert.equal(d.toolUseId, 'tu1')
    assert.equal(d.timestamp, 7)
    assert.equal(d.opacity, 0)
    assert.deepEqual([d.x, d.y], [100, 50], 'animates from the tool card')
  }
  assert.deepEqual(ds.map(d => d.listing), [
    { tool: 'Glob', position: 1, reported: 2, shown: 2 },
    { tool: 'Glob', position: 2, reported: 2, shown: 2 },
  ])
  assert.notEqual(ds[0].targetY, ds[1].targetY, 'cards do not stack on one another')
})

test('searchDiscoveries: at most SEARCH_DISCOVERY.maxPerCall cards per call, the rest is said, never drawn', () => {
  const paths = Array.from({ length: SEARCH_DISCOVERY.maxPerCall + 3 }, (_, i) => `/${i}`)
  const ds = searchDiscoveries(call, `Found 40 files\n${paths.join('\n')}`, 1)
  assert.equal(ds.length, SEARCH_DISCOVERY.maxPerCall)
  assert.ok(ds.every(d => d.listing!.shown === SEARCH_DISCOVERY.maxPerCall && d.listing!.reported === 40))
})

test('searchDiscoveries: no tool_use_id, no stable id, no card', () => {
  assert.deepEqual(searchDiscoveries({ ...call, toolUseId: undefined }, 'Found 1 file\n/r/a.ts', 1), [])
  assert.deepEqual(searchDiscoveries(call, 'No files found', 1), [])
})

test('listedFileText says where the card comes from and what was left out', () => {
  assert.equal(listedFileText({ tool: 'Glob', position: 1, reported: 2, shown: 2 }), 'File listed by Glob, 1 of 2 files the call reported')
  assert.equal(listedFileText({ tool: 'Grep', position: 2, reported: 47, shown: 3 }), 'File listed by Grep, 2 of 47 files the call reported; 3 shown, 44 not drawn')
})

test('the reading guide documents the file cards, their cap and what they never show (#438)', () => {
  const guide = readFileSync(path.join(__dirname, '..', 'docs', 'reading-the-ui.md'), 'utf8')
  const start = guide.indexOf('- **File cards from a search**')
  assert.ok(start > 0, 'the Result pills list has a File cards entry')
  const entry = guide.slice(start, guide.indexOf('\n', start))
  assert.ok(entry.includes(`at most ${SEARCH_DISCOVERY.maxPerCall} cards`), 'the cap is the code constant')
  for (const words of ['Found N files', 'files_with_matches', 'not drawn', 'tool_use_id', 'failed', 'cancelled']) {
    assert.ok(entry.includes(words), `the entry says "${words}"`)
  }
})
