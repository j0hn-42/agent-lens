## The `observations` action

Claude can read what Agent Lens observes through the typed action `observations` (`GET /observations` on the loopback relay). The output is whitelisted field by field and reports its own limits (`truncated`, `agentsTruncated`, `omittedSessions`). See [state-share.md](../state-share.md).

## More

- [node-inspector.md](../node-inspector.md): model, cost attribution, issue and PR links.
- [relay-sources.md](../relay-sources.md): how hooks and JSONL transcripts are reconciled, and the local server.
- [state-share.md](../state-share.md): validated snapshots and observations.
- [session-export.md](../session-export.md): the standalone HTML replay of a session.
