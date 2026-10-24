# Event sources and the local server

Principle (epic #73): never display a state or a number that cannot be proven.

## Reconciling hooks and JSONL (#53)

Claude Code activity reaches the relay twice: live through the **hooks** (HTTP) and from disk
through the **JSONL transcript**. The two streams overlap. `extension/src/event-source-priority.ts`
reconciles them:

1. The live flow is subscribed **before** a session history is loaded.
2. While the history is read (`EventReconciler.withHistory`) every event is **held**, then replayed in
   order when the load ends.
3. Events are **deduplicated by id** (`deriveEventId`): an explicit `eventId`/`id`, else
   `session + type + tool_use_id`, else (lifecycle events) `session + type + agent + time bucket`,
   else `session + type + content hash` (so two different messages are never merged).
   Only copies from **different sources** collapse; two events from the same source are real activity.
4. Delivered ids are remembered (bounded). A copy arriving later from the other source is dropped; a
   delivered event cannot be retracted, so for late arrivals the first delivery stands.

Both runtimes use the same `EventReconciler`:

- **Relay** (dev relay and standalone app, `scripts/relay.ts`): every event goes through `broadcastEvent`.
- **VS Code extension**: `SessionWatcher` owns the reconciler. Transcript events enter as `jsonl`, the
  runtime submits hook events with `watcher.submitHookEvent` (source `hook`), and the survivors come back
  on `watcher.onEvent` (transcript) or `watcher.onHookEvent` (hook), so the runtime keeps its own routing.
  The session prescan runs inside `withHistory`.

Caveat: reading a transcript history is synchronous, so a hook cannot interleave with it in practice. The
hold is a guarantee, but the deduplication that does the work is the "already delivered" memory: when both
copies arrive live, the first delivery stands, so `resolveConflict` decides only inside a held batch.
Lifecycle copies (no tool_use_id) are matched by a 2 s time bucket; two copies on either side of a bucket
boundary are not merged.

### Which source wins on contradiction (`resolveConflict`)

| Kind of fact | Authority | Why |
| --- | --- | --- |
| Content and ordering: messages, tool calls and results, tokens, model, subagent names | **JSONL** | Durable record, real names and ids |
| `permission_requested`, `agent_idle`, `agent_complete` (permission prompts, liveness) | **Hooks** | Only Claude Code knows a prompt is on screen or that the session stopped |

## Imported transcripts (#294)

A session that runs on a cloud agent writes nothing on this machine, so the relay cannot watch it. When you
fetch its JSONL transcript (downloaded, synced or copied into a folder), the relay can **import** it:

```bash
node app/dist/app.js --import ~/Downloads/cloud-sessions          # a folder: every *.jsonl directly inside
node app/dist/app.js --import ./<session-id>.jsonl --import ./other # one file; the flag repeats
AGENT_LENS_IMPORT="/path/a.jsonl:/path/folder" pnpm run dev      # same list from the environment (';' on Windows)
pnpm run dev:relay -- --import /path/folder                     # dev relay only
```

- Only a local flag or environment variable designates the files. There is no HTTP endpoint to import: the
  server stays loopback-only and read-only (`GET`/`HEAD`/`OPTIONS`).
- A file is named `<session id>.jsonl`; a folder contributes the regular `*.jsonl` files directly inside it
  (no recursion, symbolic links skipped). Subagent transcripts next to it (`<session id>/subagents/`) are read
  as for a local session. At most 20 imported sessions, each under the transcript size cap; what is refused
  is logged as `Import: ...` at startup, never silently dropped.
- The file is read **once**, at startup, through the same `TranscriptParser` and `EventReconciler` as a live
  session. Unlike a live attach (current turn only), every line is replayed, so the recorded tool calls and
  results are visible; the relay's replay caps keep the newest events. Lines of a type the parser does not know
  are ignored: the JSONL format is internal to Claude Code and may change between versions, so an import is
  only as complete as the parser's understanding of that version.
- Nothing watches the file afterwards (no file watcher, no poll). Re-run the relay to
  read a newer copy.
- Provenance: the session is listed with `imported: true` and `importedAt` (when it was read). Its start and
  last activity are the first and last `timestamp` recorded in the file (`lastActivityUnknown` if none). It is
  never listed as `active`, and no end (`agent_complete`) is invented for it. Every event it produces carries
  `imported: true`; hook events with the same session id are ignored, so live and imported states never mix.
- Its `cwd` is a path on the cloud machine (for example `/home/user/...`). It is shown as a tag but never used
  to read local files (project context, issue links) and never matched to a local project: the web app groups
  imported sessions under **Imported transcripts**.
- The `observations` action reports `provenance: "imported"`, a freshness of `stale` (never `fresh` nor
  `closed`) and no agent list for such a session.

Limits: the VS Code extension does not import (relay and standalone app only); where a cloud provider stores
its transcripts, and in which format, is up to that provider (only Claude Code JSONL is parsed). Live
streaming from a remote agent and provider connectors are tracks 2 and 3 of #294.

## Hardened local server (#68)

- Listens on `127.0.0.1` only. The default port is unchanged; `AGENT_LENS_PORT=0` (or `--port 0` for
  the standalone app) asks the OS for an ephemeral port, which is printed at startup.
- `GET`, `HEAD`, `OPTIONS` only (`405` + `Allow` otherwise), plus `POST` on `/scope` and nowhere else (see below). `HEAD /events` never opens a stream.
- Every response carries `Content-Security-Policy`, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. API/SSE/error responses use
  `default-src 'none'`; the static app uses a strict same-origin policy.
- Dev relay CORS (#201): only the dev web server origin (`http://localhost:3000` or `127.0.0.1:3000`) gets
  `Access-Control-Allow-Origin`. If Next.js falls back to another port, set `AGENT_LENS_WEB_PORT` (comma
  list, at most 5 ports). Other local ports are refused, and so are their cross-origin requests.
- The standalone app refuses (`403`) a non-loopback `Host` on every path, the static files included (#241); the API routes already did.
- `?session=` / `?sessionId=` are validated (`400`).
- One in-flight refresh per key (`KeyedCoalescer`): 50 concurrent `GET /status` share one computation.
- One shared scan interval for all SSE clients (`SharedTicker`), stopped when the last client leaves.
  With no client connected, a new transcript is discovered by the project-dir watcher (only if the dir
  existed at startup) or by the scan that runs when the next client connects. That scan runs before the
  client joins the broadcast, so the client receives the session once (session list + replay).
- The earlier limits (SSE client cap, replay caps, `/status` rate limit) are unchanged.

## Remote access: guards and pairing (#241)

Watching agents from a phone or another machine goes through a named tunnel (Tailscale serve) that forwards to `127.0.0.1`; the user guide is [Remote access](remote-access.md). The standalone app takes the tunnel's name with `--allow-host <name>`, which needs `--token-file <path>` (#517): the pairing token of this start is written there, and the start prints the pairing URLs (the token only in the `#pair=` fragment, and only on a terminal). The start refuses (exit code 2, the reason on stderr):

- `--allow-host` without `--token-file`, `--token-file` without `--allow-host` or without a path, and a token file that cannot be written.
- `--host <address>` for anything but `127.0.0.1` / `localhost`, `::1` included (the server binds IPv4 loopback only). Agent Lens never listens outside loopback, with no built-in TLS.
- Another `--host` address needs an explicit `--remote` (#474), and is refused even then until TLS ships. `--remote` is a flag only: no environment variable turns it on, and it never implies an address (`--remote` alone, or with a loopback `--host`, also refuses to start; there is never an implicit `0.0.0.0`). The dev relay (`scripts/dev-relay.ts`) refuses `--host`, `--remote` and `--allow-host` outright.

What the guards enforce (tested through the app's request handler and the real command):

| Request | Answer |
| --- | --- |
| no `--allow-host`: `Host` loopback (`127.0.0.1`, `localhost`, `[::1]`, any port) | unchanged, no token |
| `Host` exactly a `--allow-host` name (case-insensitive; with the port only if one was given) | read-only surface: `GET`/`HEAD` on `/events`, `/status` and the static app |
| same, on `/context`, `/issue-links`, `/observations`, `/statusline`, `POST /scope` or any other method | `403` |
| same, with an `Origin` other than `https://<name>` (the dev origins included) or a `Sec-Fetch-Site` other than `same-origin` / `none` | `403` |
| `Host` allowed, `/events` or `/status` without a live pairing cookie (#475) | `401`; the static app is served without it |
| `Host` allowed, `POST /pair` with the token (`createRemotePairing` in `scripts/remote-pairing.ts`) | `204` and the `__Host-` cookie; a wrong token `401`, then `429` when the bucket is empty |
| `--allow-host` on, `Host` loopback, any route but the static app and `POST /pair`, without a live pairing cookie (#517) | `401`; with the cookie, the whole loopback surface |
| `--allow-host` on, `Host` loopback, `POST /pair` from `http://<that Host>` (or no `Origin`) | as above; any other `Origin` `403` |
| two `Host` headers | `403` |
| any other `Host` (suffix or prefix look-alikes, trailing dot, other port), static files included | `403` (DNS rebinding) |
| more than 4 SSE streams through allowed names (`RELAY_MAX_REMOTE_SSE_CLIENTS`) | `503` + `Retry-After`; local tabs are not counted against it |

`--allow-host` takes host names only: no wildcard, IP address, loopback name, trailing dot, URL, credentials or default port (`:80`, `:443`, which browsers leave out of `Host`); at most 4 names. The peer must still be loopback: a tunnel's is. So every client of a tunnel shares one rate-limit bucket per name (its `User-Agent` is ignored). The total SSE cap, the rate limits and the strict headers are unchanged.

`--allow-host` only covers named tunnels (Tailscale serve, a reverse proxy with its own name), which must forward the `Host` header unchanged. An SSH `-L` tunnel is not one of them: the remote browser opens `http://localhost:<port>`, so it sends `Host: localhost:<port>`, which is a loopback `Host`. Without `--allow-host`, it gets the full loopback surface (`/context`, `/issue-links`, `/observations`, `/statusline`, `POST /scope`) with no token, and the `Origin` check of a tunnel does not apply. The same holds for a tunnel that rewrites `Host` to `127.0.0.1`. With `--allow-host`, the token is required even on a loopback `Host` (`requiresRemotePairing`, #517): such a tunnel, and a local tab, must pair first.

## Cursor hook payloads are ignored (#472)

Cursor is not a supported runtime yet: no Cursor session, agent or tool call is shown. But Cursor runs, by default, the hooks of `~/.claude/settings.json` (setting "Include Third-Party Plugins, Skills, and Other Configs", see https://cursor.com/docs/reference/third-party-hooks), so Agent Lens's `hook.js` may forward Cursor payloads to the hook server. The input those third-party hooks get is not documented.

The hook server (`isCursorHookPayload` in `extension/src/hook-guards.ts`) recognises a Cursor payload only on markers documented at https://cursor.com/docs/hooks (read on 2026-10-19):

- a non-empty `cursor_version` string, listed in the common schema "all hooks receive" (including `workspaceOpen`, which has no conversation). Claude Code sends no such field;
- or a `hook_event_name` that is exactly one of Cursor's documented camelCase event names (`preToolUse`, `postToolUse`, `subagentStart`, `sessionStart`, `stop`, `workspaceOpen`, ...). Claude Code's names are PascalCase.

Such a payload is answered `200` with no body, like an accepted hook, before validation, the per-session rate limit and the malformed counters: neither of these applies to it. The checks made before the body is read still do: loopback address and `Host`, the per-IP rate limit (a Cursor flood gets `429` like any other), the content type and the size cap. It creates no session, no agent, no tool call and no counter in any session's `normalization_stats`. It is only counted, since the server started, in `getForeignHookStats().cursor`, an internal counter read by the tests: no status route and no panel exposes it. It is logged once per hook server (no field of the payload is logged, as it may hold a `user_email`). Nothing of it is displayed. The count is what reached the server, not what Cursor ran: `hook.js` exits without forwarding a payload that has no `cwd`, which is the case of most Cursor events. A Cursor payload with neither marker is not recognised and goes through the Claude Code path as before (a payload without `session_id` is rejected as malformed). The `CURSOR_VERSION` environment variable is not used: Claude Code started from Cursor's terminal could inherit it and would be hidden.

The tests (`extension/test/cursor-hook-guard.test.ts`) use payloads copied from Cursor's documentation: they are examples, not real captures. What Cursor really sends, from the IDE and from `cursor-agent`, is still to be recorded on a real machine (step 0 of #472), along with whether `hook.js` printing nothing on `preToolUse` can block a tool in Cursor.

## OpenCode (#346)

OpenCode has no hook and no transcript file: it keeps every session in one SQLite database (`<data>/opencode.db` for the latest, beta and prod channels (`opencode-<channel>.db` for any other channel), `<data>` being `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`; `OPENCODE_DB` overrides it: an absolute path is used as is, a relative one is resolved under `<data>`). The relay opens it read-only, polls it, and turns new rows into events; it never writes to it. Only sessions with rows in the last 10 minutes are followed (25 root sessions at most); a session silent for 10 minutes is released without any `session-ended` (a silence is not an end) and followed again if new rows arrive, while an archived one is announced as ended. Select it alone with `AGENT_LENS_RUNTIME=opencode`; by default it is watched with the other runtimes. As with Pi and Gemini CLI there is no hook to reconcile: the database is the only source. Windows is not supported yet (set `OPENCODE_DB` to an absolute path). What the UI shows is in [Reading the UI](reading-the-ui/runtimes.md#opencode-sessions).

**Cost of a poll (#420).** A poll runs only after OpenCode commits to the database (SQLite's `data_version`, checked at least once a minute anyway): with nothing written, a tick costs one `PRAGMA`. OpenCode v1.19.0 has no index on `time_updated`, so messages and parts are not followed by time but by their primary key, which OpenCode makes ascending (creation time first): a poll reads the new rows through the key index, plus a window of recent rows (at most 2,000 rows per table, `OPENCODE_WINDOW_ROWS` in `extension/src/opencode-db.ts`) to see the parts and messages updated in place, plus 1,000 older rows per table (the sweep, below). For the window it asks only `id`, `session_id`, `time_updated` and the size of `data` in bytes (`octet_length`, which SQLite takes from the row header without loading the content); the sweep asks only the first three. These reads still go through the leaf pages of the table, which hold the start of each row: in the test bench (a full window of 2,000 parts of 16 KB each, 32 MB of content), a poll reads 8.4 MB from the file, against 33 MB when the size was asked with `length()`, which reads the whole text. The content of a row already read is loaded again only when its `time_updated` changed. On a synthetic database of 447 MB (100,000 parts, history older than the window, so an almost empty window), a poll that reads 4 new parts took 56 ms with a cursor on `time_updated` and 5 ms with the key (median of 5, warm cache); the cost no longer grows with the size of the tables, but it grows with the size of the recent rows in the window. Sessions are still read by `time_updated` (one row per session, a small table). OpenCode's ids keep only the low 48 bits of the time, so they wrap about every 795 days (the last time on 14 August 2026, the next one on 17 October 2028): rows written before a wrap have ids above every newer one. When the table holds such older ids, the reads stop at the id of a row written now, and the older rows are only swept.

**What the window misses, and how it is counted.** A row leaves the window at the earliest once it has not changed for 10 minutes (`OPENCODE_WINDOW_MS`) and the older rows have left, or when 2,000 newer rows push it out; a row delivered less than 500 ms ago never leaves it. A row delivered while still open (a tool part `pending` or `running`, an assistant message without `time.completed`) is still read by id at each poll after it leaves the window, at most 500 per table (`OPENCODE_OPEN_ROWS`, the oldest dropped first), and its change is delivered: a tool call silent for more than 10 minutes still ends when it finishes. Any other row updated after it left is not read: the canvas keeps its previous state. The same holds for a row inserted with an id below the window (a second OpenCode process with a clock behind), and, when the relay starts, for the rows of the last 10 minutes below the 2,000 newest. These losses are not silent: a sweep reads 1,000 rows below the window at each poll (only `id`, `session_id`, `time_updated`) and counts a row whose `time_updated` is above what the reader last saw there, once per change, as `missedUpdates` in the `normalization_stats` of the followed session it belongs to (the truncation notice says "at least N updates not read"). The count is a lower bound: the sweep takes several polls to go around a large table, and a change older than a later eviction is not seen. Losses of rows outside the followed sessions (except those of a session proved to be in another folder) are counted in the connection status of the VS Code extension and in the `runtimeLosses` field of `GET /status` (see below), which the web page states next to the session scope.

## Claude Code status line: subscription quota (#467)

Claude Code passes `rate_limits` (the 5-hour and weekly quota) to its `statusLine` command on stdin. Agent Lens reads it from there, so the quota gauges ([Reading the UI](reading-the-ui/cost-and-usage.md#subscription-quota-gauges)) show what Claude Code reports and nothing computed. This is not the `statusline` command or `GET /statusline` of [Headless use](headless.md), which print a one-line summary of Agent Lens.

**Opt-in.** Nothing changes until you run `node scripts/setup.js --statusline`. It prints the current and the new `statusLine`, asks `Apply? [y/N]` (`--yes` skips the question; with no terminal and no `--yes` it changes nothing), installs the wrapper at `~/.claude/agent-lens/statusline.js` and points `statusLine` at it. A `statusLine` that is not a command is left unchanged. If you had no `statusLine`, your bar stays empty (the wrapper prints nothing) but the wrapper still runs and still forwards the quota. On Windows, Git Bash is recommended (the wrapper uses `CLAUDE_CODE_GIT_BASH_PATH`, then the standard Git install paths, then PowerShell, like Claude Code).

**What the wrapper does.** It runs your own status line with the same stdin and passes its stdout, stderr and exit code through, so Claude Code displays exactly what it displayed before. Your original `statusLine` is kept whole, encoded (base64url) in the wrapper command inside `settings.json`; there is no other state file. In parallel it posts to the local relay, with a hard limit of 300 ms for the whole send, and any error is swallowed: your status line always wins. It finds the relay like the hook does, through the discovery files (dead instances are cleaned up), and posts to every live instance: the quota belongs to the account, not to a workspace. A window is sent only if its values are in range (`used_percentage` from 0 to 100, `resets_at` an integer); an invalid one is left out and the other still goes.

**What is sent.** Only `five_hour` and `seven_day`, each with `used_percentage` and `resets_at`, as `{"rate_limits":{...}}` to `POST /quota` on the discovery port, which is the hook server's: the relay installs the route there (an instance without it, such as the VS Code extension, answers 404 and nothing is counted). Only a 2xx counts as delivered. Never sent: the session id, the working directory, the model, the cost, the transcript path or anything else from the status line input.

**What the relay does with it.** `POST /quota` takes JSON only, at most 1024 bytes, from a loopback peer; another site, a wrong `Content-Type`, an unknown shape or a value out of range is refused (a window that is present but invalid refuses the whole body). The route is rate-limited per peer (burst of 5, then 1 per second) and the body must arrive within 3 s. Each accepted body replaces the previous quota in memory (nothing is written to disk) and is sent to the browser as the SSE message `quota`, replayed to a client that connects later. It is never sent to a tunnel Host ([Remote access](#remote-access-guards-and-pairing-241)).

**Undo.** `node scripts/setup.js --restore-statusline` puts your original `statusLine` back (or removes the key if there was none); uninstalling the extension does the same before removing the wrapper. Run it before deleting `~/.claude/agent-lens` by hand: without the folder the bar would be left pointing at a missing script, although the restore still works afterwards because it only needs `settings.json`.

## Scope of the discovery (#291)

The relay discovers Claude Code sessions in one of two scopes:

| Scope | What is scanned |
| --- | --- |
| `workspace` (default) | the project folder of the workspace the relay was started in, and its sub-projects (`<encoded>-...`) |
| `all` | every real (non-symlink) project folder directly under `~/.claude/projects` |

`--all-workspaces` / `AGENT_LENS_ALL_WORKSPACES=1` only set the **initial** scope. It is changed at run time, without a restart, by the scope selector of the UI, which calls `POST /scope`. "One project" is not a relay scope: it keeps the relay scope and sets the project filter of the UI.

What a change does, in the relay (`setScope`, one entry point):

- widening runs a scan at once: the sessions of the other workspaces are watched and announced (`session-started`);
- narrowing stops following the sessions of other folders, announces them (`session-ended`), drops their buffered events (a later connection does not replay them) and closes the wake-up watchers of the folders no longer scanned: workspace -> all -> workspace leaves no watcher behind (tested);
- the "cold" state of the previous scan and the counters below are forgotten and recounted, the Agent Teams watcher follows the new scope, and every SSE client receives `{"type":"relay-scope","allWorkspaces":bool}` so each open tab reloads its view;
- setting the scope already in force changes nothing and announces nothing.

### `POST /scope`

The only route that changes the relay's state, so the most guarded. Same chain as the other routes (`scripts/routes/guard.ts`), in this order:

1. loopback peer and loopback `Host` (`403`, DNS rebinding);
2. another site refused (`403`): `Origin` that is not the relay's own or a dev web origin, or `Sec-Fetch-Site: cross-site`; the request is also CORS-preflighted, since `Content-Type: application/json` is not a simple type;
3. method `POST` (`405`, `Allow: POST`); the server-level guard lets `POST` through on `/scope` only;
4. rate limit per client (`429`): burst 5, one every 2 s;
5. `Content-Type: application/json` exactly, optionally `; charset=utf-8` (`415`; `text/plain` and forms are refused);
6. body of at most 256 bytes and read within 3 s (`413`, `408`);
7. strict JSON: an object with the single key `scope` whose value is `"workspace"` or `"all"` (`400` for anything else). The client never sends a path or an identifier.

The answer is `{"scope":"all","allWorkspaces":true}`, built after the rescan. Strict headers (CSP `default-src 'none'`, `no-store`, `nosniff`) as on every API response.

### What `GET /status` says about the scope

`allWorkspaces` is the scope the scan uses **right now** (read when the answer is built, never a value cached with a shared computation), so the UI shows what is scanned, not what was asked. The discovery ceilings, which stay in force in both scopes, are reported and cleared when the scope that hit them is left:

| Field | Ceiling | Reported as |
| --- | --- | --- |
| `discovery.projectDirsCapped` | 200 project folders (`maxProjectDirs`), the ones with the most recent transcript | `true` when more exist |
| `skippedSessions.fileLimit` | 500 transcripts per folder (`maxFilesPerDir`), the newest kept | sessions left out |
| `skippedSessions.sizeLimit` | 256 MB per transcript, at discovery or after growth | sessions left out |
| `skippedSessions.watchLimit` | 25 watched sessions | sessions left out |

The counts are distinct sessions of the current scope, bounded: the UI reads them as "at least N". Codex, Copilot, Pi, Gemini CLI and OpenCode sessions are matched to the workspace by their own watchers and ignore the scope.

`runtimeProblems` (#420), present only when there is one, lists the watched runtimes that cannot read their source right now, as `{ runtime, message }`: today the OpenCode database not found, not readable, or of an unexpected schema (`"OpenCode: database not found."`). The message never carries a file path and is capped at 300 characters.

`runtimeLosses` (#420), present only when one count is above 0, lists the losses of a watched runtime that no followed session counts in its `normalization_stats`, as `{ runtime, unreadableRows, missedUpdates }`: today the OpenCode rows that could not be read and the row changes the reader will not deliver, in sessions not followed at the time. A row of a session whose root is proved to be in another folder than the workspace is not counted: OpenCode keeps one database for every project, and the relay never shows such a session, whatever the scope. A row whose session cannot be resolved (unknown id) may be one of the workspace and is counted. Both counts are lower bounds, read when `/status` answers, capped at 1,000,000,000, and start again from 0 when the database file is replaced; while the database cannot be read only `runtimeProblems` is given, and the counts come back once it reads again (the same rule as the connection status of the extension). The web page writes them next to the session scope ("OpenCode: at least N updates not read outside the followed sessions."), outside the live region (a count that grows is not announced again), and reads `/status` again on the same schedule as a runtime problem while they are shown; the schedule starts again from 5 seconds when the runtime problems change, not when a count grows.

## Replay buffer: context readings replaced at the same instant (#567)

The relay keeps, per session, the last events it received (5000 per session, 50 sessions, 50,000 in all) and replays at most 2000 of them per session to a page that connects (`RELAY_MAX_*` in `extension/src/constants.ts`). What these caps leave out is counted and sent as the `event-loss` message ("Graph incomplete: at least N earlier events were not replayed").

**Events missed while the link was down (#366).** Every event the relay delivers gets a number, increasing for the life of the relay process (`seq`, carried by each live `agent-event`); each `/events` connection receives, once its replay is written (after `event-loss` and the replay, before the live events held meanwhile), a `relay-cursor` message with the id of the relay process and the number of the last event delivered when it connected. A page cut during its replay gets no cursor and keeps the one it had. The page keeps that cursor, advances it with the number of each live event it receives, and sends it back when it reconnects (`/events?since=<instance>.<seq>`). The relay remembers the numbers of the events its buffer let go of (4096 to 8192 per session: past 8192 the list is cut back to the newest 4096; and only the sessions of the buffer) and answers in `event-loss.gap`, per session, how many events numbered after `since` its buffer evicted or this replay's cap leaves out: events the page never received. The page adds them to what the graph already lacks. It is a lower bound: a forgotten number, an event of no session and an event lost before the page held a cursor (a first connection cut during its replay, for instance) are not counted. A `since` from another relay process (the relay restarted while the link was down, its numbering starts again), ahead of the relay's last number, repeated or malformed counts nothing (the relay logs that it ignored one, without its value); what a restarted relay never saw cannot be counted either.

**VS Code extension without the relay (#592).** The extension has no buffer, no cursor and no `gap`: it posts each event straight to the open panel and drops it while no panel is ready (closed, or still loading). A page that becomes ready (first open, a panel reopened, VS Code restarted with the panel restored) starts from a `reset` and is re-sent, from memory, only the agents of the active Claude Code sessions (spawns, dispatches, models, teams); the other runtimes (Codex, Copilot, Gemini CLI, OpenCode, Pi) only announce their sessions again. The transcripts and the JSONL event log are not read again. So every other event emitted before that page was ready is missing from its graph, including those an earlier page received live. The extension counts, per session, the events it emitted for the panel since it started (`extension/src/panel-loss.ts`: the session watchers' events except OpenCode's, the hook events that reach the panel, the JSONL event log), takes away what the panel's own replay re-sends (one re-sent event stands for at most one earlier event), and sends the rest as `event-loss` after the `reset` (`extension/src/panel-start.ts`), then again while that page is open each time a history read again lowers it (see below). Each emission counts as one event, except a history read again. Claude Code stops watching a session silent for 10 minutes and, when its transcript grows again, attaches it anew and re-emits what it reads of the transcript on attach, the current turn only, not the whole history (marked `replayed`), and the `team_info` of a team it leads, already sent, is re-sent marked `replayed` too; Codex, Copilot, Gemini CLI and Pi do the same only for a retired session they forgot (past 4 times their watched-session cap). The JSONL event log is read from its first line each time it is connected (the same file chosen again, or `agentVisualizer.eventLogPath` changed from A to B and back to A): its sessions are released when it is disconnected, and the first read of the next connection counts as a history read again. A log truncated while connected (its size goes down) is read again from its first byte: its sessions are released at that moment, and the lines read up to the size it had before count as a history read again (`extension/src/jsonl-panel.ts`; past 10,000 sessions in one connection, the events of the others are not counted). These copies may repeat events already counted, so from then on a session still counted counts the larger of what it counted before and of the history read again, plus the events after it. A page open at that moment receives that history too: each copy lowers its figure for that session by one (never below zero) and the figure is sent again; a closed panel's figure is let go. OpenCode is not counted at all: its re-reads (a replaced database read again over the last 10 minutes, a retired session evicted then found again) are emitted without `replayed` and cannot be told from new events, so the figure leaves its sessions out rather than count them twice. The page shows it on the same surfaces as the relay's figure ("Graph incomplete: at least N earlier events were not replayed"), with one difference for a dismissed notice: with the relay's SSE stream, the notice also comes back when the total is lower (relay restarted, graph reloaded); with the VS Code extension, it comes back only when the total goes above the one it was dismissed at, because a lower value there is part of the loss already dismissed. Honest limit: a new loss smaller than the gap between the dismissed total and the lowest total seen is not signalled by the notice (the ⚠ stays; see [reading-the-ui.md](reading-the-ui/relay-and-losses.md#graph-truncated)). It is a lower bound: an event without session or whose session id is longer than 256 characters (a key the page ignores, whatever the source), an OpenCode event, and a hook event dropped before it reaches the session watcher (while no panel is ready; it may duplicate a transcript event) are not counted. Past 200 sessions, the least recently touched ones are dropped from the figure: their events are no longer counted at all, and the extension never sends `otherEvents` (a running total cannot tell which session its events belong to, so a session that came back would be counted twice). A dropped session that comes back starts from zero: its history read again counts as new events, at most once each, and the figure then holds less than what was emitted. May overstate (#613, known and not fixed): a Codex, Copilot or Pi transcript that shrinks while it is followed is read again from its first byte without `replayed`; the parsers drop the copies they recognise (Copilot and Pi by entry id, the last 5,000 ids only; Codex by message content and call id), and every other line read again (a Codex `session_meta`, an entry past those 5,000 ids) is counted a second time, so for that session the figure can exceed the events proven (`extension/test/watchers-replayed.test.ts`). Releasing a session that is not counted changes nothing. What is not counted: a page reloaded inside the same panel ("Developer: Reload Webviews") sends `ready` again, which the extension ignores, so that page gets neither a replay nor a figure; and a message the webview did not take while the page was ready is not detected (the extension does not read the result of `postMessage`).

A `context_update` is an absolute reading: the page sets the agent's context from it, it never adds readings up. A Claude Code tool call emits up to three of them in a row (after the call, after its result, and once more for the same result). In the replay buffer, an earlier reading of an agent is **replaced** by a later reading of the same agent (removed; the later one stays at its own place, so the other events keep their order) only when nothing the page shows can tell the difference:

- **same stream time**: a review scrub reaches both readings or neither, so the context gauge reads the same at every instant;
- **only tool calls, tool results, messages and other context readings in between**: none of them changes which agent a reading lands on. A spawn, a dispatch, a team, a completion, an idle, a model, a compaction, a return or an activity event in between keeps both;
- **the later reading sets everything the earlier one set**: a figure at least as large (a context window that the earlier reading grew stays grown), a breakdown, a window when the earlier one carried one, and the same provenance (history or imported marks).

Readings of different instants are all kept. Lifecycle events (`agent_spawn`, `subagent_dispatch`, `team_info`) are never replaced, and the lifecycle reserve of the replay (400) is unchanged, as are every cap. `agent_activity` keeps its own rule (only the latest per agent).

**A replaced reading is not a loss**, and it is not counted in `event-loss`: the state it leads to is the same (agents, states, current context of each agent). No new figure is reported for these replacements. The only place where they show is a [session export](session-export.md) of a replayed session: a replaced reading has no row there.

Measured on the real relay (`scripts/relay-replay-context-coalesce.test.ts`), one session, tool calls written 20 at a time: for 6003 events the loss reported goes from 4002 to about 1100, for 12003 events from 10002 to about 4300; at 2505 events nothing is lost any more (504 before). Lines written one by one, 40 ms apart: 294 of the 903 events replaced (2 of the 3 readings of a tool call). These figures depend on timing, and were not re-measured for other spacings: whether the readings of a tool call and those of its result fall at the same instant depends on the timestamps of the transcript lines, so the share replaced in a real session may be lower or higher. A reading at a different instant is always kept. The work per event is bounded (the earlier reading is looked for among the last 64 events at most, so a reading further back is kept; and when a reading arrives while 256 agents are tracked in its buffer, the earlier readings stop being candidates (they are kept) and the tracking starts again). Each guard has a unit test (`extension/test/relay-context-guards.test.ts`), as do the provenance rule and the isolation between sessions. The replacement runs in the relay (`scripts/relay.ts` calls `appendBounded`); the VS Code extension's own server does not use this buffer and is not concerned. The memory held by the candidates is bounded (at most 256 readings per buffer, 50 buffers), even when a candidate has already left its buffer.
