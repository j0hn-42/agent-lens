'use client'

import dynamic from 'next/dynamic'
import { prepareBoot } from '@/lib/boot'

/**
 * The visualizer on the Next page (#662): a chunk of its own, rendered on the client only once the language asked for
 * and the demo scenario are loaded (prepareBoot). The page used to be prerendered in English, then switched to French
 * at hydration; it now paints once, in the language of the reader. The canvas has nothing to prerender anyway.
 */
export const VisualizerClient = dynamic(
  () => prepareBoot().then(() => import('@/components/agent-visualizer')).then(m => m.AgentVisualizer),
  { ssr: false },
)
