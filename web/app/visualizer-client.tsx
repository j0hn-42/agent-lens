'use client'

import { lazyComponent } from '@/components/agent-visualizer/lazy-component'
import { prepareBoot } from '@/lib/boot'

/**
 * The visualizer on the Next page (#662): a chunk of its own, rendered on the client once the language asked for and
 * the demo scenario are loaded (prepareBoot). The page used to be prerendered in English, then switched to French at
 * hydration; it now paints once, in the language of the reader (the server renders nothing: nothing is loaded there).
 *
 * Not next/dynamic: it goes through Suspense, and React 19 holds the reveal of a suspended boundary for 300 ms
 * (measured: first paint at 314 ms against 75 ms for the last chunk). lazyComponent sets a state instead, and the
 * same import() is what Turbopack splits on.
 */
export const VisualizerClient = lazyComponent<Record<string, never>>(
  // Both requests leave together: the visualizer chunk does not wait for the language table or the scenario
  () => Promise.all([import('@/components/agent-visualizer'), prepareBoot()]).then(([m]) => m.AgentVisualizer),
)
