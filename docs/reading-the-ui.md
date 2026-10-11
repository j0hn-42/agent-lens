# Reading the UI

Principle (epic #73): never display a state or a number that cannot be proven. When Agent Lens does not know, it says so instead of showing a plausible value.

## Views

- **Fleet / All**: the All view draws every watched session on one canvas. Each session is a dotted halo (its label gives runtime, workspace, status and cost; click it to zoom to the cluster). Sessions of the same project are grouped together.
- **Workflows and Teams**: a dashed halo groups agents. A *Team* is a Claude Code Agent Team; a *Workflow* is one run of the Workflow tool. The hierarchy is Session > Workflow or Team > Agent.
- **Comms**: message links between agents. Long dashes mean a message in flight, a solid line a recent one, a dotted red line an error. The badge is the message count; click a link (or its latest-message bubble) to read it in the link panel.
- **Context**: the project context of a session (`CLAUDE.md`, the memory index and the issue numbers they cite). It is loaded only when the panel opens or you refresh it, and a failure is shown as a failure. Below it, with the standalone relay, a table lists the open pull requests of the session's repository by branch with the state of their checks (the PR of the session's own branch reads "(this session)"), and the open issues no agent holds. "no checks reported" is not "passing", and "At least N ... shown" means the list is partial. See [node-inspector.md](node-inspector.md).
- **Sessions, Timeline, Files, Conversation**: the panels listed in the README.
- **Session export**: the ⤓ button of a session row saves it as a standalone HTML replay. The file states its own limits: events dropped before the export ("Incomplete history"), the number of secrets redacted (best effort), stream times, and agent states taken only from lifecycle events (otherwise "unknown"). See [session-export.md](session-export.md).
- **File conflicts**: two or more agents (of one session or of several) that modified the same file. A red dash-dot line with a diamond in its middle joins two such agents on the canvas, in every view where both are drawn (one line per pair, whatever the number of files). The Files panel lists the conflicts first (file and every agent with its number of edits) and tags the file row with the word "conflict"; with the editor available (VS Code), Enter on a conflict opens the file. The graph outline (screen readers) has a "File conflicts" list with the same sentences, an agent hidden from the canvas being named "not on screen". Only proof counts:
  - an edit is an `Edit`, `Write`, `MultiEdit` or `NotebookEdit` call whose success was observed. A failed or cancelled edit, or one whose end was never seen, proves no write and makes no conflict; a read never does;
  - the path must be absolute (normalised: separators, `.` and `..`, Windows drive letter). A relative path names a file only in a working directory that is not known, so two relative paths are never compared;
  - the edits are not required to overlap in time: a conflict says that two agents wrote the same file, not that they did so at the same moment. Edits made by other runtimes (for example Codex patches) are not recognised yet.
- **Review (pause) and switching session**: Review pauses the scene; events that arrive meanwhile wait in a queue, and Resume live reports how many. If you switch session while reviewing, the queue of the session you leave is not dropped: the position it had reached is kept with that session, so the events received while paused (and those received during the switch itself) are replayed when you come back. The view you switch to is live, so the review ends with a short notice ("Review ended: session changed") and the bar shows the live controls again; it never shows Review over a scene that is playing.
- **Renaming a session**: in the Sessions panel, the pencil button (or F2 on a row) gives a session a name of your own. Enter saves, Escape cancels, an empty name restores the original. The name lives only in this browser (local storage); it is never sent to the relay or written to a transcript. In the Sessions panel a renamed session keeps its original label in the tooltip and for screen readers; elsewhere (canvas, top bar) only your name is shown. The panel already lists active sessions first, most recent activity first, and groups them by project.

The graph legend (bottom left of the canvas) explains every colour, shape and line.

### See the legend in action

The guided tour (`pnpm run dev:demo:guided` or `?scenario=guided`, see [demo.md](demo.md), in French) walks through every section of the legend. Steps per section:

- **States**: steps *Meet your agent*, *Tool calls*, *Results come back*, *Waiting for you*, *When something fails* and *Agent Teams*. The `paused` state is described only, in step *Seen only in a real session*.
- **Shapes**: steps *Meet your agent*, *Tool calls*, *Sub-agents* and *Results come back*. The discovery card shape is described only (*Seen only in a real session*).
- **Edges and particles**: steps *Tool calls*, *Sub-agents* and *Results come back*. The dispatch and return particles are described only, in *Sub-agents* and *Results come back*: the tour pauses the scene at each step, and a paused scene draws no particle. The unverified parent link, the file conflict line and the two folded-branch badges are described only (*Seen only in a real session*).
- **Teams**: step *Agent Teams* (and *Delivered messages and finished teammates* for a finished teammate, *Results come back* for an archived agent). The session halo is described only (*Seen only in a real session*).
- **Message links**: steps *Messages between agents*, *Delivered messages and finished teammates* and *Quiet links*. The error link is described only (*Seen only in a real session*).
- **Context usage**: step *Context usage*.
- **Discoveries**: none of these entries is shown in the demo; they are all described only (*Seen only in a real session*).
- **Runtime**: steps *Meet your agent* (Claude) and *Two runtimes* (Codex).

## Why this tool? and the causal chain of a failure

Click a tool call (or press Enter on its button in the graph list, or on the focused tool card): its popup has a **Why this tool?** disclosure (a native `<details>`: Tab to it, Enter or Space opens it). Every line is backed by an observed event; what cannot be proven is said so.

- **Reasoning observed just before this call**: the thinking that sits right before the call, in the same agent's own conversation, matched by the call's `tool_use_id`. Parallel calls of one batch share the reasoning that precedes the batch. Anything separated from the call by a result, an answer or a prompt is not attributed to it.
- **No reasoning observed just before this call**: the call is in the history and nothing precedes it. This is a finding, not an error.
- **Reasoning not disclosed by the runtime**: the runtime redacted the thinking; no text is invented.
- **Not provable: ...**: the call has no `tool_use_id`, is no longer in the kept history (conversations are bounded), or older messages were dropped. "Unknown" is never shown as "none".

A failed call also gets a **Causal chain of this failure**, an ordered list from the failure back to the prompt: the error text, the reasoning before the call, then for a sub-agent the dispatch that started it (who dispatched whom, with the full prompt and the parent's reasoning before the dispatch), and finally the **latest prompt observed before it** in the root agent's conversation. A hop needs the dispatch message with the same `tool_use_id` and a *verified* parent-child link; otherwise the chain stops with `Chain stops: ...` and says why. The prompt is an ordering fact (the latest one seen before), not a claim that it caused the failure. The derivation lives in `web/lib/tool-reasoning.ts`.

## Themes

The **Theme** selector in the top bar (View controls) offers nine themes, all dark:

| Theme | Pick it for | Look |
|---|---|---|
| **Catppuccin Macchiato** (default) | everyday use | the mid-dark Catppuccin flavor: soft slate-blue grounds, mauve accent |
| **Catppuccin Mocha** / **Catppuccin Frappe** | the Catppuccin palette you already use in your editor and terminal | the darkest and the lightest dark flavors (Latte, the light flavor, is not offered) |
| **Midnight** | long sessions, less eye strain | calm indigo and blue-violet, softer than Neon |
| **Graphite** | a neutral look | neutral grey, flat cards |
| **Neon** | the original look | cyan on deep blue-black, glass cards |
| **Ember** | the evening, reduced blue light | warm charcoal and brown, soft amber accent, almost no blue |
| **Anthropic** | a warm, neutral look | near-black warm greys, off-white text, orange accent. Inspired by the public colours of Anthropic; not an official theme, and it uses no logo |
| **High contrast** | low vision, bright rooms | pure black, white text (7:1 or more), yellow accent, strong white borders, a 3px focus ring |

The choice is stored in the browser (`agent-lens-theme`) and applied before the first paint. `?theme=catppuccin-macchiato|catppuccin-mocha|catppuccin-frappe|midnight|graphite|neon|ember|anthropic|contrast` picks a theme when nothing is stored. The system or VS Code light mode never switches the theme. The former light theme **Paper** was removed, and Catppuccin Macchiato is the default (it replaced Graphite): a stored `paper`, `light` or `dark` (and `?theme=` with one of these) now opens Catppuccin Macchiato, while a stored valid theme id, graphite included, is kept. In Midnight, Ember and High contrast the states (done, tool, error, delegate) also differ by lightness, not only by hue; the Catppuccin and Anthropic themes keep their own hues. In every theme a state is always paired with a word or an icon.

Catppuccin and the official palette: the colours are the ones of palette.json 1.8.0, mapped on the roles (void = crust, surface = mantle, surface-raised = base, edge = surface1, control-border and context-system = overlay1, ink = text, ink-muted = subtext0, accent = mauve, on-accent = crust, focus = blue, ok = green, warn = yellow, danger = red, delegate = lavender, info = teal). Every role value is the official one, unmodified. The only adjustments are in the Bash ANSI palette (the official normal and bright colours, 0 to 15), where a few entries are lightened toward white, just enough to keep 4.5:1 once dimmed: black and bright black (0 and 8) on the three flavors, bright red (9) on Macchiato, and red (1), blue (4), bright red (9) and bright blue (12) on Frappe. A few derived tints of the interface (error row, search highlight) are lighter-weight than before for the same reason.

Anthropic and the brand colours: Dark `#141413` is the surface, Light `#faf9f5` the text, mid grey `#b0aea5` the muted text, orange `#d97757` the accent (dark text on it), blue `#6a9bcc` the delegate colour. The brand green `#788c5d` is 4.48:1 on the raised surface, just under 4.5:1, so `ok` is lightened to `#8fa774`. The brand has no yellow, red or teal: warn, danger and info are warm derived colours, and the grounds (void, raised, edge, control border) are warm greys derived from Dark.

**The theme applies to the interface only.** The toolbar, menus, dialogs, side panels (Conversation, Context, Cost, Files, Timeline, Stats), the legend, the inspector, the UI cards and the focus rings follow the theme. The page background and everything drawn on the scene (nodes, links, halos, phase zones, particles, bloom, bubbles and tool cards drawn on the canvas, canvas labels, grid) keep the neon colours in every theme. Interface elements that sit above the dark scene stay readable: the top bar carries its own surface, the legend icons sit on a scene-coloured tile, and every focus ring keeps 3:1 or more against both the interface surfaces and the scene.

For contributors: the interface colours are defined by role in `web/lib/theme-tokens.json` (copy of the design tokens) and generated into `--lens-<role>` custom properties per `[data-theme]` in `web/app/themes.css` (`pnpm run gen:themes`). `COLORS` (`web/lib/colors.ts`) is the interface palette, rebuilt from the computed properties on every theme change: read `COLORS.<key>` when you render, never cache it at module load (use `themed(() => ...)` for a module-level table). `SCENE` is the frozen neon palette used by the canvas, the simulation and the page background: canvas code never reads `COLORS` (a test enforces it). Colour never carries a state alone: a word or an icon always goes with it.

## Honest values

| You see | It means |
| --- | --- |
| **Observed** | Agent Lens received events for it. |
| **Not observed** / "listed - activity not observed" | The session or agent is known (for example listed on disk) but no event was ever received. No state or activity is invented for it. |
| "Not observed yet" (agent card) | The agent was announced but nothing has been seen from it. |
| "fin non observée" (tool card) | The tool call started but its end was never seen. It is not shown as success or failure. |
| "last known state: X, silent for N min" | The agent sent no event for more than 5 minutes (the status is already "last known state" after 30 s). It is a silence, not a verdict: a long tool call or a long thought is silent too, so Agent Lens never writes "stuck". Shown in the agent card (inspector) and on the agent row of the Sessions panel, in whole minutes. |
| "waiting for permission for N min" | The last event of the agent was a permission request, and nothing answered it for more than 5 minutes. This is told apart from a plain silence because the agent itself said it was waiting for you. |
| **at least X** ("au moins") | The total is partial: some part is absent, so the real value is X or more. It is never shown as a complete number. |
| **estimated** ("estimé") | The token count was computed locally, not reported by the runtime. |
| "no checks reported" / "checks unknown" (PR row) | gh listed no check for the PR, or its checks cannot be read. Neither is shown as passing. |
| **non renseigné** | The value is unavailable. It is not shown as 0. |
| **unattributed** | A cost that cannot be tied to exactly one agent (unknown name, or several agents share it). It is listed apart, priced at the default rate, and included in the session total. See [node-inspector.md](node-inspector.md). |
| **conflict** (Files panel, canvas line) | Two or more agents each made at least one edit of the same absolute file that was observed to succeed. An edit not seen to succeed is never counted. |
| **Loading history (n/N)** | A burst of received events (switching to All, a relay replay) is being applied a few milliseconds per frame: n of the N events are on the canvas, the rest are not drawn yet. Screen readers hear the start and "History loaded (N events)" at the end. |
| **imported - not live** (Sessions panel) | The session was read once from an imported transcript file (`--import`, see [relay-sources.md](relay-sources.md)). It shows what the file recorded up to its last line. It is never shown as active: whether it still runs elsewhere is unknown. Its agents are at best *last known state*, never current, and the inspector says *(imported transcript)* after the last event time. Imported sessions are grouped under **Imported transcripts**, which the project filter also offers. With **Active only** on, an imported session is listed only while selected. |
| **Loop observed** / "No loop in the observed part" | The loop verdict (see [Loops and health verdict](#loops-and-health-verdict)). It never says "healthy": at best "No loop observed" over the calls it lists. |
| **Not provable: ...** / **Chain stops: ...** | The reasoning or the next hop of a failure cannot be proven from the kept history (see [Why this tool?](#why-this-tool-and-the-causal-chain-of-a-failure)). Nothing is guessed. |
| `actual` / `configured` / `requested` (model pill) | Where the model shown comes from, strongest first. `requested != actual` means the runtime used another model. |

A silence is reported only for a status seen live and only for an agent that is not closed (done, failed or interrupted). A status that comes from a replayed history is never reported as silent: its age is not a wall-clock silence. The threshold is `SILENT_AFTER_MS` in `web/lib/canvas-constants.ts`.

## Repeated reads and calls

The **Files** panel opens with a "Repeated reads and calls" section, computed from the tool events already received (nothing is read from disk). It reports facts, not verdicts: a repeat may be intended.

| Row | It means |
| --- | --- |
| **read again N times, no edit seen in between** | The same agent read the same file, with the same offset and limit, N more times, and no Edit, Write or patch on that file (or a patch of unknown path in that session) was seen between the reads. A read of another range, or by another agent, is not a repeat: each agent has its own context. |
| **same Glob run again N times, no edit seen in between** | The same pattern and path, with no write seen in the session between the calls. |
| **same Bash command run again N times, right after itself** | The same command (Codex: `exec_command`) with nothing else called by that agent in between. A command can legitimately change its answer, for example when polling a log. |
| **at least X tokens** / **estimated** | Cost of the repeats only (the first call is not waste). "at least" because some repeat had no reported cost; **tokens not reported** when none had (never shown as 0). |
| **N calls had no input details and were not compared** | A Read, Glob or Bash call arrived without the input needed to compare it. It is counted apart, not guessed. |
| **Tracking limit reached: this list is a lower bound** | More distinct calls than the ledger holds (4000) were seen; later ones are not tracked, so the list may be missing repeats. |
| **N more not shown** | Only the 20 costliest rows are drawn. |

Only Read, Glob and Bash/`exec_command` are compared, because their input summary keeps every argument. Grep and the other tools are never compared: their summary drops options, so two equal summaries would not prove two equal calls. Edits made through Bash (for example `sed -i`) or outside the agent are not seen, so a re-read after one can be listed. Each row is a button that opens the file only when the path is absolute and the host can open files (VS Code); otherwise it is plain text.

## Context window (the "/ 1M" next to the gauge)

The used part of the gauge is a reading; the total is a window Agent Lens must **assume**, because Claude Code transcripts do not state it. Where it comes from, strongest first:

1. **Reported by the runtime** (Codex sends `model_context_window`): shown as is, even when the usage is above it.
2. **`CLAUDE_CODE_DISABLE_1M_CONTEXT=1`** (environment or the `env` of Claude Code's `settings.json`): every window is capped to 200k. In the VS Code extension this is read at start; for the relay and `npx agent-lens-app` it is read by `GET /status` (field `disable1MContext`, `false` when Claude Code is not watched), so the browser shows 200k as well.
3. **A `[1m]` suffix** in the model id: 1M.
4. **The model family table** (Opus, Sonnet, Fable, Mythos 1M; Haiku 200k; GPT 400k), 200k for an unknown model and 1M when no model is known yet.

A window cannot be smaller than what was used. When a reading is above the assumed window (a long session on a 1M model whose id was not recognised), the total grows to the next known size (1M), or to the usage itself beyond 1M, instead of showing more than 100%. The percentage then refers to an assumed window; the model pill and the table above say where it comes from.

## Project folders

Claude Code stores a session under `~/.claude/projects/<folder>`, where every character that is not a letter or digit of the project path becomes `-`: `/Users/me/my_project` and `C:\Users\me\my_project` give `-Users-me-my-project` and `C--Users-me-my-project`. Agent Lens finds the folder of your workspace and of its sub-projects with that rule, ignoring case on Windows. Past 200 characters Claude Code cuts the name and appends a hash that Agent Lens cannot recompute, so such a folder is matched on its first 200 characters.

## Notifications

The **Notifications** button in the top bar turns notifications on or off; **Settings > Notifications** chooses what triggers them. Nothing is asked of the browser until you turn them on, and the choice stays in this browser (local storage).

| Trigger | Fires when | Default |
|---|---|---|
| **Agent waiting for a permission** | an agent starts waiting for you to allow a tool | on |
| **Agent in error** | an agent reports an error | on |
| **Session finished** | a session you were watching goes from active to completed | off |
| **Cost threshold reached** | the cost shown in the top bar crosses the amount you set (USD, above 0, up to 10 000), once | off |

- **Where it shows.** In a browser, a system notification appears only while the tab is hidden (the tab title also carries the number of blocked agents). In VS Code, the webview asks the extension, which shows a native message unless the Agent Lens panel is the focused view. The extension checks and caps every message and shows at most one per trigger every 2 seconds.
- **Only what is new.** A trigger fires on a change, never for what was already there: the first state after loading is a baseline, a session already finished in the history is not announced as finished, and nothing is sent while the history is replaying.
- **Only what is proven.** A permission or error is counted only while the app can prove it (see the states above). A cost that is unknown never triggers; a lower bound triggers once it has proven the threshold is reached and the message says *at least*; an estimate says *estimated*. The wording is the one of the top bar.
- **Keyboard.** Every switch and the amount field are reachable with Tab; Space toggles a switch. An invalid amount is refused with a message and the previous threshold stays in force.

## Loops and health verdict

Agent Lens looks for two loop patterns in the tool calls it received (#230), per agent:

- **Repeated identical calls**: the same tool called 3 times or more in a row with the same input (same arguments, whatever their order).
- **Read → edit → failure cycles**: a file is read, edited (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`), then the edit itself or the next call fails; 3 such cycles in a row on the same file. A call that succeeds after the edit, or whose end was never seen, breaks the streak.

The **Health** section of the inspector gives the verdict of the selected agent, the evidence of each loop (one line each; hover a cycle line for the full path) and the verdict of its session. The Sessions panel marks a session row with "⟳ loop observed" only when a loop is proven; it says nothing otherwise.

| Verdict | It means |
| --- | --- |
| **Loop observed** | At least one pattern above was seen in the events. It may be over: the verdict covers the kept history, not only the last minutes. |
| **No loop observed (N tool calls)** | Every call of the kept history was compared and nothing repeated. |
| **No loop in the observed part** | No loop seen, but the history is partial: calls without input data cannot be compared ("n of N comparable"), or older messages were dropped (the last 200 conversation messages per agent are kept). A count that may have started before the dropped part reads "at least". |
| **Not enough activity to judge** | No comparable tool call was received. |

Limits, on purpose: only what the events prove is counted, so a loop can be missed (calls without input data, another tool between two identical calls, an edit followed by a read of another file) but is not invented. A tool that polls on purpose (the same `Bash` status command three times) is reported as a repeat: read the evidence before acting. Only sessions whose events are in the current view have a verdict.

## Motion by layer

Besides the global **Pause animations** button (and your system's reduced-motion setting), the canvas controls hold one toggle per layer. A pressed "Calm ..." toggle turns off the ambient motion of that layer only; the state it shows (colours, rings, labels) stays.

| Layer | Calms |
| --- | --- |
| Animated background | depth particles, grid pulse |
| Links | edge pulses, dashed flow, team halos |
| Agents | breathing, scanline, rings, tool-call pulses |
| Effects | message particles and trails, spawn / completion flashes, bloom |

With all four pressed the canvas behaves as under reduced motion. When your system asks for reduced motion, or Pause animations is on, every toggle is pressed and locked. The choice is kept in your browser. The labels of these controls come from a message catalog (`web/lib/messages.ts`) with French first; the language follows the stored choice, then the browser language, then English.

## The `observations` action

Claude can read what Agent Lens observes through the typed action `observations` (`GET /observations` on the loopback relay). The output is whitelisted field by field and reports its own limits (`truncated`, `agentsTruncated`, `omittedSessions`). See [state-share.md](state-share.md).

## More

- [node-inspector.md](node-inspector.md): model, cost attribution, issue and PR links.
- [relay-sources.md](relay-sources.md): how hooks and JSONL transcripts are reconciled, and the local server.
- [state-share.md](state-share.md): validated snapshots and observations.
- [session-export.md](session-export.md): the standalone HTML replay of a session.
