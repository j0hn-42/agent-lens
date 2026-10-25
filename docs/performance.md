# Canvas performance

Why the canvas stays quiet when nothing moves, what it skips, and how to measure it (#216).

## What the canvas does

- **Idle drawing.** The draw loop keeps requesting animation frames, but a frame is drawn only when it can look different from the last one.
  - Every frame the loop computes a cheap fingerprint of the scene (agent and tool card positions, states, opacity, counts, camera, canvas size, selection, hover, focus, toggles, React re-renders). A new fingerprint draws at once.
  - A **calm** scene (no thinking / tool-calling / waiting agent, no running tool, no particle, no effect) is redrawn at most **10 times a second**.
  - Under **reduced motion** (OS preference or the "Freeze motion" toggle) the scene is redrawn on change, and otherwise every **250 ms** so clocks and expiries stay true.
  - Any pointer, wheel, key or focus event brings the loop back to full rate for one second, so hover and clicks answer immediately.
  - A scene with an active agent keeps its full frame rate: its pulses and comets are real animation, not a state to freeze.
  - A Grep that completes with file cards keeps the full frame rate for **3 seconds** of session time (`SEARCH_FLOW.chipWindowS`, #384), while its chips travel to the cards; then its lines are static and no longer hold the rate, even if Pin cards keeps the cards. The **links** layer calmed or reduced motion: no chip, no full rate.
- **Viewport culling.** The agent, tool card, edge and particle passes skip what lies outside the visible area plus a margin (96 screen px, and a per-element extent for labels, glows and trails). Zoomed on one cluster of a large fleet, the other clusters cost nothing.
- Nothing is drawn from an invented state: a skipped frame leaves the last drawn frame on screen, and the fingerprint covers what moves.

- **Idle simulation (#660).** The simulation loop (`use-agent-simulation.ts`) also skips the frames with nothing to do: no event received, queued or due, no particle, no agent, edge, card or discovery fading or moving, no bubble or tool call reaching its expiry, layout at rest. Such a frame only advances the clock; anything received or due makes the next frame run in full, so an event is never delayed.
  - The age of an agent (detail card, stats box) is read from the clock where it is shown, to the second, instead of being written into every agent at every frame: an agent at rest keeps its identity, and so do the particle and discovery arrays when nothing moves.

## Measuring with ?perf

Add `?perf` (or `?stress=<level>`, which implies it) to the URL: a panel in the top left of the canvas shows, for the frames actually drawn, the rate (`FPS drawn`), the frame time (work time of the JavaScript side of the frame, plus P95), the number of paint calls (`fill`, `stroke`, `fillText`, `strokeText`, `drawImage`, rects) and the number of frames skipped by the idle gate. The same numbers are published in `window.__agentLensPerf`.

`?perf=full` is the **baseline**: every frame is drawn in full, with no idle gate and no culling. Compare the two URLs on the same scene.

Two scripts reproduce the tables below (they print, they assert nothing, and they are not part of CI):

```bash
# In the browser (headless Chromium, demo app started for you): rest and zoomed, baseline vs optimised
unshare -rn sh -c 'ip link set lo up; pnpm --dir web exec node --import tsx tests-a11y/e2e/perf-measure.ts'

# Draw passes only: 300 agents in 10 clusters, zoomed on 1 cluster, with and without culling
pnpm --dir web exec node --import tsx --import ./tests-a11y/setup.ts tests-a11y/e2e/perf-draw-passes.ts
```

## Results

Measured on a Linux/WSL2 development machine, headless Chromium 1280x800 (software rendering, so the GPU side is not measured: the draw-call counts are the reliable signal, the milliseconds are indicative).

### At rest, in the browser (`perf-measure.ts`)

Demo with `?stress=extreme`, reduced motion on, playback paused, 13 agents on screen. "Baseline" is `?perf=full`.

| loop | scene | frames drawn/s | frames skipped/s | mean frame (ms) | P95 (ms) | paint calls / frame |
|---|---|---|---|---|---|---|
| baseline | at rest, overview | 61.2 | 0.0 | 3.2 | 3.7 | 441 |
| baseline | at rest, zoomed | 51.8 | 0.0 | 2.7 | 3.2 | 345 |
| optimised | at rest, overview | 4.4 | 58.0 | 3.2 | 3.6 | 441 |
| optimised | at rest, zoomed | 4.0 | 56.8 | 2.5 | 2.6 | 66 |

At rest the canvas goes from about 60 to about 4 drawn frames per second: roughly 15 times less drawing work for a panel left open. A drawn frame costs the same as before; what changed is how many are drawn.

### Zoomed on 1 cluster out of 10, 300 agents (`perf-draw-passes.ts`)

Real draw passes (agents, tool cards, edges, particles) on a recording context, 30 agents per cluster, 1 tool card per agent.

| scene | culling | paint calls / frame | JS of the passes (ms) |
|---|---|---|---|
| overview (zoom 0.12) | off | 7520 | 2.73 |
| overview (zoom 0.12) | on | 7520 | 2.31 |
| zoomed on 1 cluster (zoom 0.9) | off | 9430 | 3.21 |
| zoomed on 1 cluster (zoom 0.9) | on | 943 | 0.41 |

Zoomed in, culling removes 90% of the paint calls (each of them, in a real browser, may carry a `shadowBlur` or a gradient). In the overview everything is visible, so nothing is skipped and nothing is lost.

### Simulation loop at rest (`perf-sim-loop.ts`)

The `?perf` panel times the draw loop only; the simulation loop is measured by a script that runs one live frame of `useAgentSimulation` (event batch, `computeNextFrame`, layout step, or the idle gate) on a settled scene: agents faded in and laid out, spawned at fractional times like real sessions, no particle, no bubble, no tool card. 510 frames (8.5 s at 60 fps), mean of 3 runs, Node on the same machine.

```bash
pnpm --dir web exec node --import tsx tests-a11y/e2e/perf-sim-loop.ts             # with the idle gate
pnpm --dir web exec node --import tsx tests-a11y/e2e/perf-sim-loop.ts --no-gate   # every frame computed
```

| loop | agents | frames computed | frames that copy the agents Map | JS per frame (µs) |
|---|---|---|---|---|
| before #660 | 200 | 510 | 510 | 47 |
| before #660 | 10 | 510 | 510 | 7 |
| #660, no gate | 200 | 510 | 0 | 28 |
| #660, idle gate | 200 | 0 | 0 | 9 |
| #660, idle gate | 10 | 0 | 0 | 1.6 |

Before, the age written at every frame copied every live agent (about 12,000 objects a second with 200 agents) and handed the draw loop a new agents Map each time, so its caches keyed on it never hit. Now the Map is kept at rest and the frame does not run at all.

Scope of the gain: it holds for a scene drawn as is. With "Hide inactive" on or a collapsed branch, the scene builder (`sceneAgents`) hands the draw loop a new agents Map each frame, so `repeatCacheRef` (keyed on that Map) still misses and re-derives the repeat marks at every frame. Only `edgeLookupCacheRef` (keyed on the particles and edges, which the scene builder does not copy) keeps hitting. The figures above were measured without either option.

### A hovered node under load, Chrome trace (`perf-chrome-profile.ts`, #661)

A real Chromium trace (CDP `Tracing`, `devtools.timeline` and `disabled-by-default-devtools.timeline` categories) of 150 active agents while the pointer stays on a node and its tooltip is shown, 5 s per scene, before and after #679 (shadow sprite, cached scanline gradient, bubble buttons written on change, tooltip size from a `ResizeObserver`). A forced style recalculation or layout is one that runs inside a JavaScript task (the "Forced reflow" of the DevTools Performance panel). Headless Chromium draws the 2D canvas in software: its raster is the main thread's `Commit`, where the recorded draw calls are played back.

```bash
# Two builds already served (next start), profiled in alternation; PROFILE_OUT keeps the traces and screenshots
PROFILE_TARGETS=before=http://127.0.0.1:3100,after=http://127.0.0.1:3300 PROFILE_RUNS=5 \
  pnpm --dir web exec node --import tsx tests-a11y/e2e/perf-chrome-profile.ts
```

Medians of 5 runs, viewport 1280x800, "before" is the parent of the #679 merge (`b01b5aa8`), "after" is `develop` at `e5667d38`:

| scene | build | DPR | forced style recalc / frame | forced Layout / frame | canvas raster (Commit ms / frame) | rAF callback (ms) |
|---|---|---|---|---|---|---|
| overview | before | 1 | 0.47 | 0.00 | 3.62 | 11.32 |
| overview | after | 1 | 0.02 | 0.00 | 3.49 | 11.23 |
| overview | before | 2 | 0.48 | 0.00 | 10.40 | 15.21 |
| overview | after | 2 | 0.11 | 0.00 | 10.52 | 15.05 |
| zoomed | before | 1 | 0.46 | 0.00 | 7.01 | 8.79 |
| zoomed | after | 1 | 0.02 | 0.00 | 6.81 | 8.46 |
| zoomed | before | 2 | 0.46 | 0.00 | 15.84 | 15.50 |
| zoomed | after | 2 | 0.04 | 0.00 | 15.63 | 15.58 |

The forced style recalculation read by the tooltip (`offsetWidth` after the style writes of the frame, about one frame in two while hovering, 1,839 events over 4,478 frames) is gone; what remains comes from the `?perf` panel's own `ctx.font`, the pointer handler's `getBoundingClientRect` and the control bar height. The canvas raster and the frame times are equal within 4%: in software rendering the depth shadow was not the main raster cost, so this trace shows no raster gain, and no regression. The main thread is busy about 990 ms per second in every row (software canvas, 150 animated agents), so the frame rate is bound by the machine, not by these changes.

## Memory of the event buffers (#659)

The page keeps the events it received so it can rebuild a session when you switch to it, and the **All** view in arrival order: one buffer per session (at most 50 sessions, 5000 events each, like the relay) and one All buffer (50,000 events). Counts alone did not bound memory, so both are also capped in **estimated bytes** (the length of each event's JSON, computed once per event; the two buffers share the same event objects):

- the session buffers together: **64 MiB**. Past it, the least recently written sessions are freed first (never the selected one, nor the one being written), as with the 50-session cap; if those two alone still pass it, they lose their oldest events, lifecycle events last. Their count is kept: positions stay absolute and an export says how many earlier events were dropped ([Session export](session-export.md));
- the All buffer: **32 MiB**, trimmed from the oldest in one batch past 10% over the cap, like its count cap. Every dropped event is added to its base counter.

The simulation of the selected session keeps its own log (5000 events at most, `MAX_EVENT_LOG`); it is not one of these buffers.

### In a real browser (`heap-measure.ts`)

```bash
unshare -rn sh -c 'ip link set lo up; pnpm --dir web exec node --import tsx tests-a11y/e2e/heap-measure.ts'
HEAP_PROFILE=worst ...                       # every text field at the normalizer cap (4096)
HEAP_SNAPSHOT=/some/dir ...                  # also writes a .heapsnapshot per step there
```

Headless Chromium, demo app in a frame fed by its parent like a VS Code webview. 50 sessions of 5200 events each (260,000 events, past every count cap), posted with `postMessage` so no string is shared between two events. The JS heap of the page is read after a forced GC: before the feed, with the buffers full, and after a `reset` (which empties them). Profile **real**: the caps of the extension's parser (`ARGS_MAX` 80, `RESULT_MAX` 200, `MESSAGE_MAX` 2000, `EDIT_CONTENT_MAX` 500), 1239 JSON characters per event on average. Profile **worst**: every text field at 4096, 6965 characters per event.

| buffers | profile | JS heap before (MiB) | buffers full (MiB) | after reset (MiB) |
|---|---|---|---|---|
| counts only (before) | real | 15.3 | 340.4 | 25.8 |
| counts only (before) | worst | 15.3 | 1729.5 | 63.5 |
| with the byte caps | real | 15.3 | 91.9 | 27.9 |
| with the byte caps | worst | 15.3 | 108.9 | 64.9 |

With counts only, the 250,000 buffered events held 315 MiB for the real profile (1.3 KiB per event, close to its JSON length) and 1.7 GiB for the worst. With the byte caps the heap stays between 92 and 109 MiB whatever the payloads. What stays after the reset is mostly the selected session's simulation (its event log and Timeline blocks), read in a heap snapshot of the worst profile (5 sessions).

Cost of buffering, `scripts/bench/session-buffers.mts` (`node --import tsx scripts/bench/session-buffers.mts`; `appendSessionEvent` alone, 260,000 events over 50 sessions, median of 7 rounds, Node 24 on a 13th Gen Intel Core i7-13700K, the All buffer not included; new event objects each round because the JSON length is computed once per object): 7.2 µs per event for the real profile and 15.2 µs for the worst one, with the 64 MiB cap in force (it frees whole sessions as the feed goes past it); 2.3 µs per event for the real profile when only the count caps apply. The figures are for that machine; run the script to get yours.

### What a freed session shows (#613)

The 64 MiB cap frees whole sessions, the least recently written first, well before the 50-session cap does: with the real profile (about 1.2 KiB per event) about 54,000 events fit across all the session buffers, that is about 10 full sessions (2 in the worst profile), against 250,000 events before the byte cap. A background session is therefore freed much more often than with the counts alone. What the page then does:

- coming back to a session whose view was cached, when the buffer freed or trimmed events past the cached count, the view does not resume from the cache (it would skip the events in between without saying so): it restarts and replays what the buffer still holds;
- a freed session that receives new events starts a new buffer at its old total, without its earlier events, lifecycle ones included (`agent_spawn`, `team_info`). Opened without a cached view, it replays tool calls of an agent whose creation it never saw: the canvas does not draw those calls (the agent does not exist there) and, today, nothing on screen says so. A [session export](session-export.md) of a session that was freed and has not been written since holds no event.
