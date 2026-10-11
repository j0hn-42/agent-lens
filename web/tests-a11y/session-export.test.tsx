// Session export and standalone HTML replay (#237): secret redaction on real-looking patterns, the export
// envelope, a single self-contained file (CSP, no network, no external script), strict escaping of the
// transcript, and a replay page that is keyboard-operable, named and honest about what it does not know.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { JSDOM } from 'jsdom'
import axe from 'axe-core'

import { redactSecrets, redactText, createRedactionCounts } from '@/lib/secret-redaction'
import {
  buildSessionExport, renderReplayHtml, embedJson, sessionExportFileName,
  REPLAY_SCRIPT, REPLAY_STYLE, REPLAY_SCRIPT_HASH, REPLAY_STYLE_HASH, SESSION_EXPORT_SCHEMA,
} from '@/lib/session-export'
import { createSessionBuffers, appendSessionEvent, sessionExportSlice, bufferedEventCount } from '@/lib/session-buffers'
import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import { sanitizeSessionInfo, type SessionInfo } from '@/lib/bridge-types'
import type { FreshnessClock } from '@/hooks/use-freshness-clock'
import type { SimulationEvent } from '@/lib/agent-types'

afterEach(() => { cleanup() })

// Fake credentials, assembled at runtime so that no secret scanner flags this file. Same shapes as the real ones.
const SECRETS = {
  anthropic: 'sk-' + 'ant-api03-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z_AbC-dEfGh12',
  openai: 'sk-' + 'proj-' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe',
  github: 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  githubPat: 'github_' + 'pat_' + '11ABCDEFG0' + 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6kL9nP2rS5uV8xA1',
  aws: 'AK' + 'IA' + 'IOSFODNN7EXAMPLE',
  slack: 'xo' + 'xb-' + '1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx',
  google: 'AI' + 'za' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q',
  jwt: 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  bearer: 'abcDEF123456ghiJKL789mno',
  pemBody: 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun',
  password: 'hunter2-Secret!',
  apiKeyJson: 'q9F2kL7xP3mZ8vB1',
  urlPass: 's3cr3tPa55',
}
const PEM = `-----BEGIN ${'RSA PRIVATE'} KEY-----\n${SECRETS.pemBody}\nAbCd==\n-----END ${'RSA PRIVATE'} KEY-----`

// ── Redaction ──

test('known credential formats are replaced by a typed marker', () => {
  const cases: [string, string][] = [
    [`key ${SECRETS.anthropic} used`, 'anthropic-key'],
    [`OPENAI=${SECRETS.openai}`, 'openai-key'],
    [`remote https://${SECRETS.github}@github.com/x`, 'github-token'],
    [`token ${SECRETS.githubPat}`, 'github-token'],
    [`aws id ${SECRETS.aws} region`, 'aws-access-key'],
    [`slack ${SECRETS.slack}`, 'slack-token'],
    [`maps ${SECRETS.google}`, 'google-api-key'],
    [`cookie ${SECRETS.jwt}`, 'jwt'],
    [`Authorization: Bearer ${SECRETS.bearer}`, 'bearer-token'],
    [`key:\n${PEM}\nend`, 'private-key'],
  ]
  for (const [input, type] of cases) {
    const counts = createRedactionCounts()
    const out = redactText(input, counts)
    assert.ok(out.includes(`[REDACTED:${type}]`), `${type}: ${out}`)
    for (const s of Object.values(SECRETS)) assert.ok(!out.includes(s), `${type}: a secret survived in ${out}`)
    assert.ok(counts.total >= 1 && (counts.byType[type] ?? 0) >= 1, `${type} is counted`)
  }
  assert.equal(redactText(`Authorization: Bearer ${SECRETS.bearer}`), 'Authorization: Bearer [REDACTED:bearer-token]')
})

test('secret assignments keep their name and lose their value, in text, env files and JSON', () => {
  assert.equal(redactText(`DB_PASSWORD=${SECRETS.password} next`), 'DB_PASSWORD=[REDACTED:secret] next')
  assert.equal(redactText(`{"api_key": "${SECRETS.apiKeyJson}"}`), '{"api_key": "[REDACTED:secret]"}')
  assert.equal(redactText(`client_secret: ${SECRETS.apiKeyJson}`), 'client_secret: [REDACTED:secret]')
  assert.equal(redactText(`export GITHUB_TOKEN='${SECRETS.apiKeyJson}'`), `export GITHUB_TOKEN='[REDACTED:secret]'`)
  assert.equal(redactText(`postgres://admin:${SECRETS.urlPass}@db.local:5432/x`), 'postgres://[REDACTED:url-credentials]@db.local:5432/x')
})

test('personal home directories are replaced by ~ on Linux, macOS and Windows', () => {
  const counts = createRedactionCounts()
  assert.equal(redactText('read /home/jdoe/projects/app/src/index.ts', counts), 'read ~/projects/app/src/index.ts')
  assert.equal(redactText('open /Users/jane.doe/Library/x.plist', counts), 'open ~/Library/x.plist')
  assert.equal(redactText('cd C:\\Users\\Bob\\code\\app', counts), 'cd ~\\code\\app')
  assert.equal(redactText('file:///home/jdoe/a.txt', counts), 'file://~/a.txt')
  assert.equal(counts.byType['home-path'], 4)
  // A path segment named Users inside a URL is not a home directory
  assert.equal(redactText('GET https://api.example.com/Users/42'), 'GET https://api.example.com/Users/42')
})

test('ordinary code and numbers are not mistaken for secrets', () => {
  const keep = [
    'const token: string = read()',
    'max_tokens: 1024, inputTokens=1200',
    'password: undefined',
    'apiKey = process.env.ANTHROPIC_API_KEY',
    'The secret is to keep tests small.',
    'sha 3f2a9c1e, run 12345',
  ]
  for (const s of keep) assert.equal(redactText(s), s)
})

test('redactSecrets walks objects and arrays deeply, keys included, without mutating its input', () => {
  const input = {
    content: `use ${SECRETS.anthropic}`,
    nested: { list: [`ok`, `Bearer ${SECRETS.bearer}`, 42, true, null], [`/home/jdoe/x`]: 'file' },
    n: 3,
  }
  const before = JSON.stringify(input)
  const counts = createRedactionCounts()
  const out = redactSecrets(input, counts)
  assert.equal(JSON.stringify(input), before, 'the input is untouched')
  assert.equal(out.content, 'use [REDACTED:anthropic-key]')
  assert.deepEqual(out.nested.list, ['ok', 'Bearer [REDACTED:bearer-token]', 42, true, null])
  assert.ok('~/x' in out.nested, 'object keys are redacted too')
  assert.equal(out.n, 3)
  assert.equal(counts.total, 3)
})

test('control and bidi characters are removed from exported text', () => {
  assert.equal(redactText('a\u0007b\u202Ec\u200Bd\te\nf'), 'abcd\te\nf')
})

// ── Export envelope ──

const ev = (time: number, type: SimulationEvent['type'], payload: Record<string, unknown>, extra: Partial<SimulationEvent> = {}): SimulationEvent =>
  ({ time, type, payload, sessionId: 's1', ...extra })

const EVENTS: SimulationEvent[] = [
  ev(0, 'agent_spawn', { name: 'main', isMain: true }),
  ev(1.5, 'message', { agent: 'main', role: 'assistant', content: `Using ${SECRETS.github} from /home/jdoe/repo` }),
  ev(2, 'agent_spawn', { name: 'explorer', parent: 'main' }),
  ev(3, 'tool_call_start', { agent: 'helper', tool: 'Bash', args: 'echo </script><script>window.__pwned=1</script>' }),
  ev(4, 'message', { agent: 'explorer', content: '<img src=x onerror="window.__pwned=2"> & <b>bold</b>' }),
  ev(5, 'agent_idle', { name: 'explorer' }),
  ev(6, 'agent_complete', { name: 'explorer' }, { replayed: true }),
]

test('the export envelope states its schema, counts, losses and redactions, and carries no secret', () => {
  const exp = buildSessionExport({
    sessionId: 's1', label: 'repo at /home/jdoe/repo', events: EVENTS, droppedBefore: 12, now: new Date('2026-10-11T10:00:00Z'),
  })
  assert.equal(exp.schema, SESSION_EXPORT_SCHEMA)
  assert.equal(exp.kind, 'agent-lens-session')
  assert.equal(exp.sessionId, 's1')
  assert.equal(exp.label, 'repo at ~/repo')
  assert.equal(exp.exportedAt, '2026-10-11T10:00:00.000Z')
  assert.equal(exp.eventCount, EVENTS.length)
  assert.equal(exp.events.length, EVENTS.length)
  assert.equal(exp.droppedBefore, 12)
  assert.equal(exp.redactions.byType['github-token'], 1)
  assert.equal(exp.redactions.byType['home-path'], 2)
  assert.equal(exp.redactions.total, 3)
  assert.equal(exp.events[6].replayed, true, 'history-replay flag is kept')
  assert.equal('sessionId' in exp.events[0], false, 'per-event session ids are not repeated')
  const json = JSON.stringify(exp)
  assert.ok(!json.includes(SECRETS.github) && !json.includes('jdoe'))
})

test('embedded JSON cannot close its script element nor break the parser', () => {
  const s = embedJson({ a: '</script><!-- \u2028 & >' })
  assert.ok(!/[<>&\u2028\u2029]/.test(s), s)
  assert.deepEqual(JSON.parse(s), { a: '</script><!-- \u2028 & >' })
})

test('the file name is a safe slug with the export time', () => {
  const exp = buildSessionExport({ sessionId: 's1', label: 'Fix: the "auth" bug!', events: EVENTS, droppedBefore: 0, now: new Date('2026-10-11T10:05:00Z') })
  assert.equal(sessionExportFileName(exp), 'agent-lens-session-fix-the-auth-bug-20261011-1005.html')
})

// ── The HTML file ──

const sha = (s: string) => `sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}`

function html(droppedBefore = 0, events = EVENTS) {
  return renderReplayHtml(buildSessionExport({ sessionId: 's1', label: 'demo <b>label</b>', events, droppedBefore, now: new Date('2026-10-11T10:00:00Z') }))
}

test('the file is self-contained: one inline script and style, pinned by hash in a no-network CSP', () => {
  const page = html()
  assert.equal(REPLAY_SCRIPT_HASH, sha(REPLAY_SCRIPT), 'update REPLAY_SCRIPT_HASH after editing the script')
  assert.equal(REPLAY_STYLE_HASH, sha(REPLAY_STYLE), 'update REPLAY_STYLE_HASH after editing the style')
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(page)?.[1]
  assert.ok(csp, 'a CSP meta is present')
  assert.match(csp, /default-src 'none'/)
  assert.ok(csp.includes(`script-src '${REPLAY_SCRIPT_HASH}'`))
  assert.ok(csp.includes(`style-src '${REPLAY_STYLE_HASH}'`))
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'))
  assert.ok(page.includes(`<script>${REPLAY_SCRIPT}</script>`))
  assert.ok(page.includes(`<style>${REPLAY_STYLE}</style>`))
  assert.ok(!/<link\b/i.test(page), 'no linked resource')
  assert.ok(!/\s(src|href)\s*=/i.test(page.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '')), 'no src or href attribute')
  assert.ok(!/https?:\/\//i.test(REPLAY_SCRIPT + REPLAY_STYLE), 'no URL in the script or the style')
  assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\s*\(|eval|Function\s*\()/.test(REPLAY_SCRIPT), 'no network or dynamic code API')
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(REPLAY_SCRIPT), 'text is inserted with textContent only')
  assert.equal((page.match(/<script\b/g) ?? []).length, 2, 'the data block and the replay script, nothing injected')
  assert.equal((page.match(/<\/script>/g) ?? []).length, 2)
  assert.ok(page.includes('<title>Session replay: demo &lt;b&gt;label&lt;/b&gt;</title>'))
  assert.ok(!page.includes(SECRETS.github) && !page.includes('jdoe'))
})

/** Load the file in a fresh jsdom window with its script running, as a browser would. */
function load(page: string) {
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true })
  const doc = dom.window.document
  const byId = (id: string) => doc.getElementById(id) as HTMLElement
  return { dom, doc, byId, win: dom.window as unknown as { __pwned?: number; Event: typeof Event; MouseEvent: typeof MouseEvent } }
}

test('transcript content is shown as text, never parsed as HTML or run as script', () => {
  const { doc, byId, win } = load(html())
  assert.equal(win.__pwned, undefined)
  assert.equal(doc.querySelectorAll('img, b, script:not([type])').length, 1, 'only the replay script itself')
  const log = byId('event-log')
  assert.ok(log.textContent!.includes('<img src=x onerror="window.__pwned=2"> & <b>bold</b>'), 'the markup is visible as text')
  const scrub = byId('scrubber') as HTMLInputElement
  scrub.value = '3'
  scrub.dispatchEvent(new (doc.defaultView as unknown as { Event: typeof Event }).Event('input', { bubbles: true }))
  assert.ok(byId('current-payload').textContent!.includes('</script><script>window.__pwned=1</script>'))
  assert.equal(byId('session-label').textContent, 'demo <b>label</b>')
})

test('the scrubber is a named range; buttons step and the position is announced', () => {
  const { doc, byId, win } = load(html())
  const scrub = byId('scrubber') as HTMLInputElement
  assert.equal(scrub.type, 'range')
  assert.equal(doc.querySelector('label[for="scrubber"]')?.textContent, 'Position in the session')
  assert.equal(scrub.min, '0')
  assert.equal(scrub.max, String(EVENTS.length - 1))
  assert.equal(scrub.value, String(EVENTS.length - 1), 'opens on the last event: the whole snapshot')
  assert.equal(scrub.getAttribute('aria-valuetext'), `Event 7 of 7: agent_complete`)
  const next = byId('next') as HTMLButtonElement
  const prev = byId('prev') as HTMLButtonElement
  assert.equal(next.disabled, true, 'nothing after the last event')
  assert.equal(next.textContent, 'Next event')
  assert.equal(prev.textContent, 'Previous event')

  prev.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  assert.equal(scrub.value, '5')
  assert.equal(byId('announce').getAttribute('role'), 'status')
  assert.equal(byId('announce').textContent, 'Event 6 of 7: agent_idle')

  // A keyboard move on the native range fires input; the view follows
  scrub.value = '0'
  scrub.dispatchEvent(new win.Event('input', { bubbles: true }))
  assert.equal(prev.disabled, true)
  const visible = [...byId('event-log').querySelectorAll('li')].filter(li => !li.hidden)
  assert.equal(visible.length, 1, 'the log shows the events up to the position only')
  assert.equal(visible[0].getAttribute('aria-current'), 'step')
  assert.match(byId('current-meta').textContent!, /Event 1 of 7 · agent_spawn · stream time 0\.0 s/)
  assert.match(byId('current-payload').textContent!, /"name": "main"/)
})

test('agent states come only from lifecycle events seen so far; anything else is unknown', () => {
  const { byId, win } = load(html())
  const scrub = byId('scrubber') as HTMLInputElement
  const states = () => [...byId('agents').querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('th, td')].slice(0, 2).map(c => c.textContent))
  const go = (i: number) => { scrub.value = String(i); scrub.dispatchEvent(new win.Event('input', { bubbles: true })) }

  go(0)
  assert.deepEqual(states(), [['main', 'started']])
  go(3)
  assert.deepEqual(states(), [['main', 'started'], ['explorer', 'started'], ['helper', 'unknown']])
  go(5)
  assert.deepEqual(states().find(r => r[0] === 'explorer'), ['explorer', 'idle'])
  go(6)
  assert.deepEqual(states().find(r => r[0] === 'explorer'), ['explorer', 'complete'])
  assert.match(byId('current-meta').textContent!, /history replay/, 'a replayed event says its time is not wall-clock work')
})

test('play steps one event at a time and is a toggle button', () => {
  const { byId, win } = load(html())
  const play = byId('play') as HTMLButtonElement
  assert.equal(play.getAttribute('aria-pressed'), 'false')
  assert.equal(play.textContent, 'Play')
  play.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  assert.equal(play.getAttribute('aria-pressed'), 'true')
  assert.equal(play.textContent, 'Pause')
  assert.equal((byId('scrubber') as HTMLInputElement).value, '0', 'play from the end starts over')
  play.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  assert.equal(play.getAttribute('aria-pressed'), 'false')
  assert.match(byId('announce').textContent!, /Paused at event 1 of 7/)
})

test('the header states what the file contains and what it does not', () => {
  const full = load(html(0))
  assert.equal(full.byId('incomplete').hidden, true)
  const facts = full.byId('facts').textContent!
  assert.match(facts, /Events in this file7/)
  assert.match(facts, /Exported at2026-10-11T10:00:00.000Z/)
  assert.match(facts, /Secrets redacted2 \(best effort/)
  assert.match(full.doc.body.textContent!, /stream times/i)

  const cut = load(html(40))
  assert.equal(cut.byId('incomplete').hidden, false)
  assert.match(cut.byId('incomplete').textContent!, /Incomplete history: 40 earlier events/)
})

test('an empty export says so and disables the controls', () => {
  const { byId } = load(html(0, []))
  assert.equal((byId('scrubber') as HTMLInputElement).disabled, true)
  assert.equal((byId('play') as HTMLButtonElement).disabled, true)
  assert.match(byId('position').textContent!, /No event in this export/)
})

test('the replay page has no axe violation', async () => {
  const { dom } = load(html(3))
  const w = dom.window as unknown as { eval: (s: string) => void; axe: typeof axe }
  w.eval(axe.source)
  const results = await w.axe.run(dom.window.document, { rules: { 'color-contrast': { enabled: false } } })
  // Array.from: the results come from the jsdom realm
  assert.deepEqual(Array.from(results.violations, v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), [])
})

// ── Buffer slice ──

test('the export slice returns the buffered events and how many were dropped before them', () => {
  const s = createSessionBuffers()
  for (let i = 0; i < 12; i++) appendSessionEvent(s, 'a', ev(i, 'message', { i }), null, 10)
  const slice = sessionExportSlice(s, 'a')
  assert.equal(slice.events.length, 10)
  assert.equal(slice.droppedBefore, 2)
  assert.equal(bufferedEventCount(s, 'a'), 10)
  assert.deepEqual(sessionExportSlice(s, 'missing'), { events: [], droppedBefore: 0 })
  assert.equal(bufferedEventCount(s, 'missing'), 0)
  slice.events.length = 0
  assert.equal(bufferedEventCount(s, 'a'), 10, 'the slice is a copy')
})

// ── Sessions panel button ──

const T0 = 1_000_000_000_000
const noop = () => {}
const clock: FreshnessClock = { getNow: () => T0, subscribe: () => () => {} }
const sessions = ([
  { id: 'live', label: 'payments-api', status: 'active', startTime: T0 - 60_000, lastActivityTime: T0 - 1000 },
  { id: 'empty', label: 'quiet-one', status: 'active', startTime: T0 - 60_000, lastActivityTime: T0 - 1000 },
] as SessionInfo[]).map(sanitizeSessionInfo)

test('each session with events offers a named, keyboard-reachable export button', () => {
  const exported: string[] = []
  const view = render(
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="live" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map() as never}
      selectedAgentId={null} onSelectAgent={noop} now={T0} freshnessClock={clock}
      canExportSession={id => id === 'live'} onExportSession={id => exported.push(id)}
    />,
  )
  const btn = view.getByRole('button', { name: 'Export session payments-api as an HTML replay' })
  assert.equal(btn.tagName, 'BUTTON')
  assert.equal(btn.getAttribute('tabindex'), null, 'in the tab order like the rename and close buttons')
  assert.equal(view.queryByRole('button', { name: 'Export session quiet-one as an HTML replay' }), null, 'no event, no export')
  fireEvent.click(btn)
  assert.deepEqual(exported, ['live'])
})

test('without an export handler (demo) no export button is drawn', () => {
  const view = render(
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="live" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map() as never}
      selectedAgentId={null} onSelectAgent={noop} now={T0} freshnessClock={clock}
    />,
  )
  assert.equal(view.queryAllByRole('button', { name: /^Export session/ }).length, 0)
})
