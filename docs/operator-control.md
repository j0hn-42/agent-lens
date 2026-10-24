# Operator control (VS Code, off by default)

Agent Lens can pass your decision on a Claude Code permission request back to Claude Code (#240). This page describes the **decision channel** of the VS Code extension: the optional hook, the setting, the checks and the journal. The Agent Lens panel in VS Code uses it to show **Approve**, **Deny** and **Redirect** buttons (see [The panel](#the-panel)). Until the panel sends `permission-surface` (see [Protocol](#protocol-for-the-panel)), nothing is ever held and Claude Code behaves exactly as without Agent Lens.

Scope, on purpose: the VS Code extension only. The standalone relay and the browser app have no control channel and no HTTP route to decide: a web page cannot answer a permission request.

## Switching it on

Two things are needed, and both are explicit:

1. Run **Agent Lens: Install the Permission Hook (operator control)**. It adds one `PermissionRequest` hook to your global Claude Code `settings.json` (timeout 60 s) and installs `~/.claude/agent-lens/permission-hook.js`. The observation hooks are not touched, and re-running **Configure Claude Code Hooks** keeps this one. The script is refreshed at each start of the extension while the hook is installed, so an update reaches it without reinstalling. **Remove the Permission Hook** takes it out again; uninstalling the extension removes it too.
2. Turn on `agentVisualizer.allowControl` (default `false`). It is machine-scoped: set it in your User Settings, a workspace `.vscode/settings.json` cannot switch it on. It is read at each request, and turning it off ends the requests already waiting at once (journalled `disabled`), so it needs no reload.

## What Claude Code is told

The decision follows the `PermissionRequest` hook output documented in the Claude Code hooks reference (<https://code.claude.com/docs/en/hooks>, "PermissionRequest decision control"):

```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "deny", "message": "..." } } }
```

- `allow` grants the request. Claude Code still evaluates its deny and ask rules, so an allow here never overrides a matching deny rule.
- `deny` refuses it, and `message` tells Claude why. **Redirect** is a deny whose message is your text (it must not be empty); that is how Claude learns what to do instead.
- Agent Lens never sends `updatedInput`, `updatedPermissions` or `interrupt`: no "always allow", no change of the input, no batch.
- A hook that prints nothing, or exits 2 without a `decision` object, leaves the permission flow unchanged: Claude Code shows its normal prompt. Agent Lens relies on this for every failure.

## Fail closed

There is no decision, and Claude Code asks as usual, when any of these holds:

| Situation | Result |
| --- | --- |
| `agentVisualizer.allowControl` is off, or the hook is not installed | The hook (if present) exits at once with no output. |
| No Agent Lens panel is open and able to answer (it has not declared a decision surface) | The request is not held: no 60 s wait for nobody. |
| Agent Lens is not running, the workspace does not match, or the instance published no token | `permission-hook.js` exits with no output. |
| The token is missing or wrong, the request has an `Origin` header (a browser), or the Host is not loopback | Refused (403); the hook prints nothing. |
| You do not answer within 55 s | The extension answers first, with no decision, journalled `expired` (the hook's own deadline is 59.5 s). |
| You answer in the terminal first, or the hook is killed | The connection closes, the request is dropped, journalled `answered-elsewhere`. |
| `agentVisualizer.allowControl` is turned off while requests wait | They end at once with no decision, journalled `disabled`; a decision that arrives after the switch is refused (`disabled`) and ends its request too. |
| The panel is closed, or says it can no longer answer | Waiting requests end with no decision, journalled `surface-closed`. |
| More than 16 requests wait at once | The extra ones get no decision. |
| The decision cannot be written to the journal | It is not sent. |
| The answer of the instance is not exactly a decision, or comes without a valid proof that its sender knows the token | `permission-hook.js` prints nothing. It rebuilds the output field by field and never produces an `allow` by itself. |

## What a decision is bound to

A decision names `(session_id, tool_use_id, nonce)` and works **once**. The nonce is 16 random bytes made for each request. A wrong session or tool call is refused and does not use up the request; a second use of the same nonce is refused and journalled `rejected-replay`.

The `PermissionRequest` hook input has **no `tool_use_id`**. Agent Lens fills it in only when exactly one open `PreToolUse` call of that session has the same tool and the same input (compared by SHA-256 of the canonical JSON). Otherwise `toolUseId` is `null` and only a decision that names `null` matches. It is never guessed. This needs the observation hooks (they provide `PreToolUse`); without them it is always `null`.

## Authentication

- A token of 32 random bytes is made at each start. It lives in memory and in the discovery file `~/.claude/agent-lens/<hash>-<pid>.json`, which is now written owner-only (0600) — and only while `allowControl` is on.
- `permission-hook.js` presents it in the `X-Agent-Lens-Token` header; the hook server compares it in constant time. Another local process of the **same user** can read the file and is not stopped by this (same trust boundary as `~/.claude/settings.json`); other users cannot.
- The answer is authenticated the other way too. The hook sends a random challenge (`X-Agent-Lens-Challenge`, 16 bytes) with each request; the instance answers a decision with `X-Agent-Lens-Proof`, an HMAC-SHA256 keyed by the token over the challenge, the SHA-256 of the request body and the decision. `permission-hook.js` recomputes it and compares in constant time before it prints anything. A process that merely listens on the port of a leftover discovery file (VS Code crashed, the pid was reused) does not know the token: whatever it answers, including an `allow`, is not printed. A request without a valid challenge is not held.
- The hook server stays on 127.0.0.1, checks the Host header (DNS rebinding) and refuses any request with an `Origin` header (browsers).
- The panel talks to the extension through VS Code `postMessage` only.

## The journal

`~/.claude/agent-lens/decisions.jsonl`, owner-only (0600), opened append-only (a symbolic link at that path is refused). At 1 MiB it moves to `decisions.jsonl.1`, replacing the previous one: two generations at most. One JSON line per request that ended or was refused:

| Field | Meaning |
| --- | --- |
| `ts`, `sessionId`, `toolUseId` (or `null`), `tool`, `channel` (`vscode`) | When, which session and call. |
| `decision` | `approve`, `deny`, `redirect`, or `none` when no decision was given. |
| `inputSha256` | SHA-256 of the tool input, **not the input**: the journal holds no command, path or secret. |
| `messageChars` | Length of a redirect message, never its text. |
| `outcome` | `sent`, `expired`, `answered-elsewhere`, `surface-closed`, `shutdown`, `disabled`, `rejected-replay`, `rejected-mismatch`. |
| `entrySha256` | SHA-256 of the line without this field, so an edited line can be noticed (it does not make the file tamper-proof). |

`sent` means the decision was handed to Claude Code. It is **not** proof that it was applied: that can only be seen later (a `PostToolUse` for the call, or the refusal). The journal never claims it; the panel shows a refusal it observed (see [The panel](#the-panel)). On Windows the 0600 mode is not enforced by the file system; use the profile's permissions. Uninstalling the extension deletes the whole `~/.claude/agent-lens/` folder, the journal included.

## The panel

Inside VS Code, the Agent Lens panel declares its decision surface when it opens and withdraws it when it closes or unloads. Each request the extension holds is shown at the top right of the canvas with:

- the tool, the session (its label when the session list has one, and its full id), the tool call id (or "not identified" when it is `null`) and the deadline (`expiresAt`, wall-clock time);
- the whole input as JSON text. Control and invisible characters (bidi overrides, zero-width marks) are written as their `\uXXXX` escapes, so the command cannot read differently from what runs. A cut input says it is truncated and gives the SHA-256 of the whole input;
- three buttons, **Approve**, **Deny** and **Redirect**. Their accessible names repeat the tool, what it acts on and the session ("Approve Bash: npm test, session fix-login"). There is no keyboard shortcut for them and nothing takes the focus: news (a decision sent, a refusal applied, a request that expired, was answered elsewhere, or ended because control was turned off or the panel closed, a decision the extension refused) is announced in a polite live region.

A click on Approve or Deny sends one `permission-decision`. **Redirect** (#387) first opens a modal dialog that recalls the request (session, call, whole input) and asks for a **Message for Claude**: the focus starts in the text field and stays in the dialog (Tab, Shift+Tab), Escape or **Cancel** closes it without sending and gives the focus back to **Redirect** (or to the panel when the request ended meanwhile, which also closes the dialog). The text is required: an empty, blank or invisible-only text is not sent, and the field says so in a polite live region. It is cleaned as the extension cleans it (control and invisible characters removed, trimmed, 2000 characters at most), sent as `action: 'redirect'` with `message`, and not kept: not on screen after sending, and not in the journal, which records only `messageChars` (only its first 40 characters stay in the page's memory, to recognise the refusal, see below). A text far past the cap (over 8000 characters) is refused by the extension as malformed. No batch, no "always allow".

The request then reads "Decision sent". It reads **"Deny applied"** or **"Redirect applied"** only when the refusal is observed: after the extension said `sent`, a live `tool_call_end` of that very call (same session, same non-null `toolUseId`) ended in error, was not an interrupt, and its result contains the refusal this page sent (the deny text `Denied by the operator from Agent Lens.`, or the first 40 characters of the cleaned redirect text, spaces collapsed). That beginning of the text is kept in the page's memory for this comparison only, never shown or written. A replayed or imported event does not count, and neither does a hook `PostToolUseFailure` (`[FAILED]` result): it is a call that ran, and the hook server does not authenticate ordinary events. An approval is never shown applied, nor a request whose call is "not identified" (`toolUseId: null`), nor a decision sent from another panel. A request that ends without a decision disappears from the panel. The browser app and the standalone relay show nothing of this.

## Protocol for the panel

Messages from the page to the extension:

- `{ type: 'permission-surface', ready: boolean }`: the page can show and answer requests. Sent with `ready: false` when it no longer can, which ends what waits with no decision. Requests already waiting are sent when it becomes `true`.
- `{ type: 'permission-decision', sessionId, toolUseId, nonce, action: 'approve' | 'deny' | 'redirect', message? }`.

From the extension to the page: `permission-request` (session, `toolUseId`, `nonce`, tool name, the input as JSON text capped at 64 KiB with `inputTruncated`, its `inputSha256`, `requestedAt`, `expiresAt`), `permission-closed` (how it ended) and `permission-result` (`ok`, or `reason`: `unknown`, `closed`, `mismatch`, `message-required`, `disabled`, `journal-failed`, `no-surface`). The page must show the whole input before offering a button, give redirect a non-empty text, and tell "sent" from "applied".

## Not covered

- The standalone relay and the browser app (no control there, by design).
- `scripts/setup.js` (the standalone installer) does not install the permission hook; use the VS Code command.
- Notification-based "waiting for permission" states are still deduced as before; this channel does not change them.
