// #129 #134 #135 #136: the documentation stays consistent with the code and with itself.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { RELAY_LAUNCH_BODY_MAX_BYTES, RELAY_LAUNCH_RATE_BURST, RELAY_MAX_ALLOWED_HOSTS, RELAY_MAX_REMOTE_SSE_CLIENTS } from '../extension/src/constants'
import { remoteStartupError } from './remote-access'
import { REMOTE_PAIR_MAX_SESSIONS, REMOTE_PAIR_SESSION_TTL_MS, PAIR_COOKIE } from './remote-pairing'
import { LAUNCH_ALLOWED_TOOLS, LAUNCH_CAPS, LAUNCH_DISALLOWED_TOOLS, LAUNCH_PERMISSION_MODE } from '../extension/src/launch-policy'
import { READING_GUIDE_DIR, READING_GUIDE_INDEX, readReadingGuide, readReadingGuideDomains, readingGuideFiles } from './reading-guide'

const root = path.resolve(__dirname, '..')

/**
 * The files git tracks under `scope` (paths relative to `dir`). Outside a git checkout (a source archive, #613) every
 * file present is a shipped file: the tree is walked instead, without node_modules and .git.
 */
function trackedFiles(dir: string, scope = ''): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z', '--', scope || '.'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean)
  } catch {
    const out: string[] = []
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        const child = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(child)
        else out.push(child)
      }
    }
    walk(scope)
    return out
  }
}

test('the tracked-file listing still works outside a git checkout, as in a source archive (#613)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-no-git-'))
  try {
    fs.mkdirSync(path.join(tmp, 'app-tray/native/trayproto/node_modules'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'app-tray/native/go.mod'), 'module x\n')
    fs.writeFileSync(path.join(tmp, 'app-tray/native/trayproto/p.go'), 'package p\n')
    fs.writeFileSync(path.join(tmp, 'app-tray/native/trayproto/node_modules/x.js'), '')
    fs.writeFileSync(path.join(tmp, 'README.md'), '')
    assert.deepEqual(trackedFiles(tmp, 'app-tray/native').sort(), ['app-tray/native/go.mod', 'app-tray/native/trayproto/p.go'])
    assert.ok(trackedFiles(tmp).includes('README.md'))
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')
/** The reading guide is an index and one file per domain (#612): a test that looks for a term reads every domain file,
 *  in the order of the index, and never the index itself (#613: a word of the index cannot satisfy it) */
const guideText = () => readReadingGuideDomains()
/** A doc as the tests read it: the whole reading guide for its index, the file itself otherwise */
const docText = (f: string) => (f === READING_GUIDE_INDEX ? guideText() : read(f))

/** Relative markdown links ([text](target)) of a file, without anchors and external URLs. */
function relativeLinks(file: string): string[] {
  return [...read(file).matchAll(/\]\(([^)\s]+)\)/g)]
    .map(m => m[1].split('#')[0])
    .filter(t => t && !/^[a-z]+:/i.test(t))
}

// The reading guide is checked file by file (its index and each domain file), each link from its own folder (#612)
for (const file of ['README.md', 'CONTRIBUTING.md', READING_GUIDE_INDEX, ...readingGuideFiles(), 'docs/headless.md', 'docs/mcp-server.md', 'docs/launch-security.md', 'docs/tray.md']) {
  test(`${file}: every relative link resolves`, () => {
    const dir = path.dirname(path.join(root, file))
    for (const target of relativeLinks(file)) {
      assert.ok(fs.existsSync(path.resolve(dir, target)), `${file} links to missing ${target}`)
    }
  })
}

/** GitHub's anchor of a heading: lowercase, punctuation dropped, spaces as hyphens */
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')

test('the reading guide is an index and one file per domain, each linked once, in a fixed order (#612)', () => {
  const index = read(READING_GUIDE_INDEX)
  const onDisk = fs.readdirSync(path.join(root, READING_GUIDE_DIR)).filter(f => f.endsWith('.md')).map(f => `${READING_GUIDE_DIR}/${f}`).sort()
  const listed = readingGuideFiles()
  assert.ok(listed.length > 5, 'the guide is split in several domain files')
  assert.deepEqual([...listed].sort(), onDisk, 'every domain file is linked from the index, and every link has its file')
  assert.equal(new Set(listed).size, listed.length, 'no domain file is linked twice')
  for (const f of listed) assert.match(read(f), /^## \S/, `${f} opens with a "## " heading, so read alone it has a title and no level is skipped`)
  assert.doesNotMatch(index, /^## /m, 'the index has no section of its own: a section lives in the file of its domain')
  assert.ok(index.split('\n').length < 80, 'the index stays short')
  // The tests that look for a term never read the index (#613: the 7 terms checked here before left every other one
  // open): neither here (guideText) nor in the other test files (readReadingGuideDomains)
  assert.ok(!guideText().includes(index.split('\n').find(l => l.startsWith('Principle'))!), 'a term search does not read the index')
  for (const f of fs.readdirSync(path.join(root, 'scripts')).filter(n => n.endsWith('.test.ts') && n !== 'docs.test.ts')) {
    assert.doesNotMatch(read(`scripts/${f}`), /readReadingGuide\(/, `scripts/${f} reads the index with readReadingGuide(): use readReadingGuideDomains()`)
  }
  // Read as one text, the guide starts with the index and follows its order
  const whole = readReadingGuide()
  assert.ok(whole.startsWith(index))
  let at = index.length
  for (const f of listed) {
    const pos = whole.indexOf(read(f), at)
    assert.ok(pos >= at, `${f} follows the previous file in the whole text`)
    at = pos + read(f).length
  }
})

test('a translated surface is listed in the file of its domain, and language.md only links them (#612)', () => {
  const language = read(`${READING_GUIDE_DIR}/language.md`)
  const bullets = [...language.matchAll(/^- (.*)$/gm)].map(m => m[1])
  const linked = bullets.map(b => b.match(/^\[[^\]]+\]\(([a-z0-9-]+\.md)#in-your-language\)$/)?.[1])
  assert.deepEqual(bullets.filter((b, i) => !linked[i]), [], 'every bullet of language.md is a link to the In your language section of a domain file')
  const withSection = readingGuideFiles().filter(f => /^### In your language$/m.test(read(f))).map(f => path.posix.basename(f)).sort()
  assert.deepEqual([...linked].sort(), withSection, 'each domain file with translated surfaces is linked once from language.md')
  for (const f of withSection) {
    const section = read(`${READING_GUIDE_DIR}/${f}`).split(/^### In your language$/m)[1].split(/^#{1,3} /m)[0]
    assert.match(section, /^- the /m, `${f}: its In your language section lists surfaces`)
  }
})

test('every link to a section of the reading guide lands on a heading of the file it names (#612)', () => {
  // Every Markdown file of the repository (#613: README, docs/ and the guide only before; CONTRIBUTING, CLAUDE.md, the
  // PR template, the skills and agents link to the guide too)
  const docs = trackedFiles(root).filter(f => f.endsWith('.md') && !f.includes('node_modules/'))
  for (const f of ['README.md', 'CONTRIBUTING.md', READING_GUIDE_INDEX, ...readingGuideFiles()]) assert.ok(docs.includes(f), `${f} is checked`)
  const anchorsOf = new Map<string, Set<string>>()
  const anchors = (file: string) => {
    if (!anchorsOf.has(file)) anchorsOf.set(file, new Set([...read(file).matchAll(/^#{1,6} (.+)$/gm)].map(m => slug(m[1]))))
    return anchorsOf.get(file)!
  }
  let checked = 0
  for (const doc of docs) {
    for (const m of read(doc).matchAll(/\]\(([^)\s]*)#([^)\s]+)\)/g)) {
      const target = m[1] ? path.posix.normalize(path.posix.join(path.posix.dirname(doc), m[1])) : doc
      if (target !== READING_GUIDE_INDEX && !target.startsWith(`${READING_GUIDE_DIR}/`)) continue
      assert.ok(anchors(target).has(m[2]), `${doc} links to ${m[1] || '(itself)'}#${m[2]}, which is not a heading of ${target}`)
      checked++
    }
  }
  assert.ok(checked > 10, 'the links to sections of the guide are checked')
})

/** The named sections of the guide (its headings and the bold labels that open a bullet), each with the domain files that hold it */
function guideSectionFiles(): Map<string, Set<string>> {
  const sections = new Map<string, Set<string>>()
  for (const file of readingGuideFiles()) {
    const text = read(file)
    const names = [...text.matchAll(/^#{1,6} (.+)$/gm), ...text.matchAll(/^\s*- \*\*([^*]+)\*\*/gm)].map(m => m[1].trim())
    for (const name of names) {
      if (!sections.has(name)) sections.set(name, new Set())
      sections.get(name)!.add(file)
    }
  }
  return sections
}

test('a link to the reading guide that names a section in bold or in quotes points to the file of that section (#612)', () => {
  const sections = guideSectionFiles()
  const docs = trackedFiles(root).filter(f => f.endsWith('.md') && !f.includes('node_modules/'))
  const isGuide = (t: string) => t === READING_GUIDE_INDEX || t.startsWith(`${READING_GUIDE_DIR}/`)
  let checked = 0
  const wrong: string[] = []
  for (const doc of [...new Set(docs)]) {
    for (const line of read(doc).split('\n')) {
      const links = [...line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
      links.forEach((m, i) => {
        if (m[1].includes('#') || /^[a-z]+:/i.test(m[1])) return // a link with an anchor is checked by the anchor test
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(doc), m[1]))
        if (!isGuide(target)) return
        // The words around this link: from the end of the previous link to the start of the next one
        const from = i > 0 ? links[i - 1].index! + links[i - 1][0].length : 0
        const to = i + 1 < links.length ? links[i + 1].index! : line.length
        const around = line.slice(from, m.index!) + line.slice(m.index! + m[0].length, to)
        for (const n of around.matchAll(/\*\*([^*]+)\*\*|"([^"]+)"|«\s*([^»]+?)\s*»/g)) {
          const name = (n[1] ?? n[2] ?? n[3]).trim()
          const files = sections.get(name)
          if (!files) continue
          if (!files.has(target)) wrong.push(`${doc} names the section "${name}" next to a link to ${target}, but that section is in ${[...files].join(', ')}`)
          checked++
        }
      })
    }
  }
  assert.deepEqual(wrong, [])
  assert.ok(checked >= 1, 'links that name a section of the guide are checked')
})

test('README documents the fork views and links the docs (#129)', () => {
  const readme = read('README.md')
  for (const word of ['Fleet', 'All', 'Workflow', 'Comms', 'Context', 'Reading the UI']) {
    assert.ok(readme.includes(word), `README should mention ${word}`)
  }
  for (const doc of ['docs/node-inspector.md', 'docs/relay-sources.md', 'docs/state-share.md', 'docs/reading-the-ui.md', 'docs/headless.md']) {
    assert.ok(readme.includes(`(${doc})`), `README should link ${doc}`)
  }
})

test('the MCP server doc says how to register it and what it does not prove (#235)', () => {
  const doc = read('docs/mcp-server.md')
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.scripts.mcp, 'node --import tsx scripts/mcp/main.ts')
  for (const needle of ['.mcp.json', '"run", "mcp"', '--silent', 'AGENT_LENS_RELAY_URL', 'observations', 'session_work', 'no cost tool', 'at least']) {
    assert.ok(doc.includes(needle), `docs/mcp-server.md should mention ${needle}`)
  }
  assert.ok(read('README.md').includes('(docs/mcp-server.md)'), 'README should link docs/mcp-server.md')
})

test('the reading guide explains the honesty vocabulary (#129)', () => {
  const guide = guideText().toLowerCase()
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

test('CI runs on push and pull requests to main and develop, and stays callable (#182)', () => {
  const ci = read('.github/workflows/ci.yml')
  const branchesOf = (event: string): string[] => {
    const block = ci.match(new RegExp(`^  ${event}:\\s*\\n\\s+branches:\\s*(\\[[^\\]]*\\]|(?:\\n\\s+- .+)+)`, 'm'))
    assert.ok(block, `ci.yml declares branches under ${event}`)
    return block[1].match(/[\w./-]+/g) ?? []
  }
  for (const event of ['push', 'pull_request'])
    for (const branch of ['main', 'develop'])
      assert.ok(branchesOf(event).includes(branch), `${event} runs on ${branch}`)
  assert.match(ci, /workflow_call:/)
  assert.match(ci, /^permissions:\s*\n\s+contents: read/m, 'ci.yml limits the token to read-only')
  const c = read('CONTRIBUTING.md')
  // The required check names are the job ids: renaming one would make the documented contexts[] unsatisfiable.
  for (const job of ['test', 'e2e-a11y']) {
    assert.match(ci, new RegExp(`^  ${job}:`, 'm'), `ci.yml defines the job ${job}`)
    assert.ok(c.includes(`'contexts[]=${job}'`), `CONTRIBUTING requires the check ${job}`)
    assert.ok(c.includes(`"${job}"`), `the PUT example requires the check ${job}`)
  }
  assert.ok(!/to `main` only/.test(c), 'CONTRIBUTING no longer says the CI is main-only')
  assert.ok(c.includes('required_status_checks'), 'CONTRIBUTING gives the required-checks command')
  assert.ok(c.includes('required_conversation_resolution'), 'the PUT example repeats the existing protection settings')
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

test('the reading guide explains the folder prefix of session tabs and its limits (#246)', () => {
  const guide = guideText()
  for (const term of ['folder prefix', 'git common dir', 'Imported transcripts', 'project heading', 'F2']) {
    assert.ok(guide.includes(term), `guide should mention "${term}"`)
  }
})

test('the reading guide explains repeated reads and calls, with their limits (#234)', () => {
  const guide = guideText()
  assert.match(guide, /## Repeated reads and calls/)
  for (const term of ['no edit seen', 'not compared', 'Grep', 'lower bound', 'Bash', 'not reported']) {
    assert.ok(guide.includes(term), `guide should mention "${term}"`)
  }
  assert.ok(read('README.md').toLowerCase().includes('repeated reads'), 'README mentions the feature')
})

test('the reading guide explains the capabilities of a session and their proof (#242)', () => {
  const guide = guideText()
  assert.match(guide, /## Skills, plugins and memory/)
  for (const term of ['skill_listing', 'mcp_instructions_delta', 'Skill', 'sub-agents', 'Partial', 'Not provided by this relay', 'could not be read', 'not what is installed']) {
    assert.ok(guide.includes(term), `guide should mention "${term}"`)
  }
  assert.ok(read('README.md').includes('capabilities'), 'README mentions the capabilities view')
})

test('the remote access guards and the pairing are documented, with their read-only surface (#241, #517)', () => {
  const doc = read('docs/relay-sources.md')
  assert.match(doc, /## Remote access: guards and pairing \(#241\)/)
  for (const term of ['--allow-host', '--token-file', '--host', 'token', '/events', '/status', '/context', '/issue-links', '/observations', 'POST /scope', 'POST /pair', 'DNS rebinding', 'RELAY_MAX_REMOTE_SSE_CLIENTS']) {
    assert.ok(doc.includes(term), `docs/relay-sources.md should mention "${term}"`)
  }
  assert.ok(doc.includes(`more than ${RELAY_MAX_REMOTE_SSE_CLIENTS} SSE streams`), 'remote SSE cap matches the constant')
  assert.ok(doc.includes(`at most ${RELAY_MAX_ALLOWED_HOSTS} names`), 'allow list cap matches the constant')
  // SSH -L browses http://localhost:<port>: its Host is loopback, so --allow-host does not cover it
  assert.match(doc, /SSH `-L` tunnel is not[\s\S]*`Host: localhost[\s\S]*full loopback surface/i, 'SSH -L is documented as a loopback Host with the full surface')
  assert.match(doc, /`--allow-host` only covers named tunnels/)
  assert.match(doc, /token[^.]*(even|also)[^.]*loopback `Host`/i, 'with --allow-host, the token is required on a loopback Host too')
  for (const f of ['app/src/args.ts', 'scripts/remote-access.ts']) {
    assert.ok(!/SSH -L or Tailscale/.test(read(f)) && !/\(SSH -L, Tailscale serve\)/.test(read(f)), `${f} does not present SSH -L as covered by --allow-host`)
  }
  // Nothing says the token or --allow-host is still missing
  assert.doesNotMatch(doc, /until token authentication ships|No command can create a pairing yet|refused until token/i)
})

test('the launch policy is documented as off by default, with the code constants (#229)', () => {
  const doc = read('docs/node-inspector.md')
  const start = doc.indexOf('## Launch an agent on an issue (#229)')
  assert.ok(start >= 0, 'docs/node-inspector.md should have the launch section')
  const section = doc.slice(start).split(/\n## /)[0]
  assert.match(section, /off by default/i)
  assert.ok(section.includes('(launch-security.md)') || section.includes('[launch-security.md](launch-security.md)'), 'section should link the security page')
  assert.ok(section.includes(`--permission-mode ${LAUNCH_PERMISSION_MODE}`))
  for (const tool of [...LAUNCH_ALLOWED_TOOLS, ...LAUNCH_DISALLOWED_TOOLS.filter(t => !/^(Edit|Write)\(/.test(t))]) {
    assert.ok(section.includes(`\`${tool}\``), `section should list ${tool}`)
  }
  for (const t of LAUNCH_DISALLOWED_TOOLS) {
    const path = /^(?:Edit|Write)\((.*)\)$/.exec(t)?.[1]
    if (path) assert.ok(section.includes(`\`${path}\``), `section should list the protected path ${path}`)
  }
  const caps = LAUNCH_CAPS
  for (const needle of [
    '--setting-sources project', '--strict-mcp-config', 'not a sandbox', '`Bash(gh issue view <n> --repo <owner>/<name>)`',
    `$${caps.budgetUsdDefault}`, `$${caps.budgetUsdMax}`, `${caps.wallClockMs / 60_000} min`, `${caps.outputBufferBytes / 1024} KB`,
    'OWNER', 'MEMBER', 'COLLABORATOR', 'bypassPermissions',
  ]) assert.ok(section.includes(needle), `section should mention ${needle}`)
})

test('no old jobailla repository reference remains outside the CHANGELOG (#224)', () => {
  // The repository was renamed j0hn-42/agent-lens: the old owner name only lives on through a GitHub redirect.
  // `publisher: "jobailla"` is a different identifier and is kept on purpose.
  const old = ['jobailla', 'agent-lens'].join('/')
  const files = trackedFiles(root)
    .filter(f =>!/(^|\/)CHANGELOG/i.test(f) && f !== 'pnpm-lock.yaml' && fs.existsSync(path.join(root, f)))
  const offenders = files.filter(f => {
    const buf = fs.readFileSync(path.join(root, f))
    return !buf.includes(0) && buf.toString('utf8').includes(old)
  })
  assert.deepEqual(offenders, [], `${old} still referenced; use j0hn-42/agent-lens`)
})

/** All TypeScript sources of the UI (web/lib, web/components, web/hooks), lowercased. */
function uiSources(): string {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel)
      else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push(read(rel))
    }
  }
  for (const d of ['web/lib', 'web/components', 'web/hooks']) walk(d)
  return out.join('\n').toLowerCase()
}

test('Honest values: every quoted label exists in the UI (#179)', () => {
  const doc = guideText()
  const section = doc.slice(doc.indexOf('## Honest values'), doc.indexOf('## The `observations` action'))
  // Only the "You see" cell (first column) quotes UI labels; labels with a placeholder (X, N) are templates.
  const seen = section.split('\n').filter(l => l.startsWith('|')).map(l => l.split('|')[1] ?? '').join('\n')
  const labels = [...seen.matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(l => !/\b[XN]\b|\.\.\./.test(l))
  const sources = uiSources()
  for (const label of labels) {
    assert.ok(sources.includes(label.toLowerCase()), `"${label}" is quoted in Honest values but absent from web/lib, web/components and web/hooks`)
  }
  for (const word of ['end not observed', 'not reported', 'at least', 'estimated']) {
    assert.ok(section.includes(`"${word}"`), `Honest values should quote "${word}"`)
  }
})

test('docs cite the English UI labels, not French ones the UI never shows (#179)', () => {
  assert.ok(read('docs/demo.md').includes('end not observed'))
  for (const f of ['docs/demo.md', READING_GUIDE_INDEX]) {
    assert.ok(!/fin non observée|non renseigné/.test(docText(f)), `${f} cites a French label the UI never shows`)
  }
})

test('the theme is documented in Settings, not in the top bar (#179)', () => {
  for (const f of ['README.md', READING_GUIDE_INDEX]) {
    assert.ok(!/\*\*Theme\*\* selector in the top bar/.test(docText(f)), `${f} places the Theme selector in the top bar`)
    assert.ok(/\bSettings\b/.test(docText(f)), `${f} should mention Settings`)
  }
})

// #178: the docs only cite entry points that exist, and the repository URL and Node floor agree everywhere.
test('no doc cites `npx agent-lens-app` while the package is not published (#178)', () => {
  for (const file of ['README.md', 'docs/headless.md', 'docs/mcp-server.md', 'docs/relay-sources.md']) {
    assert.ok(!read(file).includes('npx agent-lens-app'), `${file} cites npx agent-lens-app, which is not published`)
  }
})

test('README documents the real standalone command and its options (#178)', () => {
  const readme = read('README.md')
  assert.ok(readme.includes('pnpm run build:app'), 'README should document pnpm run build:app')
  assert.ok(readme.includes('node app/dist/app.js'), 'README should document node app/dist/app.js')
  for (const flag of ['--port', '--no-open', '--all-workspaces']) {
    assert.ok(readme.includes(flag), `README should document ${flag}`)
  }
})

test('one repository URL in README, CONTRIBUTING and both package.json (#178)', () => {
  const url = 'https://github.com/j0hn-42/agent-lens'
  for (const pkg of ['app/package.json', 'extension/package.json']) {
    assert.equal(JSON.parse(read(pkg)).repository.url, url, `${pkg} repository.url`)
  }
  assert.ok(read('README.md').includes(`${url}.git`), 'README clone URL')
  assert.ok(read('CONTRIBUTING.md').includes(`(${url})`), 'CONTRIBUTING repository link')
})

test('the minimum Node version of the README matches engines.node (#178)', () => {
  const m = read('README.md').match(/Node\.js\]\([^)]*\) (\d+)\+/)
  assert.ok(m, 'README states a minimum Node version')
  assert.equal(JSON.parse(read('app/package.json')).engines.node, `>=${m![1]}`)
})

test('the launch security page states the guards and caps of the code (#229)', () => {
  const doc = read('docs/launch-security.md')
  for (const needle of [
    '--allow-launch', '--launch-repo', '404', '401', '403', '409', '429', 'Authorization: Bearer', 'constant time', 'console',
    'not a sandbox', '0600', 'SIGTERM', 'SIGKILL', '10 s', '**only when it was observed**',
    `at most ${RELAY_LAUNCH_BODY_MAX_BYTES} bytes`, `${RELAY_LAUNCH_RATE_BURST} requests`,
    `${LAUNCH_CAPS.wallClockMs / 60_000}-minute`, `${LAUNCH_CAPS.outputBufferBytes / 1024} KB`, `$${LAUNCH_CAPS.budgetUsdDefault}`, `$${LAUNCH_CAPS.budgetUsdMax}`,
  ]) assert.ok(doc.includes(needle), `docs/launch-security.md should mention ${needle}`)
  assert.ok(read('README.md').includes('(docs/launch-security.md)'), 'README should link docs/launch-security.md')
})

test('the launch docs describe the button, the pasted token and the same-origin limit (#229)', () => {
  for (const file of ['docs/launch-security.md', 'docs/node-inspector.md']) {
    const doc = read(file)
    assert.ok(!/no button or dialog yet|no button yet/i.test(doc), `${file} still says there is no button`)
    assert.ok(doc.includes("Lancer un agent sur l'issue #N"), `${file} names the button`)
    assert.match(doc, /same origin/i, `${file} states the same-origin limit`)
    assert.match(doc, /preflight/i, `${file} explains why (CORS preflight)`)
  }
  const sec = read('docs/launch-security.md')
  for (const needle of ['Jeton du relais', 'localStorage', 'cleared when the dialog closes', 'Annuler', 'Arrêter', 'worktree']) {
    assert.ok(sec.includes(needle), `docs/launch-security.md should mention ${needle}`)
  }
})

test('the reading guide says when the truncation notice is announced: again after full screen, never during it (#453)', () => {
  const section = guideText().split('\n## Graph truncated\n')[1]?.split('\n## ')[0] ?? ''
  assert.ok(section, 'the Graph truncated section exists')
  assert.doesNotMatch(section, /announced once/, 'it is announced again each time full screen gives it back')
  assert.match(section, /again when leaving full screen/)
})

test('the reading guide says how long a dismissal of the truncation notice lasts, and where the loss stays visible (#567)', () => {
  const section = guideText().split('\n## Graph truncated\n')[1]?.split('\n## ')[0] ?? ''
  assert.match(section, /kept for the browser tab/, 'the dismissal lasts for the tab')
  assert.match(section, /comes back when more is lost/)
  assert.match(section, /header of the Sessions panel/, 'the permanent indicator is named with its place')
  assert.match(section, /Show notice/)
  assert.match(section, /Adjustments \(not losses\)/, 'adjustments are not presented as losses')
  assert.doesNotMatch(section, /It comes back if more is dropped later/, 'the old wording, true only for the page')
})

test('the reading guide names the mark on the Sessions button and the lower total that brings the notice back (#569 review)', () => {
  const doc = guideText()
  const section = doc.split('\n## Graph truncated\n')[1]?.split('\n## ')[0] ?? ''
  assert.match(section, /Sessions button of the top bar carries ⚠/, 'the loss stays visible with the panel closed')
  assert.match(section, /graph incomplete, losses listed in the Sessions panel/)
  assert.match(section, /lower than the one it was dismissed at/, 'a relay restart is a new loss')
  // The Language list (glossary of the translated top bar) gives the French wording of the mark
  assert.ok(doc.includes('graphe incomplet, pertes listées dans le panneau Sessions'))
})

test('the reading guide does not promise the sheet always starts under the truncation notice (#453 review)', () => {
  const item = guideText().split('\n').find(l => l.startsWith('- **Hidden panels**')) ?? ''
  assert.ok(item, 'the Hidden panels item exists')
  assert.doesNotMatch(item, /the sheet starts under both, even when/, 'not when the window is too short for both')
  assert.match(item, /starts under both when there is room/)
  assert.match(item, /may cover the truncation notice/)
})

test('the reading guide says a silence never ends a session, only an observed end does (#360)', () => {
  const guide = guideText()
  assert.match(guide, /A silence never ends a session/)
  assert.match(guide, /SessionEnd/)
  const finished = guide.split('\n').find(l => l.startsWith('| **Session finished**'))
  assert.ok(finished?.includes('observed'), 'the Session finished trigger says it needs an observed end')
})

test('the tray doc says what is shipped, what is not, and what the menu never shows (#335)', () => {
  const doc = read('docs/tray.md')
  for (const needle of ['not part of this repository yet', 'unknown', 'at least', 'SIGTERM', 'SIGKILL', 'No shell', '1024 bytes', 'Windows', 'Orca', '/statusline', '--tray-bin', '--attach']) {
    assert.ok(doc.includes(needle), `docs/tray.md should mention ${needle}`)
  }
  assert.ok(read('README.md').includes('(docs/tray.md)'), 'README should link docs/tray.md')
  // #513: the stop channel that replaces SIGTERM, and what is not proven on Windows
  for (const needle of ['--ipc-stop', '{"v":1,"type":"stop"}', 'no route', 'not tested on Windows']) {
    assert.ok(doc.includes(needle), `docs/tray.md should mention ${needle} (#513)`)
  }
  assert.ok(fs.existsSync(path.join(root, 'app-tray/src/driver.ts')))
  // The next probe starts 5 s after the previous one ends: 5 to 7 s apart with the 2 s time limit
  assert.ok(!doc.includes('every 5 seconds'), 'the probe is not sent every 5 seconds')
  assert.ok(doc.includes('5 seconds after the previous probe ends'))
})

test('the reading guide says a Glob has file cards, a flow, and a count from numFiles (#451)', () => {
  const lines = guideText().split('\n')
  const flow = lines.find(l => l.startsWith('- **Flow to the file cards**'))
  assert.ok(flow?.includes('from a Grep or Glob tool card'), 'the flow starts from a Grep or Glob card')
  const cards = lines.find(l => l.startsWith('- **File cards from a search**'))
  assert.ok(cards?.includes('`numFiles` for a Glob'), 'the Glob count is numFiles')
  assert.ok(!cards?.includes("the count is the header's."), "the count is not always the header's")
})

test('the remote access page says what ships, and nothing that does not exist yet (#477, #517)', () => {
  const doc = read('docs/remote-access.md')
  const args = read('app/src/args.ts')
  // Every flag the page names is one the CLI parses (no example that would fail)
  for (const flag of new Set(doc.match(/--[a-z][a-z-]*/g) ?? [])) {
    assert.ok(args.includes(`'${flag}'`), `docs/remote-access.md names ${flag}, which app/src/args.ts does not parse`)
  }
  // Behaviour, not text: --allow-host starts with --token-file (#517), and the page says so; it is refused without it
  assert.equal(remoteStartupError({ allowHosts: ['tunnel.example.ts.net'], tokenFile: '/home/me/pair-token' }), null)
  assert.match(remoteStartupError({ allowHosts: ['tunnel.example.ts.net'] }) ?? '', /--token-file/)
  assert.match(remoteStartupError({ allowHosts: [], tokenFile: '/home/me/pair-token' }) ?? '', /--allow-host/)
  assert.ok(remoteStartupError({ allowHosts: [], host: '0.0.0.0', remote: true }), '--remote --host 0.0.0.0 is refused')
  assert.match(remoteStartupError({ allowHosts: [], host: '::1' }) ?? '', /127\.0\.0\.1/)
  assert.ok(doc.includes('--allow-host box.tail1234.ts.net --token-file'), 'the page gives the command that starts remote access')
  assert.match(doc, /`--allow-host <name>` without `--token-file` \| refused/)
  assert.match(doc, /`--host ::1` \| refused/)
  assert.doesNotMatch(doc, /not usable today|not available today|not usable yet|nothing uses it|no command creates a pairing/i, 'remote access ships: the page must not say otherwise')
  // The command wires the pairing in: the names the page cites are the real ones
  assert.match(read('app/src/app.ts'), /tokenFile: args\.tokenFile/)
  assert.match(read('app/src/server.ts'), /remotePairing: \{ tokenFile/)
  assert.match(read('web/app-entry.tsx'), /pairFromFragment/)
  assert.match(read('web/lib/remote-pairing.ts'), /replaceState[\s\S]*fetch\('\/pair'/, 'the page drops the fragment before POST /pair')
  for (const needle of ['scripts/remote-pairing.ts', 'createRemotePairing', 'POST /pair', 'app/src/pairing-banner.ts', 'web/lib/remote-pairing.ts', 'history.replaceState', 'requiresRemotePairing',
    'scripts/remote-pairing.test.ts', 'scripts/remote-guards.test.ts', 'scripts/entrypoints-hardening.test.ts', '401', '#pair=', PAIR_COOKIE]) {
    assert.ok(doc.includes(needle), `the page cites ${needle}`)
  }
  // Lifetime figures match the code
  assert.ok(doc.includes(`at most ${REMOTE_PAIR_MAX_SESSIONS} pairings`), 'the pairing cap matches REMOTE_PAIR_MAX_SESSIONS')
  assert.ok(doc.includes(`lasts ${REMOTE_PAIR_SESSION_TTL_MS / 3_600_000} hours`), 'the pairing lifetime matches REMOTE_PAIR_SESSION_TTL_MS')
  // What was checked in a browser, and what was not, is said
  assert.match(doc, /checked in Chromium/i)
  assert.match(doc, /Firefox and Safari were not checked/)
  // No environment variable is read for the host or the remote opt-in
  for (const v of ['AGENT_LENS_HOST', 'AGENT_LENS_REMOTE', 'HOST']) assert.ok(doc.includes(`\`${v}\``), `the page names \`${v}\` as ignored`)
  for (const f of fs.readdirSync(path.join(root, 'app/src')).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    assert.doesNotMatch(read(`app/src/${f}`), /process\.env\.(AGENT_LENS_HOST|AGENT_LENS_REMOTE|HOST)\b|env\[['"](AGENT_LENS_HOST|AGENT_LENS_REMOTE|HOST)['"]\]/, `app/src/${f} reads a host environment variable`)
  }
  // Without --allow-host, a port forward with a loopback Host still reaches the loopback surface with no token: said
  assert.match(doc, /port forward/i)
  assert.match(doc, /no token|without (any )?(token|authentication)/i)
  assert.ok(read('docs/relay-sources.md').includes('The same holds for a tunnel that rewrites `Host` to `127.0.0.1`'), 'relay-sources documents the loopback Host case')
  // The headless commands get 401 while --allow-host is on: both pages say it
  assert.ok(doc.includes('relay answered HTTP 401') && read('docs/headless.md').includes('relay answered HTTP 401'))
  assert.ok(read('scripts/headless-cli.ts').includes('relay answered HTTP ${res.statusCode}'))
  // The phone view: issue #476, delivered by PR #481
  assert.ok(doc.includes('#476') && doc.includes('#481'), 'the page cites the phone-view issue and PR')
  // The dev relay refuses the remote flags outright
  assert.ok(read('scripts/dev-relay.ts').includes("'--allow-host'"), 'the dev relay refuses --allow-host')
  for (const issue of ['#241', '#475', '#517', '#335']) assert.ok(doc.includes(issue), `the page points to ${issue}`)
  // Links: the README, the event-source guards and the CLI help agree with the page
  assert.ok(read('README.md').includes('(docs/remote-access.md)'), 'README links docs/remote-access.md')
  assert.ok(doc.includes('(relay-sources.md#remote-access-guards-and-pairing-241)'), 'the page links the guards section of relay-sources')
  assert.ok(args.includes('Needs --token-file'), 'the CLI help says --allow-host needs --token-file')
  assert.doesNotMatch(args, /until token authentication/, 'the CLI help no longer says the token is missing')
  // The phone view is the one the reading guide describes: the 768 px breakpoint
  assert.ok(doc.includes('768 px'), 'the page gives the phone-width breakpoint')
  assert.ok(guideText().includes('Phone width (below 768 px)'), 'the reading guide has the phone-width section')
})

test('the reading guide says a detail popup never covers a permission request, and what is measured (#536)', () => {
  const guide = guideText()
  const start = guide.indexOf('### Permission requests (VS Code only)')
  assert.ok(start >= 0, 'the Permission requests heading is found')
  const section = guide.slice(start, guide.indexOf('\n## ', start))
  for (const needle of ['popup-permission.e2e.ts', '320x568', '1024x768', '640x300', 'Escape', 'Chromium', 'Not proven', 'outline button', 'more than one pending card', 'click on the canvas']) {
    assert.ok(section.includes(needle), `the Permission requests section should mention ${needle}`)
  }
})

test('the Go protocol module of the tray is checked in CI, listed in CONTRIBUTING and documented, without claiming an icon (#510)', () => {
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /go-version-file: app-tray\/native\/go\.mod/, 'ci.yml installs Go from app-tray/native/go.mod')
  const goSteps = ci.slice(ci.indexOf('go-version-file: app-tray/native/go.mod'))
  for (const run of ['test -z "$(gofmt -l .)"', 'go vet ./...', 'go test ./...']) {
    assert.ok(goSteps.includes(`run: ${run}`), `ci.yml runs ${run}`)
    assert.ok(read('CONTRIBUTING.md').includes(run), `CONTRIBUTING should list ${run}`)
  }
  assert.match(goSteps, /working-directory: app-tray\/native/)
  const doc = read('docs/tray.md')
  for (const needle of ['app-tray/native/', 'protocol-fixtures.json', 'no icon is drawn', 'not part of this repository yet']) {
    assert.ok(doc.includes(needle), `docs/tray.md should mention ${needle}`)
  }
  assert.ok(fs.existsSync(path.join(root, 'app-tray/native/go.mod')))
  // No compiled binary is committed: only Go sources and the module files. The files git tracks, not the working
  // tree: a local `go test -c`, `-coverprofile` or `.DS_Store` is not committed and must not fail the test (#613)
  const files = trackedFiles(root, 'app-tray/native')
  assert.ok(files.includes('app-tray/native/go.mod'), 'app-tray/native is tracked by git')
  for (const f of files) assert.match(path.posix.basename(f), /^(go\.mod|go\.sum|.+\.go)$/, `unexpected file committed in app-tray/native: ${f}`)
})

test('relay-sources documents how Cursor hook payloads are ignored, with the doc they rely on (#472)', () => {
  const doc = read('docs/relay-sources.md')
  assert.match(doc, /## Cursor hook payloads are ignored \(#472\)/)
  for (const term of ['https://cursor.com/docs/hooks', 'https://cursor.com/docs/reference/third-party-hooks', '`cursor_version`', 'getForeignHookStats', 'step 0', 'not real captures']) {
    assert.ok(doc.includes(term), `docs/relay-sources.md should mention "${term}"`)
  }
})

test('CONTRIBUTING documents the shared Button and its variants (#508)', () => {
  const c = read('CONTRIBUTING.md')
  const src = read('web/components/ui/button.tsx')
  assert.ok(c.includes('## Shared Button in the web UI'), 'has its section')
  assert.ok(c.includes('web/components/ui/button.tsx'), 'names the component file')
  const variants = src.match(/export type ButtonVariant = ([^\n]+)/)?.[1].match(/'(\w+)'/g)?.map(v => v.replace(/'/g, '')) ?? []
  assert.ok(variants.length >= 4, 'the component declares its variants')
  for (const v of variants) assert.ok(c.includes(`\`${v}\``), `CONTRIBUTING documents the variant ${v}`)
  for (const file of ['web/tests-a11y/button-pins.test.tsx', 'web/tests-a11y/button-theme.test.tsx'])
    assert.ok(c.includes(file) && fs.existsSync(path.join(root, file)), `CONTRIBUTING cites ${file}`)
})
