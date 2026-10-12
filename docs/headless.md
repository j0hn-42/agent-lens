# Headless use: CLI, status line and webhooks

Agent Lens can be read without the canvas (#236). All of it is a thin layer over data the local relay already serves over HTTP, so it follows the same rule as the UI: nothing is shown that cannot be proven ([Reading the UI](reading-the-ui.md)). An unreachable relay is an error, never "0 sessions".

The relay must be running (`npx agent-lens-app`, or `pnpm run dev`). The commands find it on the default port; use `--port <n>` or `AGENT_LENS_PORT` if you started it elsewhere.

## Commands

```bash
npx agent-lens-app ps                 # JSON: what the relay observes
npx agent-lens-app tail               # NDJSON: live events
npx agent-lens-app statusline         # one line of text
```

Exit codes: `0` ok, `1` relay unreachable, answering an error, or stream broken (the reason is on stderr, stdout stays empty), `2` bad option.

### `ps`

Prints the answer of `GET /observations?agents=1` as one JSON document: sessions (id, runtime, status, timestamps, freshness) and the lifecycle state of their agents. It is the whitelisted projection described in [State shared with Claude](state-share.md): no prompt, no label, no path. `truncated`, `omittedSessions` and `agentsIncomplete` say when a list is partial: read the counts as "at least".

### `tail`

Prints one JSON object per line (the event: `time`, `type`, `payload`, `sessionId`) for each **live** event of `GET /events`. The events the relay replays when you connect are history, not news: they are skipped unless you pass `--replay`.

| Option | Effect |
| --- | --- |
| `--session <id>` | only this session |
| `--count <n>` | stop after n events (exit 0) |
| `--timeout <ms>` | stop after this time (exit 0) |
| `--replay` | also print the replayed history |

`tail` prints payloads as the relay has them, so it can show prompts and file paths: it is for your terminal, not for sharing. A line larger than 64 KiB is dropped, never cut (a cut JSON line would be a false line); stderr says how many were dropped.

### `statusline`

Prints the answer of `GET /statusline`, for example `lens 2 live 3 active 1 idle`.

- *live*: sessions that are active **and** fresh. A stale, completed or imported session is not counted.
- *active* / *idle*: agents of those sessions, by their tracked state.
- When the observation is partial (truncated list, agents possibly missing) every number is prefixed `>=`.
- No session id and no agent name is in the line.

Use it in a bar:

```bash
# tmux (~/.tmux.conf)
set -g status-right '#(curl -fsS --max-time 1 http://127.0.0.1:3001/statusline || echo "lens off")'
set -g status-interval 5
```

```bash
# zellij: a command pane or a status plugin that runs
curl -fsS --max-time 1 http://127.0.0.1:3001/statusline || echo "lens off"
```

`GET /statusline?format=json` returns `{ live, active, idle, atLeast, text }`. The route answers `503` when the observation is unavailable; the `|| echo "lens off"` above shows that instead of a false zero. Like the other routes it is loopback only, rate-limited, and refuses requests from another site.

## Webhooks

The relay can notify a URL when a **live** agent finishes, asks for a permission or fails.

```bash
AGENT_LENS_WEBHOOKS='https://hooks.example.com/lens' npx agent-lens-app
# or: npx agent-lens-app --webhook https://hooks.example.com/lens   (repeatable)
AGENT_LENS_WEBHOOK_EVENTS=agent_complete,error    # optional, default: agent_complete,permission_requested,error
```

Prefer the variable: a URL given as a flag is visible in the process list, and a webhook URL is often a secret.

### Rules

- **Explicit destinations only.** Nothing is sent unless you configured the URL. At most 4 destinations; `https` only, except `http` towards `127.0.0.1`, `localhost` or `[::1]`. A URL with credentials (`user:pass@`) is refused. A refused URL is reported at startup **without** being echoed.
- **Only what just happened.** Events read from a transcript history when a session is discovered, events of imported sessions, and events of sessions the relay does not watch are never notified. Only Claude sessions watched by the relay are covered (not Codex or Copilot).
- **A fixed body.** Built field by field, never copied from the event:

  ```json
  { "schema": 1, "source": "agent-lens", "type": "agent_complete", "sessionId": "…", "agent": "Scan code", "sentAt": 1760000000000 }
  ```

  `sessionId` and `agent` are left out when they are not a plain identifier or name (an agent name that looks like a path is omitted, not replaced). No message, prompt, tool argument, error text or path ever leaves.
- **Bounded.** Body at most 1 KiB; 3 s for the whole exchange; redirects are not followed; at most 8 sends in flight and 30 per minute. Past a bound the notification is dropped and counted (`droppedBusy`, `droppedRate`); a non-2xx answer or a network error counts as `failed`, never as `sent`. There is no retry: a missed notification is not replayed later.
- `sentAt` is the time the relay sent the notification, not the time of the event.

The counters are not served over HTTP: they are available to code that embeds the relay, as `relay.webhookStats()`.
