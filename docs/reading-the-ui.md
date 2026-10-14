# Reading the UI

Principle (epic #73): never display a state or a number that cannot be proven. When Agent Lens does not know, it says so instead of showing a plausible value.

## Views

- **Fleet / All**: the All view draws every watched session on one canvas. Each session is a dotted halo (its label gives runtime, workspace, status and cost; click it to zoom to the cluster). Sessions of the same project are grouped together.
- **Workflows and Teams**: a dashed halo groups agents. A *Team* is a Claude Code Agent Team; a *Workflow* is one run of the Workflow tool. The hierarchy is Session > Workflow or Team > Agent.
- **Comms**: message links between agents. Long dashes mean a message in flight, a solid line a recent one, a dotted red line an error. The badge is the message count; click a link (or its latest-message bubble) to read it in the link panel.
- **Context**: the project context of a session (`CLAUDE.md`, the memory index and the issue numbers they cite). It is loaded only when the panel opens or you refresh it, and a failure is shown as a failure. Below it, with the standalone relay, a table lists the open pull requests of the session's repository by branch with the state of their checks (the PR of the session's own branch reads "(this session)"), and the open issues no agent holds. "no checks reported" is not "passing", and "At least N ... shown" means the list is partial. See [node-inspector.md](node-inspector.md). A **CAPABILITIES** block lists the instruction files, skills and MCP servers of the session (see [Skills, plugins and memory](#skills-plugins-and-memory)). At the top, a **RESUME** block gives the command that reopens the session from a terminal (see [Resuming a session](#resuming-a-session)).
- **Session scope** (top bar, standalone app and dev relay): this workspace, one project, or all workspaces. The sentence next to the selector is what the relay reports it scans ("Scanning this workspace only (name)"; nothing is written on all workspaces), not what you asked: the selector only moves once the relay confirmed. On a single workspace an empty Sessions list says that the scope is limited and how to widen it. A discovery ceiling that was hit (more than 500 transcripts in a folder, a transcript too large, the watch limit) is written next to the selector as "at least N": it is a partial view, not an absence. Choosing a project narrows the Sessions list and the All view to it and leaves the relay scope as it is. Changing the scope reloads the view (a notice says so). See [relay-sources.md](relay-sources.md).
- **System**: the health of the machine that runs the relay (CPU, memory, swap, disk, load), opened with the top bar button, the command palette or **Y**. A metric that could not be read says "Not available" and has no meter, it is never 0; the severity (Normal, Warm from 85 %, Critical from 95 %) is in words and an icon. Local clients only, not available inside VS Code or in demo mode. See [system-stats.md](system-stats.md).
- **Sessions, Timeline, Files, Conversation**: the panels listed in the README.
- **Session export**: the ⤓ button of a session row saves it as a standalone HTML replay. The file states its own limits: events dropped before the export ("Incomplete history"), the number of secrets redacted (best effort), stream times, and agent states taken only from lifecycle events (otherwise "unknown"). See [session-export.md](session-export.md).
- **File conflicts**: two or more agents (of one session or of several) that modified the same file. A red dash-dot line with a diamond in its middle joins two such agents on the canvas, in every view where both are drawn (one line per pair, whatever the number of files). The Files panel lists the conflicts first (file and every agent with its number of edits) and tags the file row with the word "conflict"; with the editor available (VS Code), Enter on a conflict opens the file. The graph outline (screen readers) has a "File conflicts" list with the same sentences, an agent hidden from the canvas being named "not on screen". Only proof counts:
  - an edit is an `Edit`, `Write`, `MultiEdit` or `NotebookEdit` call whose success was observed. A failed or cancelled edit, or one whose end was never seen, proves no write and makes no conflict; a read never does;
  - the path must be absolute (normalised: separators, `.` and `..`, Windows drive letter). A relative path names a file only in a working directory that is not known, so two relative paths are never compared;
  - the edits are not required to overlap in time: a conflict says that two agents wrote the same file, not that they did so at the same moment. Edits made by other runtimes (for example Codex patches) are not recognised yet.
- **Review (pause) and switching session**: Review pauses the scene; events that arrive meanwhile wait in a queue, and Resume live reports how many. If you switch session while reviewing, the queue of the session you leave is not dropped: the position it had reached is kept with that session, so the events received while paused (and those received during the switch itself) are replayed when you come back. The view you switch to is live, so the review ends with a short notice ("Review ended: session changed") and the bar shows the live controls again; it never shows Review over a scene that is playing.
- **Renaming a session**: in the Sessions panel, the pencil button (or F2 on a row) gives a session a name of your own. Enter saves, Escape cancels, an empty name restores the original. The name lives only in this browser (local storage); it is never sent to the relay or written to a transcript. In the Sessions panel a renamed session keeps its original label in the tooltip and for screen readers; elsewhere (canvas, top bar) only your name is shown. If the session leaves the list while you type, the edit is dropped. The panel lists active sessions first, most recent activity first, and groups them by project.
- **Blank canvas after "Hide inactive agents"**: when every agent of the view is finished and the filter hides them all, the canvas says "N finished agents hidden" with a "Show" button that turns the filter off. It appears only when each hidden agent is finished (an idle agent hidden too would make the count wrong), so the number is exact.
- **Command palette**: Ctrl+K (Cmd+K on a Mac) opens a search over four groups: *Actions* (play / pause, zoom to fit, full screen, hex grid, mute, the shortcuts dialog, settings), *Panels* (each panel, same names as the top bar), *Sessions* (including "All sessions") and *Agents* (the agents the Sessions panel lists, so finished agents hidden by "Hide inactive agents" are not offered). Type to filter (every word must match), Up / Down to move, Enter to run, Escape to close; focus returns to where it was. It is a modifier combination, so it works even with single-key shortcuts turned off, and from a text field, but not from inside another dialog. Only recorded facts are shown next to a name:
  - a session: runtime, project, branch, "current view", and "finished" only when the session list says it completed (or "imported - not live" / "indexed - not observed", as in the Sessions panel). It is never called active or running: nothing the palette reads proves that;
  - an agent: its role (Main, Subagent, Teammate) and its session, never its state, which may be older than the screen;
  - a shortcut next to a command is shown only while it works (none for single-key shortcuts when they are off).

  Each group shows at most 8 matches, and the status line below the list says how many more there are ("keep typing to narrow") instead of pretending the list is complete. Session and agent names (and their details) carry `data-sensitive`, so presentation mode blurs them like in the other panels. Agents of another session are offered only while the view contains them: select that session (or "All sessions") first.
- **Folder prefix of session tabs**: the folder prefix appears when the sessions you have open come from two or more folders, a tab reads "folder / name" (the Sessions button in the top bar, and the sessions of a team in the Sessions panel) so two sessions called "fix login" can be told apart. The folder is the repository's folder name, proven by the git common dir (worktrees of one repository share it). Limits: a session outside git, or one under "Imported transcripts", gets no prefix, because no folder is proven; with a single folder nothing is added; under a project heading of the Sessions panel the prefix is not repeated, the heading already names the folder; a name that already starts with the folder is left as is. The prefix is display only: it is never written into the name you chose, and the canvas halos keep showing the session name and workspace as before.

The graph legend (bottom left of the canvas) explains the colours, shapes and lines that are on screen.

### The legend lists what is on screen

The legend does not list symbols the canvas does not draw (#244). A row appears only when the scene proves it, and a section with no row has no heading:

- an agent state, shape or runtime logo: at least one drawn agent has it (a hidden, folded or filtered-out agent proves nothing). A teammate ring, its working / idle / done mark and the orchestrator crown follow the same rule; a team row needs a team with two members on screen;
- a tool card line, a discovery card by type, a context part (non-zero for a drawn agent): the card or the part exists;
- a parent line: solid when the events confirm the link, dashed when they do not; a dispatch or return dot, a file conflict line, a "+N" or green badge on a folded branch, a session halo: drawn right now;
- a message link style: a link with at least one message in that state (in flight, recent, error, quiet); a bubble: a message bubble exists.

The sentence under the title says how many symbols are listed ("N symbols on screen") or that nothing is on screen yet. **Show all symbols** (a toggle button, Tab then Enter or Space) lists the complete reference, on screen or not; the choice is not saved. A row whose symbol just left the scene (a message in flight, a particle, a tool card) stays listed for 10 seconds so the list does not jump under you. The guided demo keeps the complete legend, because its steps describe symbols the demo never draws.

### Tour this session

With at least one symbol on screen, a **Tour this session** button sits beside **Legend**. It starts a guided tour of the real scene (it is not shown in the guided demo, which has its own **Guided tour**):

- the steps are built when you start it from the symbols the canvas proves are on screen: your agents (main, sub-agent, runtime), each agent state present, tool calls, finished agents, who started whom, folded branches, file conflicts, teams, sessions, links, context parts and discoveries. A step for something that is not on screen does not exist, and no step talks about a symbol that is absent;
- a step points at a real agent (a ring follows it) or, for a symbol that no single agent shows (a link, a context part), at the matching legend section, which opens without changing your saved preference. The card names the agent it points at;
- the tour never pauses or seeks the scene: it stays live, and events keep arriving. A step is a snapshot: when what it explains has left the scene, the card says "This is no longer on screen" instead of going on as if;
- the card is the one of the guided demo: Previous, Next, **Go to step**, **Exit tour**, the arrow keys and Escape (inside the card only), and the focus returns to the button that opened it.

### See the legend in action

The guided demo tour (`pnpm run dev:demo:guided` or `?scenario=guided`, see [demo.md](demo.md), in French) walks through every section of the legend. Steps per section:

- **States**: steps *Meet your agent*, *Tool calls*, *Results come back*, *Waiting for you*, *When something fails* and *Agent Teams*. The `paused` state is described only, in step *Seen only in a real session*. The `error` state is described only, in step *When something fails*: a failed tool call does not put an agent in error.
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

## What the action cards show

On the canvas, a tool card carries a small shape on its left that says what kind of action it is, so you do not have to read the label: a page (Read), a page with a plus (Write), a magnifier (Grep, Glob), a pencil (Edit, MultiEdit, apply_patch), a notebook (NotebookEdit), a checklist (TodoWrite), a globe (WebSearch, WebFetch), a speech bubble with a question mark (AskUserQuestion), a fork (Task, Agent sub-agent), and for Bash a prompt chevron and cursor, or, when the command line runs one of them (the first one wins): a node on a line (`git`), a rounded square with a node (`gh`), a snake (`python`), a flask (a test runner: `pytest`, `pnpm test`, `node --test`, `cargo test`), stacked containers (`docker`) or a parcel (a package manager: `pnpm install`, `pip install`). The shape comes from the tool name and, for Bash, from the command line only. MCP tools keep the generic card. While the call runs, the magnifier sweeps, the cursor blinks, the git node breathes, the globe turns, the bubble swells while an answer is awaited, a dot travels down the fork, the snake crawls and bubbles rise in the flask; with reduced motion (OS setting or Freeze motion) the glyphs are still. A shape says which command was issued, never that it succeeded.

Some tool calls have their own card content in the popup and the transcript. Every figure comes from the call's own input; when the input does not carry it, nothing is shown.

- **Edit / MultiEdit**: a `+N -M` summary (lines of `new_string` and `old_string`, summed over the blocks for MultiEdit, with the block count). The sign and a spoken equivalent ("2 lines added, 3 lines removed") carry the meaning, not the color. A MultiEdit whose blocks are incomplete shows no summary.
- **Write**: the number of lines of the content written. It does not say whether the file already existed, because the call does not prove it.
- **Read**: the line range requested (`lines 10–59`, or `from line 100` when only an offset was given), from the call's `offset` and `limit`. Nothing is shown when the call states neither.
- **Other runtimes**: tools named differently are drawn like the one they correspond to: Codex `shell` and `exec_command` (Bash), `update_plan` (TodoWrite), `web_search_call` (WebSearch); Copilot `bash`, `powershell`, `view` (Read), `edit` (Edit), `create` (Write), `grep` (Grep), `glob` (Glob), `web_fetch` (WebFetch), `task` (Task). The tool name shown is still the one the runtime reported.
- **apply_patch** (Codex): the patched files with their operation (add, update, delete), `+N -M` counted from the patch text, and the patch lines. The event keeps only the first 500 characters of a patch: when it was cut, the files seen are listed, the card says so, and no count is shown.
- **TodoWrite**: "N of M done" and "N in progress", counted from the list the call carries (a Codex plan counts the same way).
- **WebFetch**: the host of the URL on its own line.
- **Task / Agent**: the sub-agent type and the short description.
- **NotebookEdit**: the notebook, the cell and the edit mode, when the call states them.
- **Bash**: when the command runs `git` or `gh`, a pill names each subcommand as written (`git commit`, `gh pr create`), read from the command line itself. A second row lists Python, test, docker and package-manager calls (`python analyse.py`, `pnpm test`, `docker compose up`, `pnpm install`). A pill says the command was issued, not that it succeeded: the outcome is the tool's state. No exit code or duration is shown, because the events do not carry them.
- **Result pills** (tool popup and Conversation panel): once a call is seen to succeed, a pill shows what its own output proves. For a Bash command line that runs `gh`, a link **PR #N** or **issue #N** (opens in a new tab), when the output has exactly one line that is a plain `https://github.com/<owner>/<repo>/pull|issues/<n>` URL (`gh pr create` and `gh issue create` print it). A sub-path or an anchor (`/files`, `#issuecomment-…`), two different URLs, a failed call, or a URL on the last line of an output cut at the 200-character capture limit give no link. For Grep and Glob, **N files** when the output starts with the tool's own `Found N files` header; lines are never counted, because a cut output proves nothing.

## Themes

The **Theme** selector in **Settings** (the gear button in the top bar) offers nine themes, all dark:

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
| **Thinking** (agent state, Timeline "Thinking..." block) | A thinking block of the agent was observed, and nothing has happened since. A context reading, a prompt, an answer, a resolved permission or the end of a tool call never puts an agent in *Thinking*. |
| **Idle** between two steps (agent state) | After a tool call, a thinking block or a permission prompt ends (and no other call of the agent still runs), the agent shows **Idle** until its next event: what it does in between is not observed, so nothing is claimed. Its turn is not over, though: it stays on the canvas with **Hide inactive agents**, keeps its branch as it is (a branch you closed stays closed), stays the target of **Follow the active agent**, and no subtitle is written for it. Only the end of the turn makes it inactive. |
| **active** time (agent card, Sessions panel) | The sum of the observed thinking blocks and tool calls of the agent. It is a lower bound: the time between two steps (the model reading a tool result, writing an answer) is not observed, so it is not counted. "active time unknown" means nothing was observed. |
| "Not observed yet" (agent card) | The agent was announced but nothing has been seen from it. |
| "end not observed" (tool card) | The tool call started but its end was never seen. It is not shown as success or failure. |
| "last known state: X, silent for N min" | The agent sent no event for more than 5 minutes (the status is already "last known state" after 30 s). It is a silence, not a verdict: a long tool call or a long thought is silent too, so Agent Lens never writes "stuck". Shown in the agent card (inspector) and on the agent row of the Sessions panel, in whole minutes. |
| "waiting for permission for N min" | The last event of the agent was a permission request, and nothing answered it for more than 5 minutes. This is told apart from a plain silence because the agent itself said it was waiting for you. |
| **From history** / "history received" + a time (agent card) | The agent's status was read from a replayed history (the transcript read when the relay or the extension attached a session, or the replay after a reload or a session switch), not seen happening. The time is when this page received that history, not when the agent did anything. From the moment it is received, the status is only a *last known state* everywhere: the canvas node is greyed, the Sessions panel row says "last known state: X", the top-bar count puts it under "last known state", not "active". It is never shown as **Live** and never reported as silent; a screen reader hears "X shows a state read from history", not "no longer reporting". The next live event of the agent makes it live again. |
| **at least X** ("at least") | The total is partial: some part is absent, so the real value is X or more. It is never shown as a complete number. |
| **estimated** ("estimated") | The token count was computed locally, not reported by the runtime. |
| "no checks reported" / "checks unknown" (PR row) | gh listed no check for the PR, or its checks cannot be read. Neither is shown as passing. |
| "not reported" | The value is unavailable. It is not shown as 0. |
| **~$X** ("context cost estimate") | A cost: the tokens now in the context × a blended rate per model. An estimate even on reported tokens, never a bill. See [Cost](#cost-the--figures). |
| **unattributed** | A cost that cannot be tied to exactly one agent (unknown name, or several agents share it). It is listed apart, priced at the default rate, and included in the session total. See [node-inspector.md](node-inspector.md). |
| **conflict** (Files panel, canvas line) | Two or more agents each made at least one edit of the same absolute file that was observed to succeed. An edit not seen to succeed is never counted. |
| **Tokens of a file** (Files panel) | The sum of the cost of the calls that ended on that file, each call counted for its own file. It is qualified like every total: **estimated** when any part is estimated (shown `~12k` on screen), **at least** when a call on the file ended without a figure (shown `≥12k`; `tokens not reported` when no figure at all). A call still running or whose end was not observed adds nothing yet. The summary at the bottom adds the files with the same wording. The bar and the colour of a file are its share of the heaviest file: a heavy file is never drawn as an error. The read and edit counters count the calls started, failures and calls still running included; when fewer were observed to succeed, the row says how many did (`3 reads (2 succeeded)`). |
| **Loading history (n/N)** | A burst of received events (switching to All, a relay replay) is being applied a few milliseconds per frame: n of the N events are on the canvas, the rest are not drawn yet. Screen readers hear the start and "History loaded (N events)" at the end. |
| **Time** and **Activity** (Sessions panel) | For a Claude Code session, Time counts from the start the transcript records (its first timestamp) and Activity from the last write of the transcript or of its sub-agent transcripts. Neither starts when the relay or the extension began watching: a session opened 3 hours ago reads 3 hours even if the relay started 2 minutes ago. |
| **≥2m 00s**, read as "watched for" ... "at least that long" (active) or "at least" ... "long" (completed), then "session start not recorded" (Sessions panel, Time) | The transcript records no start, so the duration only counts since Agent Lens began watching the session: the session is at least that old. |
| **imported - not live** (Sessions panel) | The session was read once from an imported transcript file (`--import`, see [relay-sources.md](relay-sources.md)). It shows what the file recorded up to its last line. It is never shown as active: whether it still runs elsewhere is unknown. Its agents are at best *last known state*, never current, and the inspector says *(imported transcript)* after the last event time. Imported sessions are grouped under **Imported transcripts**, which the project filter also offers. With **Active only** on, an imported session is listed only while selected. |
| **N active / N idle / N error** (top bar) | "active" only counts agents whose status is proven current and neither idle nor error; idle, error and *last known state* agents are counted apart, and done agents last. The screen-reader outline words a stale agent as *last known state: ...*, like the canvas. |
| **status unknown (relay offline)** (Sessions panel) | The relay is offline, so no event can arrive: an active session is no longer shown as *active*, and its duration stops at its last observed activity instead of growing. A halo whose working or waiting agents are all *last known state* says *last known: working* (or *waiting for permission*) rather than the bare status. |
| **Loop observed** / "No loop in the observed part" | The loop verdict (see [Loops and health verdict](#loops-and-health-verdict)). It never says "healthy": at best "No loop observed" over the calls it lists. |
| **COMPACTED** (Conversation row) | The runtime compacted the agent's context at that moment. The trigger and the size before are shown only when the transcript records them; "Cost not reported" always, since no transcript gives the cost of a compaction. See [Context compactions](#context-compactions). |
| **Not provable: ...** / **Chain stops: ...** | The reasoning or the next hop of a failure cannot be proven from the kept history (see [Why this tool?](#why-this-tool-and-the-causal-chain-of-a-failure)). Nothing is guessed. |
| `actual` / `configured` / `requested` (model pill) | Where the model shown comes from, strongest first. `requested != actual` means the runtime used another model. |

A silence is reported only for a status seen live and only for an agent that is not closed (done, failed or interrupted). A status that comes from a replayed history is never reported as silent: its age is not a wall-clock silence. For Claude Code sessions, the relay and the VS Code extension mark the events they read from a transcript history (`replayed`): the catch-up read when a session is attached, the sub-agent and teammate files already there, an imported transcript, and what is re-sent to a reopened panel. The page marks the events it replays itself. The initial history read of the Codex, Copilot, Pi, Gemini and OpenCode watchers is not marked yet ([#390](https://github.com/j0hn-42/agent-lens/issues/390)): their agents can still be shown as live right after the attach. The threshold is `SILENT_AFTER_MS` in `web/lib/canvas-constants.ts`.

A silence never ends a session. However long a session is silent (`pnpm test` running for 7 minutes, a permission left unanswered), its agents keep their last known state and its sub-agents are not closed. A session is marked completed (✓ in the Sessions panel, the **Session finished** notification) only when its end is observed: Claude Code's `SessionEnd` hook. A `Stop` hook only ends a turn: the orchestrator becomes idle, not done. Without the hooks, and for Codex, Copilot, Pi, Gemini and OpenCode, which report no end, a session is never marked completed by a silence: it stays in its last known state (for OpenCode, an archived session is the one exception, and a session silent for 10 minutes is no longer updated until new rows arrive).

## Repeated reads and calls

The **Files** panel opens with a "Repeated reads and calls" section, computed from the tool events already received (nothing is read from disk). It reports facts, not verdicts: a repeat may be intended.

| Row | It means |
| --- | --- |
| **read again N times, no edit seen in between** | The same agent read the same file, with the same offset and limit, N more times, and no Edit, Write or patch on that file (or a patch of unknown path in that session) was seen between the reads. A read of another range, or by another agent, is not a repeat: each agent has its own context. Nor is a read after a context compaction of that agent, or after a read of the file that was seen to fail or be cancelled: the content was not in its context. |
| **same Glob run again N times, no edit seen in between** | The same pattern and path, with no write seen in the session, nor compaction of that agent, between the calls. |
| **same Bash command run again N times, right after itself** | The same command (Codex: `exec_command`) with nothing else called by that agent in between. A command can legitimately change its answer, for example when polling a log. |
| **at least X tokens** / **estimated** | Cost of the repeats only (the first call is not waste). "at least" because some repeat had no reported cost; **tokens not reported** when none had (never shown as 0). |
| **N calls had no input details and were not compared** | A Read, Glob or Bash call arrived without the input needed to compare it. It is counted apart, not guessed. |
| **Tracking limit reached: this list is a lower bound** | More distinct calls than the ledger holds (4000) were seen; later ones are not tracked, so the list may be missing repeats. |
| **N more not shown** | Only the 20 costliest rows are drawn. |

Only Read, Glob and Bash/`exec_command` are compared, because their input summary keeps every argument. Grep and the other tools are never compared: their summary drops options, so two equal summaries would not prove two equal calls. Edits made through Bash (for example `sed -i`) or outside the agent are not seen, so a re-read after one can be listed. Each row is a button that opens the file only when the path is absolute and the host can open files (VS Code); otherwise it is plain text.

## Delegation report

When the selected agent has sub-agents, its inspector ends with a **Delegation report** (#233): one entry per direct sub-agent (a grandchild is in the report of its own parent; Agent Team teammates are not delegations and are not listed), in the order they started. The sub-agent name is a button: Enter or a click opens that sub-agent's own inspector. The list of files read is a disclosure (Enter or Space opens it).

| Column | You see | It means |
| --- | --- | --- |
| **Tokens** | `12k`, **at least X**, **estimated**, **not reported** | The sub-agent's own token counter, qualified as everywhere else. |
| **Files read** | **N files** | Distinct files whose `Read` by this sub-agent was observed to succeed. The disclosure lists them (20 at most, then "+N more"). |
| | **N not confirmed** | Files whose `Read` started but was never seen to succeed (failed, cancelled, still running or end not observed). They are not counted as read. |
| | **none observed** | No `Read` by this sub-agent was received. It is not shown as "0 files": reads through other tools (Bash `cat`, Grep) are not seen. |
| **Duration** | **m:ss (measured)** | Measured by Agent Lens (the relay or the extension) between the dispatch and the return it observed live. It is not a figure the runtime reports with every return. |
| | **m:ss (recorded)** | A background sub-agent whose completion notice records its own duration: that recorded figure, not a measurement by Agent Lens. |
| | **not reported** | A return was received without a duration, or it came from a history replay or an imported transcript: there the duration was measured when the line was parsed, not while the sub-agent ran, so it is dropped. |
| | **no return observed** | No return of this sub-agent was received; no duration is computed from the clock. |
| **Result** | the start of the report | The first 280 characters of what the sub-agent returned to its parent, with "…" and "(full report in Conversation)" when cut. |
| | **Error: ...** | The return was flagged as an error. |
| | **No return observed yet** / **Finished, no return observed** | No return was received, whether or not the sub-agent is known to have finished. |

A sub-agent launched in the background (Claude Code's default, and always with `isolation: "worktree"`) is not finished by its launch: the tool result its parent gets right away only says it started. It stays running until Claude Code's task notification for it says `completed` (a return) or `failed`, `killed`, `stopped` or `cancelled` (an error), with the duration that notification reports. A notification without a status (an agent restarted after Claude Code exited) or with an unknown status finishes nothing.

A sub-agent whose link to its parent is not proven by the events (dashed on the canvas) reads **parent link not verified**. When the hooks see a sub-agent stop without its report, the result is the stop notice they relay (for example "general-purpose complete"), not a report.

## Context window (the "/ 1M" next to the gauge)

The used part of the gauge is a reading. The total is a window that is either **reported** by the runtime or **inferred** by Agent Lens, because Claude Code transcripts do not state it. Where it comes from, strongest first:

1. **Reported by the runtime** (Codex sends `model_context_window`): shown as is, even when the usage is above it.
2. **`CLAUDE_CODE_DISABLE_1M_CONTEXT=1`** (environment or the `env` of Claude Code's `settings.json`): every window is capped to 200k. In the VS Code extension this is read at start; for the relay and `node app/dist/app.js` it is read by `GET /status` (field `disable1MContext`, `false` when Claude Code is not watched), so the browser shows 200k as well.
3. **A `[1m]` suffix** in the model id: 1M.
4. **The model family table** (Opus, Sonnet, Fable, Mythos 1M; Haiku 200k; GPT 400k), 200k for an unknown model and 1M when no model is known yet.

A window cannot be smaller than what was used. When a reading is above the assumed window (a long session on a 1M model whose id was not recognised), the total grows to the next known size (1M), or to the usage itself beyond 1M, instead of showing more than 100%. The percentage then refers to an assumed window; the model pill and the table above say where it comes from.

**"window assumed".** In the interface, "assumed" is kept for a window that is a fallback, not for every inferred one: no model known yet, a model the table does not know (whether or not `CLAUDE_CODE_DISABLE_1M_CONTEXT` is set: the cap is an upper bound, not the size, and says nothing about a model the table does not list), or a window a reading has already overflowed. The qualifier goes with the window, never with the token count, which is a reading: **12k / 200k tokens, window assumed** on the canvas label and in the screen-reader summary of the node, **190k / 200k (95% of an assumed window)** in the inspector's **Context window** gauge. The percentage drawn above the node then says "assumed" too, and neither it nor the ring around the node is ever coloured or haloed as a warning or critical: how full a window of unknown size is cannot be proven. A window reported by the runtime, or inferred from a `[1m]` suffix or a family the table lists (capped or not), is shown without the word: the table is the documented source for those models, and marking it would put "assumed" on every Claude Code session.

## Cost (the "~$" figures)

Every cost in Agent Lens is a **context cost estimate**, never a bill: the tokens an agent holds in its context now, priced at a blended rate for its model (75% of the input price plus 25% of the output price per million tokens; the Sonnet-class rate for an unknown model). Transcripts do not give what each call was charged, so this is the only figure that can be computed, and it is marked as such:

- **On screen** a cost reads **~$2.10**: in the top bar, the cost pills and the Cost panel, the session halos, the Sessions list and the All summary. The "~" stays even when the runtime reports its tokens (Codex): the tokens are a reading, the price is not. The qualifiers of the tokens are kept around it (**at least ~$2.10**, **~$2.10 estimated**). The tooltip of the top bar cost gives the method.
- **For screen readers** the same figure is said in words, "context cost estimate $2.10", in the node summaries, the halo announcements and the top bar. The cost notification says "Context cost estimate reached ~$5.20".
- **What it misses.** It is the size of the context now, not a sum of the calls: it drops after a compaction (from ~$2.10 to ~$0.40 after `/compact`), it ignores cache reads (cheaper than input) and cache writes, and it does not add up the earlier calls that each re-sent the context. Read it as "what the current context weighs", not as what the session has cost.

The token total next to it, **N tokens in context**, adds up what each agent's context holds now. It is not a consumption either, and it drops after a compaction too.

## Context compactions

When the runtime compacts an agent's context (it replaces the conversation with a summary), the Conversation panel shows a **COMPACTED** row at that moment, in the agent's tab and in *All*. It is listed even when *Tool calls* is off, the search finds it, and it is a button like the other rows (Tab to it, Enter selects the agent).

- **Source.** Claude Code writes a `compact_boundary` system record in the transcript (`compactMetadata.trigger` and `compactMetadata.preTokens`); Codex writes a `compacted` record; Pi writes a `compaction` entry (`tokensBefore`). Nothing else is read as a compaction.
- **Trigger.** *automatic* or *manual, /compact*, only when Claude Code records `auto` or `manual`; otherwise *trigger not reported* (always the case for Codex and Pi).
- **Size before.** The context size before the compaction, *reported by the runtime* (`preTokens`, a positive whole number); otherwise *Size before not reported*. It is never estimated.
- **Cost not reported.** The summary call that performs the compaction has no usage in the transcript, so no cost is ever shown for it.
- **The gauge after it.** The local estimate restarts from the system prompt plus the compaction summary, then grows again. For Codex, the last total reported before the compaction is dropped (it measured the old context); the gauge shows the estimate until Codex reports a new total.
- **Limits.** A compaction written before Agent Lens attached to the session resets the estimate but is not listed. A boundary seen twice (same `uuid`) is listed once. A subagent's compaction is listed for that subagent and does not touch the session estimate. There is no before/after diff yet: the size after is only an estimate.

## Pi sessions

Pi coding agent sessions (#238) are read from their session files (`~/.pi/agent/sessions/--<path>--/<timestamp>_<id>.jsonl`, format of pi's `docs/session-format.md`, versions 1 to 3). What is shown, and what is not:

- **Shown.** The prompts, the assistant text and readable thinking, each tool call paired with its result by `toolCallId` (failed when the result says `isError`), compactions with their *Size before* (`tokensBefore`), and the session name given with `/name` as the session label.
- **Model.** The model named by each assistant message: the model that answered. A `model_change` entry is a selection (possibly a virtual model) and is not shown on its own.
- **Not shown.** Tokens and cost (the file records them, they are not read yet, so the gauge stays on the local estimate), system prompt updates, direct shell runs (`!command`), extension entries.
- **No sub-agents.** Pi documents none: every event belongs to the main agent and no child is ever drawn.
- **Unknown format.** A session whose header announces a version other than 1 to 3 is neither listed nor read, and the extension log says so once. A session whose id holds a dot (possible with `--session-id`), whose header has no absolute `cwd`, or whose file is a symbolic link is not listed either.
- **Branches.** Pi keeps abandoned branches (`/tree`) in the same file; they are shown in the order they were written, without the tree.

## Gemini CLI sessions

Gemini CLI sessions (#238) are read from their chat files (`<home>/.gemini/tmp/<project>/chats/session-<timestamp>-<id>.jsonl`, `<home>` being `GEMINI_CLI_HOME` when set). The format is the one written by `chatRecordingService.ts` of `google-gemini/gemini-cli`; it carries no version field, so records are read by shape and an unknown one is ignored. What is shown, and what is not:

- **Which sessions.** The directory name under `tmp/` is a short id from Gemini CLI's own project registry (it was the project hash in older versions), so it is never read. Every `chats/*.jsonl` is swept and the first record decides: its `projectHash` is the sha256 of the project root, compared with the sha256 of your workspace. A session started from a sub-directory of the workspace has another root, hence another hash, and is not listed. The record has no working directory: a session shows a folder only when the workspace hash matched, never otherwise.
- **Shown.** The prompts (a line starting with `/` or `?`, or empty, is not a prompt), the replies, the thoughts (subject and description), each tool call paired with its end, and the summary Gemini CLI saves as the session label.
- **Tool calls.** A call starts when it first appears in the file and ends when its `status` reads `success`, `error` or `cancelled`; the last two are drawn as failed. A call still `executing` has no end yet.
- **Model.** The model written on each reply, once per change. Nothing else is taken for a model.
- **Not shown.** Tokens and cost (the file records them, they are not read yet, so the gauge stays on the local estimate), info, error and warning messages.
- **No sub-agents.** Gemini CLI keeps a sub-agent in its own file under the parent session's folder; those files are not read and no parent link is guessed, so every event belongs to the main agent.
- **Rewinds and edits.** Gemini CLI rewrites a message in the file each time it changes, and can drop messages (`/rewind`) or edit them afterwards. A message is shown once. What was shown before a rewind stays shown: it did happen, and the file cannot say more. Edits to a message after the fact are not shown.
- **Not listed.** A file whose first record is not a metadata record, whose session id holds a dot, or which is a symbolic link; the old single-file `.json` sessions.

## OpenCode sessions

OpenCode sessions (#346) are read from OpenCode's own SQLite database (`<data>/opencode.db` for the latest, beta and prod channels (`opencode-<channel>.db` for any other channel), `<data>` being `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`; `OPENCODE_DB` overrides it: an absolute path is used as is, a relative one is resolved under `<data>`), opened read-only and polled; there is no hook. They carry the badge `OC` (accessible name "OpenCode") and the square brackets mark. What is shown, and what is not:

- **Which sessions.** Only sessions with rows written in the last 10 minutes (`ACTIVE_SESSION_AGE_S`) are followed, and at most 25 root sessions, the most recently updated first. History older than that window is not replayed when a session is attached. A session silent for more than 10 minutes is released, and followed again if new rows arrive. An archived session (`time_archived` set in the database) is released too.
- **Shown.** The prompts, the replies, the reasoning, and each tool call paired with its end.
- **No pending permission.** The database does not record a permission request waiting for an answer, so none is shown.
- **No end of session.** OpenCode reports no end, and a silence never completes a session: a session released after 10 minutes without rows is never shown as finished. Once released it is no longer updated; it keeps its last known state until new rows reattach it. Only an archived session is reported as ended.
- **No streaming text.** A reply appears once it is written to the database; the text still being streamed is not visible.
- **Platforms.** Linux (macOS not verified). On Windows the location is not resolved yet: set `OPENCODE_DB` to an absolute path.

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

With operator control on ([operator-control.md](operator-control.md)), a permission request Claude Code is waiting on appears at the top right of the canvas with the tool, the session, the whole input and its deadline, and three buttons: **Approve**, **Deny** and **Redirect**. **Redirect** opens a dialog for a text Claude receives with the refusal, so it can change course; the text is required, and it is never kept on screen nor written to the journal (only its length is).

| You see | It means |
| --- | --- |
| "Sending the decision…" | Your click left the page; the extension has not answered yet. |
| "Decision sent: approve" (or deny, or redirect) | The extension handed your decision to Claude Code. **Sent is not applied**: whether the tool ran (or the refusal reached Claude) only shows later in the transcript. |
| "Deny applied" / "Redirect applied" | After your deny or redirect was sent, the session showed live the end of **that very call** (same session, same tool call id), in error, not interrupted, and its result contains the refusal: the deny text, or the beginning of your redirect text. That is the observed refusal. A failure reported by the hook (`[FAILED]`), another error text, an approval, a call that is "not identified" and a decision sent from another panel are never shown applied. |
| "Decision sent from another panel" | A decision for this request was handed to Claude Code, not from this page. |
| The request disappears, with an announcement | It ended without a decision: the deadline passed, Claude Code stopped waiting (answered in the terminal, call interrupted), control was turned off or the panel could no longer decide. Claude Code then shows its usual prompt. |
| "Input truncated" | Only the first 64 KiB of the input are shown; the SHA-256 given is the one of the whole input. |
| `\u202e` and other escapes in the input | An invisible character of the real input, shown as its escape instead of being applied to the text. |

## Presentation mode

For demos and streaming. Start it with `V` (or Settings > Presentation); stop it with `V`, `Esc` or the "Presentation mode - V to stop" button under the top bar. It is announced ("Presentation mode on/off") and never starts by itself: only the three options below are remembered in this browser (`agent-lens:presentation`), the mode is not. Each option can be turned off in Settings > Presentation.

- **Subtitles of transitions**: a caption at the bottom of the canvas for each state change of an agent, for example "Main agent: Thinking -> Calling tool Read". Only proof counts: a subtitle is written when this page saw the change happen live. An agent idle between two steps of its turn gets no subtitle: the next observed step is reported from the last one ("Calling tool Read -> Calling tool Edit"). Nothing is said about the state that was already there when the mode started, and nothing about replayed history, imported transcripts or an agent never heard from live. A caption stays 7 seconds; when several changes arrive together, the most recent one is shown. It is for the audience: it is not a live region, so a screen reader is not interrupted.
- **Mask sensitive data** (on by default): free text is hidden, never replaced by a plausible value.
  - On the canvas, tool-call arguments and results, message bubbles, discovery cards, link messages, particle labels, agent names, session and team names (halo labels, the cost panel) are drawn as bullets of the same length. Counts, costs, states, tool names and context gauges stay, because they come from the events and carry no prompt or path.
  - In the panels, Conversation, Files, Context, Timeline, the link panel, the tool and discovery popups, the Sessions list, the selected-session label in the top bar, the agent name in its card and the canvas hover tooltip are blurred and cannot be selected.
  - Subtitles name an agent by its role ("Main agent", "Sub-agent", "Teammate") instead of its name or prompt.
  - Not covered: the text read by screen readers (the graph outline, announcements), the browser tab title, notifications, and anything you copy from a panel before starting the mode. Masking is a screen filter for the audience, not a privacy boundary; check a scene before you share it.
- **Follow the active agent**: the camera centres on the agent that worked last (thinking, calling a tool, waiting for a permission or idle between two steps of its turn, seen live), keeping your zoom. With no such agent it stays where it is. Panning or zooming yourself pauses the follow until another agent takes over; the automatic fit is off while the option is on.

## Notifications

The **Notifications** button in the top bar turns notifications on or off; **Settings > Notifications** chooses what triggers them. Nothing is asked of the browser until you turn them on, and the choice stays in this browser (local storage).

| Trigger | Fires when | Default |
|---|---|---|
| **Agent waiting for a permission** | an agent starts waiting for you to allow a tool | on |
| **Agent in error** | an agent itself is reported in error (no event observed by Agent Lens sets this state yet, so it cannot fire today; a failed tool call does not count: the agent usually handles it and goes on; it shows in the tool error count of the inspector) | on |
| **Session finished** | a session you were watching goes from active to completed: its end was observed (Claude Code's `SessionEnd` hook), a silence never fires it | off |
| **Cost threshold reached** | the context cost estimate shown in the top bar crosses the amount you set (USD, above 0, up to 10 000), once | off |

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

## Canvas controls (bottom right)

- **Zoom**: three icon buttons, **Zoom in**, **Zoom out** and **Fit to view**. Their tooltips give the graph keys (`+`, `-`, `0`, see the shortcuts dialog).
- **View**: one button that opens a small panel (Enter or Space opens it, Tab moves into it, Escape or a click outside closes it and Escape returns the focus to the button). The panel holds:
  - **Freeze motion**: stops the ambient animation. Locked on, with a tooltip saying why, when your system asks for reduced motion.
  - the per-layer motion toggles (see below);
  - **Pin cards**: never auto-hides bubbles, tool cards and discoveries;
  - **Hide unanswered calls after**: how long a running tool call with no observed end is waited for before it is treated as expired (1 to 30 min, default 5 min). Expired is neither a success nor a failure.
- These settings were called *Fit*, *Pause animations*, *Keep cards visible* and *Expire unanswered calls after* before. Their behaviour is unchanged. Every label, accessible name and tooltip of these controls comes from the message catalog, in English and in French (*Tout afficher*, *Figer les animations*, *Garder les cartes affichées*, *Masquer les appels sans réponse après*, *Affichage*, *Zoom avant*, *Zoom arrière*), and the block carries `lang`.

## Motion by layer

Besides the global **Freeze motion** setting (and your system's reduced-motion setting), the **View** panel of the canvas controls holds one toggle per layer. A pressed "Calm ..." toggle turns off the ambient motion of that layer only; the state it shows (colours, rings, labels) stays.

| Layer | Calms |
| --- | --- |
| Animated background | depth particles, grid pulse |
| Links | edge pulses, dashed flow, team halos |
| Agents | breathing, scanline, rings, tool-call pulses |
| Effects | message particles and trails, spawn / completion flashes, bloom |

With all four pressed the canvas behaves as under reduced motion. When your system asks for reduced motion, or Freeze motion is on, every toggle is pressed and locked. The choice is kept in your browser. The labels of these controls come from a message catalog (`web/lib/messages.ts`) with French first; the language follows the stored choice, then the browser language, then English.

## Language

Settings > Appearance > **Language** (a native select, so it works with the keyboard and screen readers) offers *Automatic (browser language)*, *Français* and *English*. The choice applies at once, is kept in this browser only (local storage, never sent to the relay) and "Automatic" forgets it. Each language is written in its own language, and `lang` is set on the translated blocks so a screen reader pronounces them correctly.

The interface is translated step by step, so for now the language covers only:

- the canvas controls (the Zoom group, the View button and its panel: Freeze motion, the per-layer toggles, Pin cards, Hide unanswered calls after);
- the Settings dialog (appearance, sound, sessions, notifications, keyboard).

Everything else (top bar, panels, command palette, legend, tour, notifications sent to the system, the text of tool calls and conversations) stays in English, and the page `lang` stays `en`. Translation never changes what is displayed: a figure keeps its qualification ("at least", "estimated" become "au moins", "estimé") and an unavailable channel is still said to be unavailable.

To add a string, add its key to **every** locale in `web/lib/messages.ts`; `scripts/messages.test.ts` fails on a missing key, a different `{placeholder}` or a French text that is still the English one. To add a language, extend `LOCALES` and fill the table.

## The `observations` action

Claude can read what Agent Lens observes through the typed action `observations` (`GET /observations` on the loopback relay). The output is whitelisted field by field and reports its own limits (`truncated`, `agentsTruncated`, `omittedSessions`). See [state-share.md](state-share.md).

## More

- [node-inspector.md](node-inspector.md): model, cost attribution, issue and PR links.
- [relay-sources.md](relay-sources.md): how hooks and JSONL transcripts are reconciled, and the local server.
- [state-share.md](state-share.md): validated snapshots and observations.
- [session-export.md](session-export.md): the standalone HTML replay of a session.
