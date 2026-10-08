// #129 #134 #135 #136: the documentation stays consistent with the code and with itself.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')

/** Relative markdown links ([text](target)) of a file, without anchors and external URLs. */
function relativeLinks(file: string): string[] {
  return [...read(file).matchAll(/\]\(([^)\s]+)\)/g)]
    .map(m => m[1].split('#')[0])
    .filter(t => t && !/^[a-z]+:/i.test(t))
}

for (const file of ['README.md', 'CONTRIBUTING.md', 'docs/reading-the-ui.md']) {
  test(`${file}: every relative link resolves`, () => {
    const dir = path.dirname(path.join(root, file))
    for (const target of relativeLinks(file)) {
      assert.ok(fs.existsSync(path.resolve(dir, target)), `${file} links to missing ${target}`)
    }
  })
}

test('README documents the fork views and links the docs (#129)', () => {
  const readme = read('README.md')
  for (const word of ['Fleet', 'All', 'Workflow', 'Comms', 'Context', 'Reading the UI']) {
    assert.ok(readme.includes(word), `README should mention ${word}`)
  }
  for (const doc of ['docs/node-inspector.md', 'docs/relay-sources.md', 'docs/state-share.md', 'docs/reading-the-ui.md']) {
    assert.ok(readme.includes(`(${doc})`), `README should link ${doc}`)
  }
})

test('the reading guide explains the honesty vocabulary (#129)', () => {
  const guide = read('docs/reading-the-ui.md').toLowerCase()
  for (const term of ['not observed', 'at least', 'estimated', 'unattributed', 'observations']) {
    assert.ok(guide.includes(term), `guide should explain "${term}"`)
  }
})

test('README gives a reproducible extension install, with compatibility (#134)', () => {
  const readme = read('README.md')
  assert.match(readme, /code --install-extension \S*agent-lens-\S*\.vsix/)
  assert.match(readme, /pnpm --filter agent-lens run package/)
  assert.match(readme, /1\.85/)
  for (const ide of ['Cursor', 'Windsurf']) assert.ok(readme.includes(ide))
  assert.ok(!/not published/i.test(readme), 'no unproven claim about marketplace publication')
  assert.match(readme, /\| `pnpm --filter agent-lens run package` \|/, 'package script is in the scripts table')
  assert.equal(JSON.parse(read('extension/package.json')).scripts.package, 'vsce package')
})

test('CONTRIBUTING covers flow, labels, checks and baselines (#135)', () => {
  const c = read('CONTRIBUTING.md')
  for (const needle of [
    'develop', 'main', 'j0hn-42/agent-lens', 'agent:<role>',
    'pnpm test', 'pnpm --dir extension test', 'pnpm --filter agent-lens run lint', 'tsc --noEmit',
    'lint:a11y', 'test:a11y', 'test:e2e', 'known-violations.json', 'lint-baseline.json', 'unshare',
  ]) assert.ok(c.includes(needle), `CONTRIBUTING should mention ${needle}`)
  assert.ok(/--write/.test(c), 'explains when --write is acceptable')
})

test('every CI command is listed in CONTRIBUTING (#135)', () => {
  const ci = read('.github/workflows/ci.yml')
  const c = read('CONTRIBUTING.md')
  const runs = [...ci.matchAll(/^\s+run: (pnpm .+)$/gm)]
    .map(m => m[1].trim())
    .filter(r => !r.startsWith('pnpm install') && !r.includes('playwright install'))
  assert.ok(runs.length >= 6)
  for (const run of runs) assert.ok(c.includes(run), `CONTRIBUTING should list the CI command: ${run}`)
})

test('the PR template points to CONTRIBUTING and lists lint:a11y and e2e (#135)', () => {
  const t = read('.github/pull_request_template.md')
  assert.match(t, /CONTRIBUTING\.md/)
  assert.match(t, /lint:a11y/)
  assert.match(t, /e2e/)
})

test('CHANGELOG annotates legacy names and maps old to new (#136)', () => {
  const log = read('extension/CHANGELOG.md')
  assert.match(log, /Old name/)
  for (const [oldName, newName] of [
    ['npx agent-flow-app', 'agent-lens-app'],
    ['AGENT_FLOW_TELEMETRY', 'AGENT_LENS_TELEMETRY'],
    ['AGENT_FLOW_RUNTIME', 'AGENT_LENS_RUNTIME'],
    ['~/.agent-flow/', 'AGENT_LENS_TELEMETRY'],
  ]) {
    assert.ok(log.includes(`| \`${oldName}\``), `mapping table lists ${oldName}`)
    assert.ok(log.includes(newName))
  }
  // history is not rewritten: the original wording is still there
  assert.ok(log.includes('`export AGENT_FLOW_TELEMETRY=false`'))
  assert.ok(log.includes('npx agent-flow-app'))
  assert.ok((log.match(/\(now: /g) ?? []).length >= 4, 'historical entries carry a "now:" note')
})

test('legacy markers and credits are untouched (#136)', () => {
  assert.match(read('scripts/setup.js'), /LEGACY_HOOK_COMMAND_MARKER/)
  assert.match(read('extension/src/discovery.ts'), /LEGACY_HOOK_COMMAND_MARKER/)
  assert.match(read('README.md'), /Simon Patole/)
  assert.match(read('NOTICE'), /Simon Patole/)
  assert.equal(JSON.parse(read('extension/package.json')).publisher, 'jobailla')
})
