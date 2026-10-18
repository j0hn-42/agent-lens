// Per-layer motion (#247). The global reduced motion (OS preference or "Freeze motion") calms every
// layer; on top of it each canvas layer can be calmed on its own. Pure data: no React, no path aliases.

/** Canvas layers whose ambient motion can be calmed, in draw order. */
export const MOTION_LAYERS = ['background', 'links', 'agents', 'effects'] as const
export type MotionLayer = (typeof MOTION_LAYERS)[number]

/** true = this layer is calm (its ambient motion is off) */
export type CalmLayers = Readonly<Record<MotionLayer, boolean>>

export const DEFAULT_CALM_LAYERS: CalmLayers = Object.freeze({ background: false, links: false, agents: false, effects: false })

export const MOTION_LAYERS_STORAGE_KEY = 'agent-lens:calm-layers'

const MAX_STORED_LENGTH = 1_000

/** Is this layer calm? The global reduced motion wins over the per-layer choice. */
export function layerIsCalm(globalReduced: boolean, calm: CalmLayers, layer: MotionLayer): boolean {
  return globalReduced || calm[layer]
}

export function allLayersCalm(calm: CalmLayers): boolean {
  return MOTION_LAYERS.every(l => calm[l])
}

export function toggleCalmLayer(calm: CalmLayers, layer: MotionLayer): CalmLayers {
  return { ...calm, [layer]: !calm[layer] }
}

/** Parse the stored text; never throws. Unknown keys and non-boolean values are dropped. */
export function parseCalmLayers(text: string | null | undefined): CalmLayers {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_STORED_LENGTH) return DEFAULT_CALM_LAYERS
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_CALM_LAYERS
    const out = { ...DEFAULT_CALM_LAYERS } as Record<MotionLayer, boolean>
    for (const l of MOTION_LAYERS) {
      if (Object.prototype.hasOwnProperty.call(raw, l) && (raw as Record<string, unknown>)[l] === true) out[l] = true
    }
    return out
  } catch {
    return DEFAULT_CALM_LAYERS
  }
}
