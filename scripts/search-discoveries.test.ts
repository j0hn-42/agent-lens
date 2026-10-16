import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { provenListedPaths, searchDiscoveries } from '../web/lib/search-discoveries'
import { SEARCH_DISCOVERY } from '../web/lib/canvas-constants'
import { RESULT_CAPTURE_LIMIT } from '../web/lib/action-summary'
import { listedFileText } from '../web/lib/ui-glossary'

// #438: discovery cards come only from paths a successful Glob / Grep output lists itself, never from a guess

test('provenListedPaths: the paths listed under the tool\'s own "Found N files" header', () => {
  assert.deepEqual(provenListedPaths('Glob', { pattern: '**/*.ts' }, 'Found 3 files\n/r/a.ts\n/r/b.ts\n/r/c.ts'), { paths: ['/r/a.ts', '/r/b.ts', '/r/c.ts'], reported: 3 })
  assert.deepEqual(provenListedPaths('Grep', { pattern: 'x' }, 'Found 1 file\n/r/a.ts\n'), { paths: ['/r/a.ts'], reported: 1 })
  assert.deepEqual(provenListedPaths('Grep', { pattern: 'x', output_mode: 'files_with_matches' }, 'Found 2 files\n/r/a.ts\n/r/b.ts'), { paths: ['/r/a.ts', '/r/b.ts'], reported: 2 })
  // Copilot lower-case name, Windows paths
  assert.deepEqual(provenListedPaths('glob', undefined, 'Found 1 file\nC:\\repo\\a.ts'), { paths: ['C:\\repo\\a.ts'], reported: 1 })
  // The header may list fewer paths than it reports (a limit): the count stays the header's
  assert.deepEqual(provenListedPaths('Grep', { pattern: 'x' }, 'Found 9 files limit: 2\n/r/a.ts\n/r/b.ts'), { paths: ['/r/a.ts', '/r/b.ts'], reported: 9 })
})

test('provenListedPaths: no header, no paths, a failure or another tool give nothing', () => {
  assert.equal(provenListedPaths('Glob', {}, '/r/a.ts\n/r/b.ts'), null, 'a list without the header is not proven to be paths')
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
  assert.deepEqual(provenListedPaths('Glob', {}, 'Found 3 files\n/r/a.ts\nsee below\n/r/c.ts'), { paths: ['/r/a.ts'], reported: 3 })
  assert.equal(provenListedPaths('Glob', {}, 'Found 2 files\nrelative/a.ts\n/r/b.ts'), null)
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
