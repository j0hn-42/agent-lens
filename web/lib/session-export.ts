/**
 * Session export as one standalone HTML file (#237): a read-only snapshot of the buffered events of a session,
 * secrets redacted before anything is written, with a keyboard scrubber to replay it.
 *
 * Security: the file loads nothing. Its CSP is `default-src 'none'` and only allows the inline script and
 * style below, pinned by their SHA-256 (REPLAY_SCRIPT_HASH / REPLAY_STYLE_HASH, checked by a test). The
 * session data sits in a JSON block whose `<`, `>` and `&` are escaped, so no transcript text can close it;
 * the script puts text in the page with `textContent` only.
 *
 * Honesty: the file says how many events it holds, how many were dropped before the export, how many secrets
 * were redacted (best effort), that times are stream times, and derives agent states only from lifecycle
 * events (anything else is "unknown").
 */
import type { SimulationEvent } from '@/lib/agent-types'
import { CONTROL_ALL } from '@/lib/control-chars'
import { createRedactionCounts, redactSecrets, redactText, type RedactionCounts } from '@/lib/secret-redaction'

export const SESSION_EXPORT_SCHEMA = 1

export interface ExportedEvent {
  time: number
  type: SimulationEvent['type']
  payload: Record<string, unknown>
  replayed?: true
  imported?: true
}

export interface SessionExport {
  schema: typeof SESSION_EXPORT_SCHEMA
  kind: 'agent-lens-session'
  sessionId: string
  label: string
  /** ISO time of the export */
  exportedAt: string
  eventCount: number
  /** Events of the session dropped from memory before the export (the file starts after them) */
  droppedBefore: number
  redactions: RedactionCounts
  events: ExportedEvent[]
}

export interface SessionExportInput {
  sessionId: string
  label: string
  events: readonly SimulationEvent[]
  droppedBefore: number
  now?: Date
}

export function buildSessionExport({ sessionId, label, events, droppedBefore, now = new Date() }: SessionExportInput): SessionExport {
  const redactions = createRedactionCounts()
  const out: ExportedEvent[] = events.map(e => {
    const x: ExportedEvent = { time: e.time, type: e.type, payload: redactSecrets(e.payload ?? {}, redactions) }
    if (e.replayed) x.replayed = true
    if (e.imported) x.imported = true
    return x
  })
  return {
    schema: SESSION_EXPORT_SCHEMA,
    kind: 'agent-lens-session',
    sessionId: redactText(sessionId).replace(CONTROL_ALL, ''),
    label: redactText(label, redactions).replace(CONTROL_ALL, ''),
    exportedAt: now.toISOString(),
    eventCount: out.length,
    droppedBefore: Math.max(0, Math.floor(droppedBefore) || 0),
    redactions,
    events: out,
  }
}

/** JSON safe inside a `<script>` element: nothing in it can end the element or start markup. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function sessionExportFileName(exp: SessionExport): string {
  const slug = exp.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'session'
  const stamp = exp.exportedAt.slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  return `agent-lens-session-${slug}-${stamp}.html`
}

// Colours: the default theme (Catppuccin Macchiato tokens of web/lib/theme-tokens.json) and, for a light
// system, the matching Catppuccin Latte values.
export const REPLAY_STYLE = `
:root{color-scheme:dark;--bg:#1e2030;--panel:#24273a;--edge:#494d64;--control:#8087a2;--ink:#cad3f5;--muted:#a5adcb;--accent:#c6a0f6;--on-accent:#181926;--focus:#8aadf4;--warn:#eed49f}
@media (prefers-color-scheme: light){:root{color-scheme:light;--bg:#eff1f5;--panel:#e6e9ef;--edge:#bcc0cc;--control:#7c7f93;--ink:#4c4f69;--muted:#5c5f77;--accent:#8839ef;--on-accent:#ffffff;--focus:#1e66f5;--warn:#8a4d00}}
*{box-sizing:border-box}
[hidden]{display:none !important}
body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:1.3rem;margin:0 0 4px}
h2{font-size:1rem;margin:0 0 8px}
header,section{background:var(--panel);border:1px solid var(--edge);border-radius:8px;padding:12px 16px;margin:0 0 12px}
main{display:grid;gap:0 12px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
main>section:first-child,main>section:last-child{grid-column:1/-1}
@media (max-width:800px){main{grid-template-columns:minmax(0,1fr)}}
.note{color:var(--muted);margin:4px 0}
.warn{color:var(--warn);font-weight:600}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:8px 0 0}
dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere}
label{display:block;font-weight:600;margin-bottom:4px}
input[type=range]{width:100%;accent-color:var(--accent);min-height:24px}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
button{font:inherit;min-height:32px;padding:4px 12px;border-radius:6px;border:1px solid var(--control);background:transparent;color:var(--ink);cursor:pointer}
button[aria-pressed=true]{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
button:disabled{opacity:.6;cursor:default}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.scroll{max-height:24rem;overflow:auto;border:1px solid var(--edge);border-radius:6px;padding:8px}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
ol{margin:0;padding-left:3.5em;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
li{overflow-wrap:anywhere}
li[aria-current=step]{background:var(--bg);outline:1px solid var(--accent)}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:2px 8px 2px 0;border-bottom:1px solid var(--edge);overflow-wrap:anywhere}
thead th{color:var(--muted);font-weight:600}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`

export const REPLAY_SCRIPT = `
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('session-data').textContent);
  var events = Array.isArray(data.events) ? data.events : [];
  var n = events.length;
  var LIFECYCLE = { agent_spawn: 'started', agent_idle: 'idle', agent_complete: 'complete' };
  var STEP_MS = 800;
  function byId(id) { return document.getElementById(id); }
  function el(tag, text) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; }
  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function clip(s, max) { return s.length > max ? s.slice(0, max) + '…' : s; }
  function streamTime(t) { return typeof t === 'number' && isFinite(t) ? 'stream time ' + t.toFixed(1) + ' s' : 'time unknown'; }
  function payloadOf(ev) { return ev && ev.payload && typeof ev.payload === 'object' ? ev.payload : {}; }
  function summary(ev) {
    var p = payloadOf(ev);
    var who = str(p.agent) || str(p.name);
    var what = str(p.tool) || str(p.content) || str(p.message);
    return [who, clip(what.replace(/\\s+/g, ' '), 160)].filter(Boolean).join(' · ');
  }
  function label(i) { return 'Event ' + (i + 1) + ' of ' + n + ': ' + events[i].type; }

  byId('session-label').textContent = str(data.label) || 'unnamed session';
  var facts = byId('facts');
  function fact(name, value) { facts.appendChild(el('dt', name)); facts.appendChild(el('dd', value)); }
  var red = data.redactions && typeof data.redactions.total === 'number' ? data.redactions : { total: 0, byType: {} };
  var types = Object.keys(red.byType || {}).map(function (k) { return k + ' ' + red.byType[k]; }).join(', ');
  fact('Events in this file', String(n));
  fact('Exported at', str(data.exportedAt) || 'unknown');
  fact('Secrets redacted', red.total + ' (best effort: pattern-based, not a guarantee' + (types ? '; ' + types : '') + ')');
  fact('Session id', str(data.sessionId) || 'unknown');
  if (data.droppedBefore > 0) {
    var inc = byId('incomplete');
    inc.textContent = 'Incomplete history: ' + data.droppedBefore + ' earlier events had already been dropped from memory before the export. The file starts after them.';
    inc.hidden = false;
  }

  var log = byId('event-log');
  var items = [];
  for (var i = 0; i < n; i++) {
    var li = el('li', streamTime(events[i].time) + ' · ' + events[i].type + (summary(events[i]) ? ' · ' + summary(events[i]) : ''));
    li.hidden = true;
    items.push(li);
    log.appendChild(li);
  }

  var scrub = byId('scrubber'), prev = byId('prev'), next = byId('next'), play = byId('play');
  var position = byId('position'), announce = byId('announce');
  var pos = -1, timer = null;

  if (n === 0) {
    scrub.disabled = true; prev.disabled = true; next.disabled = true; play.disabled = true;
    position.textContent = 'No event in this export.';
    return;
  }
  scrub.max = String(n - 1);

  function agentsAt(upto) {
    var order = [], state = {};
    for (var k = 0; k <= upto; k++) {
      var ev = events[k], p = payloadOf(ev);
      if (Object.prototype.hasOwnProperty.call(LIFECYCLE, ev.type)) {
        var name = str(p.name);
        if (!name) continue;
        if (!Object.prototype.hasOwnProperty.call(state, name)) order.push(name);
        state[name] = { state: LIFECYCLE[ev.type], at: k };
      } else {
        var a = str(p.agent);
        if (a && !Object.prototype.hasOwnProperty.call(state, a)) { order.push(a); state[a] = { state: 'unknown', at: -1 }; }
      }
    }
    return order.map(function (name) { return { name: name, state: state[name].state, at: state[name].at }; });
  }

  function render(i) {
    var from = pos < 0 ? 0 : Math.min(pos, i), to = pos < 0 ? n - 1 : Math.max(pos, i);
    for (var k = from; k <= to; k++) items[k].hidden = k > i;
    if (pos >= 0 && items[pos]) items[pos].removeAttribute('aria-current');
    items[i].setAttribute('aria-current', 'step');
    pos = i;
    scrub.value = String(i);
    scrub.setAttribute('aria-valuetext', label(i));
    prev.disabled = i === 0;
    next.disabled = i === n - 1;
    position.textContent = label(i);
    var ev = events[i];
    var flags = [];
    if (ev.replayed) flags.push('history replay: this time says nothing about when the agent worked');
    if (ev.imported) flags.push('imported transcript');
    byId('current-meta').textContent = 'Event ' + (i + 1) + ' of ' + n + ' · ' + ev.type + ' · ' + streamTime(ev.time) + (flags.length ? ' · ' + flags.join(' · ') : '');
    byId('current-payload').textContent = JSON.stringify(payloadOf(ev), null, 2);
    var body = byId('agents').tBodies[0];
    while (body.firstChild) body.removeChild(body.firstChild);
    var agents = agentsAt(i);
    agents.forEach(function (a) {
      var tr = el('tr');
      var th = el('th', a.name); th.scope = 'row';
      tr.appendChild(th);
      tr.appendChild(el('td', a.state));
      tr.appendChild(el('td', a.at < 0 ? 'none seen' : 'event ' + (a.at + 1) + ' (' + events[a.at].type + ')'));
      body.appendChild(tr);
    });
    byId('no-agents').hidden = agents.length > 0;
    if (items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
  }

  function stop(say) {
    if (timer !== null) { clearInterval(timer); timer = null; }
    play.setAttribute('aria-pressed', 'false');
    play.textContent = 'Play';
    if (say) announce.textContent = 'Paused at event ' + (pos + 1) + ' of ' + n;
  }
  function go(i, say) {
    render(Math.max(0, Math.min(n - 1, i)));
    if (say) announce.textContent = label(pos);
  }

  scrub.addEventListener('input', function () { stop(false); go(Number(scrub.value), false); });
  prev.addEventListener('click', function () { stop(false); go(pos - 1, true); });
  next.addEventListener('click', function () { stop(false); go(pos + 1, true); });
  play.addEventListener('click', function () {
    if (timer !== null) { stop(true); return; }
    if (pos >= n - 1) go(0, false);
    play.setAttribute('aria-pressed', 'true');
    play.textContent = 'Pause';
    announce.textContent = 'Playing from event ' + (pos + 1) + ' of ' + n;
    timer = setInterval(function () {
      if (pos >= n - 1) { stop(false); announce.textContent = 'End of the session: event ' + n + ' of ' + n; return; }
      go(pos + 1, false);
    }, STEP_MS);
  });

  render(n - 1);
})();
`

// SHA-256 of REPLAY_SCRIPT and REPLAY_STYLE, as the CSP expects them. Editing either one means updating its
// hash: the session-export test prints the expected value.
export const REPLAY_SCRIPT_HASH = 'sha256-lBjzxXQswfPxiaAYcIwvZMwBwfHy3Z9EfMwsV0FnP7Y='
export const REPLAY_STYLE_HASH = 'sha256-1//X4/0WiGXW/vOOMg6Er+SfmiT2TWlxzM3CVwF/880='

const CSP = [
  "default-src 'none'",
  `script-src '${REPLAY_SCRIPT_HASH}'`,
  `style-src '${REPLAY_STYLE_HASH}'`,
  "img-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

export function renderReplayHtml(exp: SessionExport): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session replay: ${escapeHtml(exp.label)}</title>
<style>${REPLAY_STYLE}</style>
</head>
<body>
<header>
<h1>Session replay: <span id="session-label"></span></h1>
<p class="note">Read-only snapshot exported from Agent Lens. Times are stream times, as received by Agent Lens, not wall-clock times. Nothing in this file is live.</p>
<p id="incomplete" class="warn" hidden></p>
<dl id="facts"></dl>
</header>
<main>
<section aria-labelledby="scrub-title">
<h2 id="scrub-title">Replay</h2>
<label for="scrubber">Position in the session</label>
<input type="range" id="scrubber" min="0" max="0" step="1" value="0">
<div class="controls" role="group" aria-label="Replay controls">
<button type="button" id="prev">Previous event</button>
<button type="button" id="play" aria-pressed="false">Play</button>
<button type="button" id="next">Next event</button>
</div>
<p id="position"></p>
<p id="announce" class="sr-only" role="status"></p>
</section>
<section aria-labelledby="current-title">
<h2 id="current-title">Current event</h2>
<p id="current-meta" class="note"></p>
<div class="scroll" role="region" aria-label="Payload of the current event" tabindex="0"><pre id="current-payload"></pre></div>
</section>
<section aria-labelledby="agents-title">
<h2 id="agents-title">Agents at this position</h2>
<p class="note">Derived only from agent_spawn, agent_idle and agent_complete events seen up to this position. An agent named by other events only is shown as unknown.</p>
<table id="agents"><thead><tr><th scope="col">Agent</th><th scope="col">State</th><th scope="col">Last lifecycle event</th></tr></thead><tbody></tbody></table>
<p id="no-agents" class="note" hidden>No agent seen yet.</p>
</section>
<section aria-labelledby="log-title">
<h2 id="log-title">Events up to this position</h2>
<div class="scroll" role="region" aria-label="Event log, scrollable" tabindex="0"><ol id="event-log"></ol></div>
</section>
</main>
<noscript><p>This replay needs JavaScript. The session data is the JSON in the element with id session-data.</p></noscript>
<script type="application/json" id="session-data">${embedJson(exp)}</script>
<script>${REPLAY_SCRIPT}</script>
</body>
</html>
`
}
