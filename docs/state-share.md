# Sharing state: snapshots and observations

Principle (epic #73): never display a state or a number that cannot be proven.

## Validated snapshots (#71) — `extension/src/state-snapshot.ts`

A process that wants to share its state publishes **one JSON file per (kind, owner)**:
`<dir>/<kind>.<owner>.json`.

| Field | Meaning |
| --- | --- |
| `schema` | Envelope version (`1`); any other value is refused |
| `kind` | What the payload is (`[a-z][a-z0-9-]{0,31}`) |
| `owner` | `{ id, pid }`: which producer wrote it |
| `generation` | Monotonic counter of this owner's writes |
| `writtenAt` | Producer wall clock (ms) |
| `payload` | Plain JSON object, depth <= 8, arrays <= 1000, <= 200 keys per object |

- **Atomic write**: temp file in the same directory (`wx`, mode 0600), `fsync`, `rename`. A reader sees the old
  file or the new one, never a partial one; the temp file is removed on failure.
- **Strict read**: symlinks refused, size cap (256 KiB), unknown or missing keys refused, wrong types refused,
  corrupt JSON refused, a `writtenAt` more than 5 s in the future refused. The reason is returned
  (`missing | too_large | unreadable | corrupt | invalid | future`), never thrown.
- **Freshness**: `fresh` up to 30 s (inclusive) after `writtenAt`, `stale` afterwards (same threshold as a silent
  agent on the canvas). The age is computed by the reader, from the producer's timestamp.
- **Concurrent producers**: per owner the highest `generation` wins (a clock going backwards cannot resurrect an
  old write); across owners the latest `writtenAt` wins, ties go to the smaller owner id, so every reader picks
  the same snapshot (`selectSnapshot`).

### Decision: is a multi-window need confirmed?

**No.** Today each process (relay, VS Code window) watches the same `~/.claude` transcripts and hooks itself, and
the relay is the single source for the web UI. Nothing in the product needs one window to read another window's
state, so **no reader or writer is wired into a runtime**: only the primitives (atomic write, strict read, freshness,
arbitration) exist and are tested. They are to be used when a real multi-window or multi-IDE need appears;
wiring them earlier would add a second source of truth to reconcile (see `relay-sources.md`) for no proven benefit.

## Observations for Claude (#72) — `extension/src/observations.ts`

Typed action `observations` (name, description, JSON Schemas `inputSchema` / `outputSchema` in
`OBSERVATIONS_ACTION`). The relay serves it on loopback only, rate-limited like `/status`:

- `GET /observations[?session=<id>][&agents=0]` runs the action.
- `GET /observations/schema` returns the definition so a client can learn the schema.

Output is built **field by field from a whitelist**: per session `id`, `runtime`, `status`, `startedAt`,
`lastActivityAt`, `ageMs`, `freshness` (`fresh | stale | closed`), `agentCount`, and optionally the agents
(`name` sanitized, capped, replaced by `agent` when it looks like a path; `state` active / idle / complete).
Session labels (derived from prompts), `cwd`, workspace, team tags, messages and tool arguments are never
returned. Limits are reported, not hidden: `truncated` (more than 25 sessions), `agentsTruncated` (more than
50 agents), `omittedSessions` (ids that are not plain identifiers).

Shutdown: `relay.dispose()` disposes the action (idempotent); afterwards the endpoint answers 503.
