# Launching an agent: security model (#229)

Agent Lens can start a headless `claude` on a GitHub issue. This is the only feature of the relay that starts a process, so it is **off by default** and built so that a web page, another tab, another local user or the text of an issue cannot start one. This page is the reference for what is checked, what is shown, and what is *not* protected. The command line itself (tools, permission mode, prompt) is described in [node-inspector.md](node-inspector.md#launch-an-agent-on-an-issue-229).

State of the work: the supervisor, the journal, the HTTP routes and the launch button with its dialog are in (see [Use it from the inspector](#use-it-from-the-inspector)). The button works only on a page **served by the relay itself** (same origin); see the limit below.

## Turn it on

```bash
npx agent-lens-app --allow-launch --launch-repo j0hn-42/agent-lens
# or, with the dev relay: pnpm run dev:relay --allow-launch --launch-repo j0hn-42/agent-lens
```

- Without `--allow-launch` the relay has no launch surface: `POST /launch` and `POST /launch/<id>/stop` answer **404**, `GET /status` has no `launch` field, and no event mentions it. There is no way to turn it on from the UI or from a request.
- `--allow-launch` needs at least one `--launch-repo <owner/name>` (repeatable). A malformed value, `--allow-launch` alone, or `--launch-repo` without `--allow-launch` stops the start with exit code 2. The repository must also be the `origin` of the workspace the relay was started in.
- Optional library settings (not flags yet): `maxConcurrent` (1, or 2 at most), `budgetUsd`, `journalPath`.

## The token

At every start the relay draws 256 random bits and prints them **once on its own console**:

```
Launch is ON for: j0hn-42/agent-lens
Token of this start (paste it in the launch dialog; it is kept in memory only and changes at each start):
  <64 hex digits>
```

Every launch request must send `Authorization: Bearer <token>`. The comparison is constant time (both sides are hashed to a fixed size first, so neither the value nor the length leaks through timing). A missing, wrong or malformed token is a 401 before the body is read; the token in a URL is ignored.

Why the console and not the served app (decision (c) of #229): the app is served to anything that can open `127.0.0.1:<port>`, including another local user's browser, and a page injected with the token would hand it to every script that page runs. The console is a channel only the person who started the relay reads. The cost is one paste per start. The token is never served over HTTP, never written to a file, never in the journal, never passed to the child (its environment is filtered, see below). Whoever reads the relay's console, its process memory or a terminal log that captured it can launch: treat it as a password for the repositories listed.

## Use it from the inspector

1. Start the relay with `--allow-launch --launch-repo <owner/name>` and open the page it serves (the standalone app). `GET /status` then has a `launch` field; without it, no button is rendered anywhere.
2. Select an agent whose role has open issues labelled `agent:<role>` (the issue links of the inspector, #63). Each **open issue** gets a button "Lancer un agent sur l'issue #N" ("Launch an agent on issue #N" when the interface is in English; the labels below are the French ones, from the message catalog `web/lib/messages.ts`). Closed issues and pull requests get none.
3. The button opens a modal dialog. It shows, as plain text, the repository, the issue number, the role, the issue title, the command the relay will build (the session id, the budget, the tool lists and the prompt are filled in by the relay) and the caps (simultaneous launches from `status.launch.maxConcurrent`, 60 min per launch). Focus starts on "Annuler"; Escape closes it and focus returns to the button.
4. Paste the token printed on the relay's console in the "Jeton du relais" field (a password field) and press "Lancer". The token is kept in the dialog's memory only: never in `localStorage`, never in a URL, and it is cleared when the dialog closes, so each opening needs a new paste.
5. The states are announced in words in a status region, each from a fact the relay reported (no "Démarré" without a pid, no "session vue" without `sessionSeenAt`). A refusal is a fixed sentence per HTTP code; the body of the answer is never shown. While a launch of that issue runs, the dialog offers "Fermer" and, in a separate zone, "Arrêter" instead of "Lancer"; stopping takes a second step ("Confirmer l’arrêt" or "Laisser tourner", Escape cancels it) before `POST /launch/<id>/stop` is sent with the same token. A click on the backdrop does not close the dialog while a token is typed. Once it ended, the path of the kept worktree is shown, in the dialog and under the button.

**Limit: same origin only.** `POST /launch` carries an `Authorization` header and a JSON body, so a browser sends a CORS preflight (`OPTIONS`) first when the page comes from another origin, and the relay answers no preflight. So the button is offered only on a page served by the relay itself. The dev web server (`pnpm run dev`, port 3000, talking to the relay on 3001) and the VS Code webview do not offer it (their launch state is not even read). Supporting them needs `OPTIONS` and CORS answers on the relay, a security change left to a separate follow-up.

## What a request goes through

In this order; the first that fails answers and stops:

| Step | Refusal |
| --- | --- |
| Peer address and `Host` must be loopback. A tunnel name (`--allow-host`, #241) is **never** accepted here, and the remote gate refuses these paths before the relay is reached | 403 |
| `Origin` / `Sec-Fetch-Site` of another site (only the app's own origin and the dev web server's port pass) | 403 |
| Method: `POST` only | 405 |
| Dedicated rate limiter: 3 requests, then one every 10 s | 429 |
| Token | 401 |
| `Content-Type` exactly `application/json` (optional `charset=utf-8`) | 415 |
| Body at most 512 bytes, sent within 3 s | 413 / 408 |
| Body is JSON and exactly `{"repo","issue","role"}`, each of a strict shape | 400 |
| An issue already launched, or the simultaneous cap reached (checked before any process is run) | 409 / 429 |
| Repository in the allow-list and equal to the workspace origin | 403 |
| The issue, read again with `gh api` run without a shell: that issue of that repository, not a pull request, open, labelled `agent:<role>`, written by an `OWNER`, `MEMBER` or `COLLABORATOR` | 422, or 502 if gh or git failed |
| Caps checked again, atomically with the start (two requests that crossed start one process) | 409 / 429 |
| The journal accepted the first entry | 503 if not |

The answer to a launch is `202` with the launch **view** (below) and nothing else: not the command line, not the output, not the issue text. Errors are `{"error": "<fixed word>"}`. A `429` for the simultaneous cap carries `Retry-After: 30`.

`POST /launch/<id>/stop` goes through the same guards, ignores any body, and answers `202` (the view), `404` (unknown id) or `409` (already ended). `<id>` is 16 hex digits drawn by the relay.

## Injection

The title and body of the issue are untrusted. They are read to check the issue exists and to keep a cleaned title, then dropped (the dialog shows the title listed by `GET /issue-links`, as plain text): the argument vector is built by a pure function from the validated `repo`, `issue` and `role` only, with no shell (`spawn` with `shell: false`), the prompt is a fixed template, and the worktree/branch is `issue-<n>-<role>`. The tests feed hostile titles and bodies (quotes, `$(...)`, backticks, newlines, `--dangerously-skip-permissions`, bidi controls) and check they appear in neither the argv, the journal nor any answer. A hostile *request* (a role starting with `--`, a URL as repository, extra keys, `__proto__`) is a 400 and starts nothing.

## The life of a launch

Each state is set **only when it was observed**, like everywhere in Agent Lens ([reading-the-ui.md](reading-the-ui.md)):

| State | Set when | Never set because |
| --- | --- | --- |
| `requested` | the relay accepted the request and called spawn | it has no pid yet |
| `started` | the child's own `spawn` event, with its pid | a pid was returned by the call |
| `session` | a transcript of **our** `--session-id` was seen (the id the relay drew, so the link launch to session is proven, not guessed) | the process is merely running |
| `exited` | the `exit` event, with its code or signal | |
| `stopped` | we asked to stop **and then** saw the exit | the stop was only requested (`stopRequestedAt` records the request) |
| `expired` | the 60-minute deadline stopped it **and then** the exit was seen | the deadline came |
| `failed` | spawn threw, an `error` event (code such as `ENOENT`), or an exit before any start | |

A session seen before the spawn event is applied when the start is observed, not before.

The view (SSE `{"type":"launch","launch":{...}}`, the list `{"type":"launch-list"}` when a local client connects, and `GET /status` under `launch`) holds: id, repo, issue, role, worktree name, session id, state, pid, the times, stop reason, exit code or signal, a bounded failure code, the worktree path **only if it exists after the end** (the work is kept there, nothing is deleted), and the number of output bytes kept or dropped. **Tunnel hosts receive none of it** (not in the stream, not in `/status`).

## Caps

| Cap | Value |
| --- | --- |
| Simultaneous launches | 1 by default, 2 at most |
| Launches per issue (whatever the role) | 1 at a time |
| Wall clock | 60 min, then stop |
| Stop | `SIGTERM` to the **process group**, `SIGKILL` 10 s later |
| Budget | `--max-budget-usd`, $5 by default, $20 at most |
| Output kept | the last 256 KB of stdout+stderr in a ring buffer; only its size is exposed |
| Finished launches remembered | the last 20 |

When the relay exits (Ctrl+C, `SIGTERM`, `SIGHUP` when the terminal closes, or an uncaught exception), every running child is killed with `SIGKILL` at once: the process is going away, and a grace timer would not survive it. The worktree stays.

## Environment of the child

Only what `claude` and `gh` need is passed: `PATH`, `HOME`, locale and temp variables, `CLAUDE_CONFIG_DIR`, the Anthropic and Claude Code credentials variables, `GH_TOKEN` / `GITHUB_TOKEN`, proxy variables. Nothing of the relay's own configuration (`AGENT_LENS_*`, webhook URLs), no `NODE_OPTIONS`, no `LD_*`. The working directory is the workspace.

## Journal

`~/.agent-lens/launch-journal.jsonl`: JSON lines, append only, mode `0600` (folder `0700`), opened without following a symbolic link. Past 1 MiB it is renamed `.1` (replacing the previous one) and a new file starts, so at most about 2 MiB remain. A line holds a time, the event (`requested`, `started`, `session`, `stop-requested`, `signal-failed`, `killed-on-dispose`, `ended`, `refused`), repository, issue, role, session id, pid, argv, state, exit code, signal, duration and a fixed reason. Only these fields are ever written, each cut to 300 characters; the token, the issue text and the environment cannot reach it. Refusals are journaled **after** the token check (an unauthenticated flood must not fill the disk), with the validated request when there is one and never the raw body. If the first entry cannot be written, nothing is started.

## Not protected, not proven

- The tools rules are permission rules, **not a sandbox** (see [node-inspector.md](node-inspector.md#launch-an-agent-on-an-issue-229)). A prompt injection in the issue is made harder, not impossible.
- Someone who can run commands as you does not need this route. The token and the checks defend against the browser, other sites and other local users who can reach the port, not against your own account.
- If the relay is killed without running its cleanup (`SIGKILL`, power loss), the children are not: they run on until `--max-budget-usd` or the end of their work. The 60-minute deadline lives in the relay.
- Process groups need a POSIX system. On Windows the supervisor signals the process only, not its children.
- A `gh` that is not authenticated, or an unreachable GitHub, is a 502 ("issue-lookup"): nothing is guessed.
- Output and session content are not exposed by these routes. The agent's transcript is watched like any other session, and shown as such once `session` is observed.
