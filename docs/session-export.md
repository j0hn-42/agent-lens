# Session export and HTML replay

Save one session as a single HTML file that anyone can open offline in a browser, and step through it with a scrubber (#237). The file is a read-only snapshot: nothing in it is live, and it never connects to Agent Lens or to the network.

## Export a session

In the **Sessions** panel, each real session with events in memory has an export button (⤓, *Export session <name> as an HTML replay*) next to rename and close. It is a normal button: reach it with Tab, press Enter or Space. The browser saves `agent-lens-session-<name>-<date>-<time>.html` (export time in UTC) and a message says how many events were exported, how many earlier events were already dropped and how many secrets were redacted.

There is no export button:

- in the demo (mock data is not a session);
- for the **All** view or a team: export one session at a time;
- for a session with no event in memory (listed only, or closed and freed).

Inside the VS Code webview the browser download may be refused; the message then says the export failed. Use the web app (`pnpm run dev`) to export.

## What the file contains

- The events of the session still in memory: at most the last 5000 (the session buffer). Earlier events dropped from memory are not in the file, and the file says how many there were ("Incomplete history").
- For each event: its type, its stream time, its payload (after redaction) and the *history replay* or *imported transcript* marks.
- The session label and id, the export time, the event count and the redaction counts, by type.

The data is also readable as JSON: it is the `<script type="application/json" id="session-data">` element (`schema: 1`, `kind: "agent-lens-session"`).

## Secrets are redacted before the file is written

Every string of every payload (object keys included), and the session label, go through pattern-based redaction. Recognised:

| Pattern | Replaced by |
| --- | --- |
| Anthropic keys `sk-ant-…`, OpenAI keys `sk-…`, `sk-proj-…` | `[REDACTED:anthropic-key]`, `[REDACTED:openai-key]` |
| GitHub tokens `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_` | `[REDACTED:github-token]` |
| AWS access key ids `AKIA…`, `ASIA…`; Slack `xox?-…`; Google `AIza…` | `[REDACTED:aws-access-key]`, `[REDACTED:slack-token]`, `[REDACTED:google-api-key]` |
| JSON Web Tokens, `Bearer <token>` | `[REDACTED:jwt]`, `Bearer [REDACTED:bearer-token]` |
| `-----BEGIN … PRIVATE KEY-----` blocks | `[REDACTED:private-key]` |
| `password=`, `secret:`, `api_key`, `access_key`, `*_TOKEN=` assignments (text, env files, JSON) | the name is kept, the value becomes `[REDACTED:secret]` |
| `scheme://user:password@host` | `scheme://[REDACTED:url-credentials]@host` |
| Home directories `/home/<user>`, `/Users/<user>`, `C:\Users\<user>` | `~` |

Control and bidi characters are removed too. The redaction is **best effort**: a secret in a format not listed above stays in the file, and the file says so next to the count. Read the file before you share it.

## Reading the replay

- **Position in the session**: a slider. Arrow keys move one event, Page Up / Page Down move further, Home and End go to the first and last event. Its value is spoken as "Event 3 of 40: tool_call_start".
- **Previous event**, **Play** / **Pause**, **Next event**: buttons. Play steps one event every 0.8 s and is off by default; there is no animation. The position reached with the buttons is announced.
- **Current event**: the type, stream time, marks and the full payload.
- **Agents at this position**: built only from the `agent_spawn` (started), `agent_idle` (idle) and `agent_complete` (complete) events seen up to the position. An agent named by other events only reads **unknown**; nothing else is inferred.
- **Events up to this position**: the log, current event marked.

Times are stream times (seconds as received by Agent Lens), not wall-clock times. An event marked *history replay* came from a history replay: its time says nothing about when the agent worked.

The page follows the light or dark system preference (Catppuccin Macchiato or Latte colours).

## Security of the file

- Its Content Security Policy is `default-src 'none'`: no request of any kind (images, fonts, scripts, fetch). Only the replay's own inline script and style run, pinned by their SHA-256 hash.
- The session data is embedded as JSON with `<`, `>` and `&` escaped, so transcript text cannot close the data block or add markup. The script writes text with `textContent` only: HTML or script in a transcript is displayed, never run.

## Not covered (yet)

Replaying the canvas itself, chapters, exporting the All view or a team, and importing a file back into the app.
