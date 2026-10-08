/**
 * Where an agent's model comes from, and which source wins (#60).
 * Principle: never display a value whose origin cannot be named.
 *
 * Sources, strongest first:
 *  1. runtime    - the model the transcript actually reports on an assistant message (model_detected)
 *  2. configured - the model of the agent's own configuration (teammate / team definition)
 *  3. requested  - the `model` the dispatching Agent/Task call asked for (may be an alias, may be overridden)
 *
 * A source only replaces the current model when its priority is equal or higher, so a late
 * "requested" never hides what ran, while a /model switch (runtime again) always updates.
 */

export type ModelSource = 'requested' | 'configured' | 'runtime'

export const MODEL_SOURCE_PRIORITY: Readonly<Record<ModelSource, number>> = {
  runtime: 3,
  configured: 2,
  requested: 1,
}

/** Distinct runtime models remembered per agent (a session rarely switches more than a few times). */
export const MAX_MODELS_USED = 8

/** Reasoning effort levels we accept; anything else is not shown. */
export const EFFORT_LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function parseModelSource(v: unknown): ModelSource | undefined {
  return v === 'requested' || v === 'configured' || v === 'runtime' ? v : undefined
}

/** Reasoning effort from an untrusted payload: lower-cased known level, else undefined (never invented). */
export function parseEffort(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const e = v.trim().toLowerCase()
  return EFFORT_LEVELS.includes(e) ? e : undefined
}

export interface ModelFields {
  model?: string
  modelSource?: ModelSource
}

/** The fields to set when `incoming` is reported, or null when the current model outranks it. */
export function mergeModel(current: ModelFields, incoming: { model: string; source: ModelSource }): Required<ModelFields> | null {
  if (!incoming.model) return null
  const cur = current.model && current.modelSource ? MODEL_SOURCE_PRIORITY[current.modelSource] : 0
  if (MODEL_SOURCE_PRIORITY[incoming.source] < cur) return null
  return { model: incoming.model, modelSource: incoming.source }
}

/** Distinct runtime models, in first-seen order, bounded (oldest dropped). */
export function recordModelUsed(list: readonly string[] | undefined, model: string): string[] {
  const prev = list ?? []
  if (prev.includes(model)) return prev as string[]
  const next = [...prev, model]
  return next.length > MAX_MODELS_USED ? next.slice(next.length - MAX_MODELS_USED) : next
}

/** True when the model that ran is the one that was asked for (aliases like "opus" match a full id). */
export function modelRequestMatches(requested: string, actual: string): boolean {
  const r = requested.trim().toLowerCase()
  const a = actual.trim().toLowerCase()
  if (!r || !a) return false
  return r === a || a.includes(r)
}

export type ModelBadgeKind = 'actual' | 'mismatch' | 'configured' | 'requested'

export interface ModelBadge {
  kind: ModelBadgeKind
  /** Short pill text */
  label: string
}

/** Pill describing the provenance of the shown model; undefined when there is no model. */
export function modelBadge(agent: ModelFields & { requestedModel?: string }): ModelBadge | undefined {
  if (!agent.model) return undefined
  const source = agent.modelSource ?? 'requested'
  if (source === 'runtime') {
    if (agent.requestedModel && !modelRequestMatches(agent.requestedModel, agent.model)) {
      return { kind: 'mismatch', label: 'requested ≠ actual' }
    }
    return { kind: 'actual', label: 'actual' }
  }
  return source === 'configured' ? { kind: 'configured', label: 'configured' } : { kind: 'requested', label: 'requested' }
}

/** One-line, screen-reader friendly description of the model: "<name> (<provenance>), effort <e>". */
export function describeModel(
  agent: ModelFields & { requestedModel?: string; effort?: string },
  formatName: (id: string) => string,
): string {
  if (!agent.model) return 'unknown model'
  const badge = modelBadge(agent)
  const parts = [`${formatName(agent.model)} (${badge ? badge.label : 'requested'})`]
  if (badge?.kind === 'mismatch' && agent.requestedModel) parts.push(`requested ${formatName(agent.requestedModel)}`)
  if (agent.effort) parts.push(`effort ${agent.effort}`)
  return parts.join(', ')
}
