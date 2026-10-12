// #129 #134 #135 #136: the documentation stays consistent with the code and with itself.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { RELAY_LAUNCH_BODY_MAX_BYTES, RELAY_LAUNCH_RATE_BURST, RELAY_MAX_ALLOWED_HOSTS, RELAY_MAX_REMOTE_SSE_CLIENTS } from '../extension/src/constants'
import { LAUNCH_ALLOWED_TOOLS, LAUNCH_CAPS, LAUNCH_DISALLOWED_TOOLS, LAUNCH_PERMISSION_MODE } from '../extension/src/launch-policy'

const root = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')

/** Relative markdown links ([text](target)) of a file, without anchors and external URLs. */
function relativeLinks(file: string): string[] {
  return [...read(file).matchAll(/\]\(([^)\s]+)\)/g)]
    .map(m => m[1].split('#')[0])
    .filter(t => t && !/^[a-z]+:/i.test(t))
}

for (const file of ['README.md', 'CONTRIBUTING.md', 'docs/reading-the-ui.md', 'docs/headless.md', 'docs/mcp-server.md', 'docs/launch-security.md']) {
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
  const guide = read('docs/reading-the-ui.md')
  for (const term of ['folder prefix', 'git common dir', 'Imported transcripts', 'project heading', 'F2']) {
    assert.ok(guide.includes(term), `guide should mention "${term}"`)
  }
})

test('the reading guide explains repeated reads and calls, with their limits (#234)', () => {
  const guide = read('docs/reading-the-ui.md')
  assert.match(guide, /## Repeated reads and calls/)
  for (const term of ['no edit seen', 'not compared', 'Grep', 'lower bound', 'Bash', 'not reported']) {
    assert.ok(guide.includes(term), `guide should mention "${term}"`)
  }
  assert.ok(read('README.md').toLowerCase().includes('repeated reads'), 'README mentions the feature')
})

test('the reading guide explains the capabilities of a session and their proof (#242)', () => {
  const guide = read('docs/reading-the-ui.md')
  assert.match(guide, /## Skills, plugins and memory/)
  for (const term of ['skill_listing', 'mcp_instructions_delta', 'Skill', 'sub-agents', 'Partial', 'Not provided by this relay', 'could not be read', 'not what is installed']) {
    assert.ok(guide.includes(term), `guide should mention "${term}"`)
  }
  assert.ok(read('README.md').includes('capabilities'), 'README mentions the capabilities view')
})

test('the remote access guards are documented as refused at startup, with their read-only surface (#241)', () => {
  const doc = read('docs/relay-sources.md')
  assert.match(doc, /## Remote access: guards only \(#241, step 1\)/)
  for (const term of ['--allow-host', '--host', 'refuses to start', 'token', '/events', '/status', '/context', '/issue-links', '/observations', 'POST /scope', 'DNS rebinding', 'RELAY_MAX_REMOTE_SSE_CLIENTS']) {
    assert.ok(doc.includes(term), `docs/relay-sources.md should mention "${term}"`)
  }
  assert.ok(doc.includes(`more than ${RELAY_MAX_REMOTE_SSE_CLIENTS} SSE streams`), 'remote SSE cap matches the constant')
  assert.ok(doc.includes(`at most ${RELAY_MAX_ALLOWED_HOSTS} names`), 'allow list cap matches the constant')
  // SSH -L browses http://localhost:<port>: its Host is loopback, so --allow-host does not cover it
  assert.match(doc, /SSH `-L` tunnel is not[\s\S]*`Host: localhost[\s\S]*full loopback surface/i, 'SSH -L is documented as a loopback Host with the full surface')
  assert.match(doc, /`--allow-host` only covers named tunnels/)
  assert.match(doc, /token[^.]*(even|also)[^.]*loopback `Host`/i, 'step 2 must also cover a loopback Host reached remotely')
  for (const f of ['app/src/args.ts', 'scripts/remote-access.ts']) {
    assert.ok(!/SSH -L or Tailscale/.test(read(f)) && !/\(SSH -L, Tailscale serve\)/.test(read(f)), `${f} does not present SSH -L as covered by --allow-host`)
  }
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
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(f => f && !/(^|\/)CHANGELOG/i.test(f) && f !== 'pnpm-lock.yaml' && fs.existsSync(path.join(root, f)))
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
  const doc = read('docs/reading-the-ui.md')
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
  for (const f of ['docs/demo.md', 'docs/reading-the-ui.md']) {
    assert.ok(!/fin non observée|non renseigné/.test(read(f)), `${f} cites a French label the UI never shows`)
  }
})

test('the theme is documented in Settings, not in the top bar (#179)', () => {
  for (const f of ['README.md', 'docs/reading-the-ui.md']) {
    assert.ok(!/\*\*Theme\*\* selector in the top bar/.test(read(f)), `${f} places the Theme selector in the top bar`)
    assert.ok(/\bSettings\b/.test(read(f)), `${f} should mention Settings`)
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
