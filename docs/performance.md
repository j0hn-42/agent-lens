# Canvas performance

Why the canvas stays quiet when nothing moves, what it skips, and how to measure it (#216).

## What the canvas does

- **Idle drawing.** The draw loop keeps requesting animation frames, but a frame is drawn only when it can look different from the last one.
  - Every frame the loop computes a cheap fingerprint of the scene (agent and tool card positions, states, opacity, counts, camera, canvas size, selection, hover, focus, toggles, React re-renders). A new fingerprint draws at once.
  - A **calm** scene (no thinking / tool-calling / waiting agent, no running tool, no particle, no effect) is redrawn at most **10 times a second**.
  - Under **reduced motion** (OS preference or the "Pause animations" toggle) the scene is redrawn on change, and otherwise every **250 ms** so clocks and expiries stay true.
  - Any pointer, wheel, key or focus event brings the loop back to full rate for one second, so hover and clicks answer immediately.
  - A scene with an active agent keeps its full frame rate: its pulses and comets are real animation, not a state to freeze.
- **Viewport culling.** The agent, tool card, edge and particle passes skip what lies outside the visible area plus a margin (96 screen px, and a per-element extent for labels, glows and trails). Zoomed on one cluster of a large fleet, the other clusters cost nothing.
- Nothing is drawn from an invented state: a skipped frame leaves the last drawn frame on screen, and the fingerprint covers what moves.

Not covered: the simulation loop (`use-agent-simulation.ts`) still ticks every frame while playing.

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
