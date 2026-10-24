## Graph legend and guided tour

The graph legend (bottom left of the canvas) explains the colours, shapes and lines that are on screen.

### The legend lists what is on screen

The legend does not list symbols the canvas does not draw (#244). A row appears only when the scene proves it, and a section with no row has no heading:

- an agent state, shape or runtime logo: at least one drawn agent has it (a hidden, folded or filtered-out agent proves nothing). A teammate ring, its working / idle / done mark and the orchestrator crown follow the same rule; a team row needs a team with two members on screen;
- a tool card line, a discovery card by type, a context part (non-zero for a drawn agent): the card or the part exists;
- a parent line: solid when the events confirm the link, dashed when they do not; a dispatch or return dot, a file conflict line, a "+N" or green badge on a folded branch, a session halo: drawn right now;
- a message link style: a link with at least one message in that state (in flight, recent, error, quiet); a bubble: a message bubble exists.
- a loop or repeat badge (*Loops and repeats*, #377): the badge is drawn on at least one agent of the scene.

The sentence under the title says how many symbols are listed ("N symbols on screen") or that nothing is on screen yet. **Show all symbols** (a toggle button, Tab then Enter or Space) lists the complete reference, on screen or not; the choice is not saved. A row whose symbol just left the scene (a message in flight, a particle, a tool card) stays listed for 10 seconds so the list does not jump under you. The guided demo keeps the complete legend, because its steps describe symbols the demo never draws.

### Tour this session

With at least one symbol on screen, a **Tour this session** button sits beside **Legend**. It starts a guided tour of the real scene (it is not shown in the guided demo, which has its own **Guided tour**). The command palette lists it too, under the same name.

On the first launch in a browser, a card "New to Agent Lens?" offers this tour above the control bar, as soon as the button above exists (not in the guided demo, full screen, presentation mode or under 600 px wide, where it would cover the canvas controls: these hide it without using it up). It is offered once: the browser remembers it (local storage, `agent-lens:tour-offered`) from the moment it shows, and when that storage cannot be read (a private window, blocked site data) it is not offered at all rather than on every visit. It never takes the keyboard focus; its text is read once by screen readers (polite). **Start the tour** starts it; **Not now**, or Escape inside the card, closes it and puts the focus on the tour button of the legend; starting a tour from anywhere closes it too.

- the steps are built when you start it from the symbols the canvas proves are on screen: your agents (main, sub-agent, runtime), each agent state present, tool calls, finished agents, who started whom, folded branches, file conflicts, teams, sessions, links, context parts and discoveries. A step for something that is not on screen does not exist, and no step talks about a symbol that is absent;
- a step points at a real agent (a ring follows it) or, for a symbol that no single agent shows (a link, a context part), at the matching legend section, which opens without changing your saved preference. The card names the agent it points at;
- the tour never pauses or seeks the scene: it stays live, and events keep arriving. A step is a snapshot: when what it explains has left the scene, the card says "This is no longer on screen" instead of going on as if;
- the card is the one of the guided demo: Previous, Next, **Go to step**, **Exit tour**, the arrow keys and Escape (inside the card only), and the focus returns to the button that opened it.

### See the legend in action

The guided demo tour (`pnpm run dev:demo:guided` or `?scenario=guided`, see [demo.md](../demo.md), in French) walks through every section of the legend. Steps per section:

- **States**: steps *Meet your agent*, *Tool calls*, *Results come back*, *Waiting for you*, *When something fails* and *Agent Teams*. The `paused` state is described only, in step *Seen only in a real session*. The `error` state is described only, in step *When something fails*: a failed tool call does not put an agent in error.
- **Shapes**: steps *Meet your agent*, *Tool calls*, *Sub-agents* and *Results come back*. The discovery card shape is described only (*Seen only in a real session*).
- **Edges and particles**: steps *Tool calls*, *Sub-agents* and *Results come back*. The dispatch and return particles are described only, in *Sub-agents* and *Results come back*: the tour pauses the scene at each step, and a paused scene draws no particle. The unverified parent link, the file conflict line and the two folded-branch badges are described only (*Seen only in a real session*).
- **Teams**: step *Agent Teams* (and *Delivered messages and finished teammates* for a finished teammate, *Results come back* for an archived agent). The session halo is described only (*Seen only in a real session*).
- **Message links**: steps *Messages between agents*, *Delivered messages and finished teammates* and *Quiet links*. The error link is described only (*Seen only in a real session*).
- **Context window**: step *Context window*.
- **Discoveries**: none of these entries is shown in the demo; they are all described only (*Seen only in a real session*).
- **Runtime**: steps *Meet your agent* (Claude) and *Two runtimes* (Codex).
- **Loops and repeats**: both badges are described only (*Seen only in a real session*): the demo has no loop and no repeated call.

### In your language

- the legend (its toggle, the "n symbols on screen" line, every entry and the footer line). It lists exactly the same entries as before, only the language of the text changes; the words the canvas itself draws (*Team*, *Workflow*, *LEAD*, *MAIN*) are quoted as drawn, and the state words the canvas draws under an agent stay English there. In French the state entries of the legend therefore quote the word the canvas draws (`done`, `waiting`, `tool call`) in an element declaring `lang="en"`, then give its French gloss (*done : terminé*), so that the word read on the canvas can be matched with an entry (WCAG 1.4.1, 1.3.3). The key cap of the zoom-to-fit shortcut reads *Maj+F* in French. Names of sessions and agents, branches and projects are data and stay as they came.
- the guided tour (#557): the legend button (*Visite guidée* in the demo, *Visiter cette session* in a real session) and its command in the palette, the offer made on the first launch (*Nouveau sur Agent Lens ?*, *Commencer la visite*, *Pas maintenant*), the card (*Étape n sur N*, *Précédent*, *Suivant*, *Aller à l’étape*, *Quitter la visite*, the notice that a step is no longer on screen) and every step, of the demo and of a real session. The steps say what they said in English: same order, same symbols, same figures (the loop badge still counts the same call 3 times in a row), and the same cautions (a state that only appears when the agent really asked, a symbol the demo cannot draw). The words the canvas draws (*LEAD*, *MAIN*) and the names of tools (*Grep*, *Glob*) are quoted as they are; the label of the highlighted agent, taken from its prompt, is data. A real-session tour keeps the symbols it was built from, not its words: changing the language while it runs rewrites it in the new language. The ring drawn around the explained element has no text.
