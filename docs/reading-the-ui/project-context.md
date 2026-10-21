## Project folders

Claude Code stores a session under `~/.claude/projects/<folder>`, where every character that is not a letter or digit of the project path becomes `-`: `/Users/me/my_project` and `C:\Users\me\my_project` give `-Users-me-my-project` and `C--Users-me-my-project`. Agent Lens finds the folder of your workspace and of its sub-projects with that rule, ignoring case on Windows. Past 200 characters Claude Code cuts the name and appends a hash that Agent Lens cannot recompute, so such a folder is matched on its first 200 characters.

## Skills, plugins and memory

The Context panel ends with a **CAPABILITIES** block (#242): what the selected session received or used, read from its main transcript (the file the relay already follows) when the panel opens or is refreshed. It is not what is installed on the machine: a skill or server that is installed but never reached the session is not listed.

| Group | Proof in the transcript |
| --- | --- |
| **Instructions loaded** | an `instructions` attachment (`files[].type` and the file's base name) or a `nested_memory` attachment (shown with the type `nested`). Only the base name is sent, never a path or the content. |
| **Skills**, grouped by plugin | a `Skill` tool call (`input.skill`, counted: "invoked N times") and the `skill_listing` attachments (`names`, union: "listed, no invocation seen"). The plugin is the namespace of the name (`plugin:skill`); a name without one is under **No plugin**. Skill arguments and descriptions are not sent. |
| **MCP servers** | `mcp__<server>__<tool>` tool calls, counted per server and per tool, and the servers named in an `mcp_instructions_delta` attachment ("announced"). Names are matched exactly: an announced name that differs from the prefix of its tools is shown twice rather than guessed. Tool inputs are not sent. |

| You see | It means |
| --- | --- |
| **Partial: only the first 32 MB ...** | The transcript is larger than the bound: only its head was read, so every count reads "at least". |
| "Lists capped ..." | A list reached 200 entries; later ones are not shown. |
| "No ... in the transcript" | Nothing of that kind was recorded. It does not say that the session had no skill or no server. |
| "The session transcript could not be read" | Missing, a symbolic link, outside the Claude projects folder, or a read error: the capabilities are unknown, never shown as empty lists. |
| "Not provided by this relay" | The relay is older than this view and sends no capabilities. |

Limits, on purpose: sub-agents (their own transcripts and sidechain lines) are not included; Codex, Copilot, Pi, Gemini CLI and OpenCode sessions and imported transcripts have no project context, so no capabilities either. The read is local, read-only and bounded, and the relay re-parses a transcript only when its size or modification time changed.

## Resuming a session

The Context panel starts with a **RESUME** block (#240): the command `cd '<cwd>' && claude --resume <session id>`, shown as text, and a **Copy** button that puts it on the clipboard. Paste it in a terminal on the machine where the session ran to reopen it in Claude Code. Nothing is run from Agent Lens and no request is made: the command is built in the page from the session list, so it works in VS Code as well. The result of the copy is announced ("Resume command copied" or "Copy failed: select the command and copy it by hand"); a failed copy is never reported as a success.

The working directory is quoted for a POSIX shell (bash, zsh, sh): every character between the single quotes is literal, and an apostrophe in the path is written `'\''`. Spaces, `$`, backquotes, `;` or `&` in a path are not interpreted.

The command is offered only when it can be shown to be right. Otherwise the block says why, and there is no Copy button:

| You see | It means |
| --- | --- |
| "only Claude Code sessions can be resumed" | The session comes from Codex or Copilot, or its runtime is unknown. |
| "an imported transcript comes from another machine" | The session was imported: its directory is not a local one. |
| "the working directory ... is unknown or not an absolute POSIX path" | No cwd was reported, or it is not a single-line absolute POSIX path (a Windows path, a relative path, a line break or a control character). |
| "the session id is not one Claude Code can take" | The id fails the relay's check (letters, digits, `.`, `_`, `:`, `-`, 128 characters at most) or starts with `-`, which `claude` would read as an option. |

### Go to terminal (VS Code only)

Inside the VS Code extension the RESUME block also has a **Go to terminal** button (#240). It asks VS Code to open an integrated terminal whose working directory is the one the extension recorded for the selected session. Nothing is typed or run in that terminal: you choose what to run, for example by pasting the resume command.

- The page sends the session id only, never a path. The extension looks the session up itself, and refuses when it does not know the session, when its directory is unknown, is not an absolute single-line path, or no longer exists (a warning says which).
- The button is offered for every runtime that reports a directory (Codex, Copilot and Pi included), not only for Claude Code, and never for an imported transcript. It does not exist in the browser app: a page cannot open a terminal.
- The status line says "Asked VS Code to open a terminal ...": that the request was sent is all Agent Lens can prove. Whether the terminal opened is shown by VS Code itself.

### Permission requests (VS Code only)

With operator control on ([operator-control.md](../operator-control.md)), a permission request Claude Code is waiting on appears at the top right of the canvas with the tool, the session, the whole input and its deadline, and three buttons: **Approve**, **Deny** and **Redirect**. **Redirect** opens a dialog for a text Claude receives with the refusal, so it can change course; the text is required, and it is never kept on screen nor written to the journal (only its length is).

| You see | It means |
| --- | --- |
| "Sending the decision…" | Your click left the page; the extension has not answered yet. |
| "Decision sent: approve" (or deny, or redirect) | The extension handed your decision to Claude Code. **Sent is not applied**: whether the tool ran (or the refusal reached Claude) only shows later in the transcript. |
| "Deny applied" / "Redirect applied" | After your deny or redirect was sent, the session showed live the end of **that very call** (same session, same tool call id), in error, not interrupted, and its result contains the refusal: the deny text, or the beginning of your redirect text. That is the observed refusal. A failure reported by the hook (`[FAILED]`), another error text, an approval, a call that is "not identified" and a decision sent from another panel are never shown applied. |
| "Decision sent from another panel" | A decision for this request was handed to Claude Code, not from this page. |
| The request disappears, with an announcement | It ended without a decision: the deadline passed, Claude Code stopped waiting (answered in the terminal, call interrupted), control was turned off or the panel could no longer decide. Claude Code then shows its usual prompt. |
| "Input truncated" | Only the first 64 KiB of the input are shown; the SHA-256 given is the one of the whole input. |
| `\u202e` and other escapes in the input | An invisible character of the real input, shown as its escape instead of being applied to the text. |

**A detail popup is placed so that it does not hide a pending decision (#536).** When you open the popup of a tool call or of a discovery while a permission request is shown, the popup is placed so that it covers no part of the card: neither its title, nor **Approve** and **Deny**. Press Tab from the popup: the keyboard reaches **Approve** and **Deny**, each one is drawn, has a focus indicator and is not covered. Press Escape in the popup: it closes, the request stays, and the focus returns to the outline button that opened it (measured from the screen-reader outline only). What is measured: `web/tests-a11y/e2e/popup-permission.e2e.ts` opens both kinds of popup over one real permission card (a fake extension bridge posts the request to the demo app) at 320x568, 390x844, 768x1024, 899x700, 1024x768 and, for the 200 % zoom heights, 640x360 and 640x300, in Chromium. Not proven: a real device, a browser other than Chromium, popup anchors other than the simulation's tool position, more than one pending card, and a popup opened by a click on the canvas (where the focus returns then).
