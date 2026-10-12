import { useCallback, useEffect, useRef, useState } from 'react'
import type { Agent } from '@/lib/agent-types'
import {
  DEFAULT_PRESENTATION_OPTIONS, PRESENTATION_STORAGE_KEY, parsePresentationOptions, serializePresentationOptions,
  snapshotOf, transitionSubtitle, observedLive, type AgentSnapshot, type PresentationOptions,
} from '@/lib/presentation'

/** How long a subtitle stays on screen */
export const SUBTITLE_VISIBLE_MS = 7000

/** Attribute set on <html> while free text must be hidden; the stylesheet blurs `[data-sensitive]` under it. */
export const PRESENTATION_MASK_ATTRIBUTE = 'data-presentation-mask'

/** The three options (persisted) and the mode itself (never persisted: a page does not start in presentation). */
export function usePresentationMode() {
  const [options, setOptions] = useState<PresentationOptions>(DEFAULT_PRESENTATION_OPTIONS)
  const [active, setActive] = useState(false)
  useEffect(() => {
    try { setOptions(parsePresentationOptions(localStorage.getItem(PRESENTATION_STORAGE_KEY))) } catch { /* storage unavailable */ }
  }, [])
  const setOption = useCallback((key: keyof PresentationOptions, value: boolean) => {
    setOptions(prev => {
      const next = { ...prev, [key]: value }
      try { localStorage.setItem(PRESENTATION_STORAGE_KEY, serializePresentationOptions(next)) } catch { /* storage unavailable */ }
      return next
    })
  }, [])
  const toggle = useCallback(() => setActive(prev => !prev), [])
  const stop = useCallback(() => setActive(false), [])
  return { active, options, setOption, toggle, stop, setActive }
}

/** Marks <html> while masking is in force, and always cleans up. */
export function usePresentationMaskAttribute(masked: boolean): void {
  useEffect(() => {
    if (!masked) return
    const root = document.documentElement
    root.setAttribute(PRESENTATION_MASK_ATTRIBUTE, '')
    return () => root.removeAttribute(PRESENTATION_MASK_ATTRIBUTE)
  }, [masked])
}

/**
 * Latest subtitle: the transition of an agent seen live between two renders. Enabling the hook only records what is
 * there (nothing is said about the past); replayed or imported agents say nothing. The text clears itself.
 */
export function usePresentationSubtitle(agents: ReadonlyMap<string, Agent>, { enabled, mask }: { enabled: boolean; mask: boolean }): string | null {
  const [text, setText] = useState<string | null>(null)
  const seenRef = useRef<Map<string, AgentSnapshot> | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled) {
      seenRef.current = null
      if (timerRef.current) clearTimeout(timerRef.current)
      setText(null)
      return
    }
    const seen = seenRef.current
    const next = new Map<string, AgentSnapshot>()
    let latest: { at: number; text: string } | null = null
    for (const [id, agent] of agents) {
      next.set(id, snapshotOf(agent))
      if (!seen) continue
      const sentence = transitionSubtitle(seen.get(id), agent, mask)
      if (sentence === null) continue
      const at = observedLive(agent) ? (agent.lastEventAt as number) : 0
      if (!latest || at >= latest.at) latest = { at, text: sentence }
    }
    seenRef.current = next
    if (latest) {
      setText(latest.text)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setText(null), SUBTITLE_VISIBLE_MS)
    }
  }, [agents, enabled, mask])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
  return enabled ? text : null
}
