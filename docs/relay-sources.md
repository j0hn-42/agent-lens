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

### Which source wins on contradiction (`resolveConflict`)

| Kind of fact | Authority | Why |
| --- | --- | --- |
| Content and ordering: messages, tool calls and results, tokens, model, subagent names | **JSONL** | Durable record, real names and ids |
| `permission_requested`, `agent_idle`, `agent_complete` (permission prompts, liveness) | **Hooks** | Only Claude Code knows a prompt is on screen or that the session stopped |

## Hardened local server (#68)

- Listens on `127.0.0.1` only. The default port is unchanged; `AGENT_LENS_PORT=0` (or `--port 0` for
  the standalone app) asks the OS for an ephemeral port, which is printed at startup.
- `GET`, `HEAD`, `OPTIONS` only (`405` + `Allow` otherwise). `HEAD /events` never opens a stream.
- Every response carries `Content-Security-Policy`, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. API/SSE/error responses use
  `default-src 'none'`; the static app uses a strict same-origin policy.
- `?session=` / `?sessionId=` are validated (`400`).
- One in-flight refresh per key (`KeyedCoalescer`): 50 concurrent `GET /status` share one computation.
- One shared scan interval for all SSE clients (`SharedTicker`), stopped when the last client leaves.
- The earlier limits (SSE client cap, replay caps, `/status` rate limit) are unchanged.
