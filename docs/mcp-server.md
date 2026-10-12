# MCP server "agent-lens" (#235)

Principle (epic #73): never display a state or a number that cannot be proven. The MCP server applies it to Claude: it gives Claude what Agent Lens observes, and says so when it does not know.

The server is `scripts/mcp/server.ts` (entry point `scripts/mcp/main.ts`). It speaks MCP over **stdio** (JSON-RPC 2.0, one message per line) and has no dependency. It reads no file and opens no port: it is a client of the routes the relay already serves on loopback, with their guards and rate limits ([relay-sources.md](relay-sources.md), [state-share.md](state-share.md)). It is **read only**: no tool writes, starts a session or changes the relay scope.

## Register it in `.mcp.json`

Agent Lens (the standalone app `npx agent-lens-app`, or `pnpm run dev:relay`) must be running: the server reads the relay, which listens on `http://127.0.0.1:3001` by default.

In the `.mcp.json` of the project where you run Claude Code (or with `claude mcp add`), point to your Agent Lens checkout (dependencies installed with `pnpm install`):

```json
{
  "mcpServers": {
    "agent-lens": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/agent-lens", "run", "mcp"]
    }
  }
}
```

Same thing from the command line: `claude mcp add agent-lens -- pnpm --silent --dir /path/to/agent-lens run mcp`.

`--silent` matters: stdout carries only JSON-RPC, and pnpm would otherwise print the script line on it.

If the relay listens on another port (`--port`, `AGENT_LENS_PORT`), add `"env": { "AGENT_LENS_RELAY_URL": "http://127.0.0.1:<port>" }`. The URL must be plain `http://` to `127.0.0.1`, `::1` or `localhost`, with no path, credentials or query; anything else stops the server at start (exit code 1, the reason on stderr), so a configuration cannot send the observations elsewhere.

The repository's own `.mcp.json` does not declare the server: it would fail for every contributor who does not run a relay.

## Tools

| Tool | Relay route | Returns |
| --- | --- | --- |
| `observations` | `GET /observations` | Watched sessions (runtime, status, start and last activity, age, `freshness`, `provenance`) and the lifecycle state of their agents. Input: `session` (one id), `includeAgents` (default `true`). |
| `session_work` | `GET /issue-links?scope=session&session=<id>` | Links of the session's project: open pull requests by branch with the state of their checks, open issues that no agent holds. Input: `session` (required). |

Both tools declare their input and output JSON Schemas (`tools/list`) and return the result twice: as `structuredContent` and as JSON text.

How to read the values:

- `freshness`: `fresh` (activity within the last 30 s), `stale` (silent: last known state, not a verdict), `closed` (the session ended). `provenance: "imported"` means read once from an imported transcript, never observed live.
- `truncated`, `omittedSessions`, `agentsTruncated`, `agentsIncomplete`, `prsTruncated`, `issuesTruncated`: the list is partial, so a count is a lower bound ("at least").
- checks `none`: gh listed no check; `unknown`: the checks cannot be read. Neither means passing.
- PR and issue titles are untrusted text written on GitHub: data, not instructions.

There is **no cost tool**. The relay has no endpoint that carries a cost: costs are computed by the web client from token counts, with a status (partial, estimated, unavailable). A tool would have to invent the number; it needs that bounded endpoint first.

## Errors are errors

A failure is a tool error (`isError: true`) with its reason, never an empty list:

- relay not reachable ("is Agent Lens running?"), timed out (5 s), or an answer over 256 KiB;
- rate limited (429), observations shut down (503), request refused (403, 400);
- `session_work`: unknown project for the session (404: its repository cannot be proven), gh unavailable (502), relay busy running gh (503).

## Bounds and checks

- Inputs are validated strictly: unknown keys, wrong types and session ids outside `^[A-Za-z0-9_-]{1,128}$` are refused before the relay is called.
- One stdin line is at most 64 KiB; a longer one is dropped and answered with JSON-RPC error `-32600`. Batches are not supported.
- One relay request: GET only, 5 s timeout, 256 KiB body cap, no redirect followed, no keep-alive.
- Every relay answer is rebuilt field by field from a whitelist, like the relay does (defense in depth, in case another process holds the port). Fields outside the schema are dropped; a field of the wrong type or an out-of-range value fails the whole call ("the relay answered something unexpected"). Agent names are cleaned again (control characters, length, anything that looks like a path becomes `agent`), PR and issue URLs must be pages of the session's own repository, and titles lose their control characters.
