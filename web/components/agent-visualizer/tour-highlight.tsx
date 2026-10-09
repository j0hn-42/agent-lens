'use client'

import { useEffect, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import type { TourTarget } from '@/lib/guided-steps'
import { useTourBridge } from './guided-tour-context'

export const AGENT_RING_RADIUS = 48

export interface RingRect { left: number; top: number; width: number; height: number }
type NamedPoint = { name: string; x: number; y: number }
type ToScreen = ((worldX: number, worldY: number) => { x: number; y: number }) | null

/** Where the ring goes for a step target, or null when the target is not on screen (no ring, never an error). */
export function ringRect(
  target: TourTarget,
  agents: ReadonlyMap<string, NamedPoint>,
  toScreen: ToScreen,
  query: (id: string) => Element | null,
): RingRect | null {
  if (target.kind === 'dom') {
    const r = query(target.id)?.getBoundingClientRect()
    return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
  }
  if (target.kind === 'agent' && toScreen) {
    const agent = [...agents.values()].find(a => a.name === target.name)
    if (!agent) return null
    const p = toScreen(agent.x, agent.y)
    return { left: p.x - AGENT_RING_RADIUS, top: p.y - AGENT_RING_RADIUS, width: AGENT_RING_RADIUS * 2, height: AGENT_RING_RADIUS * 2 }
  }
  return null
}

const queryTarget = (id: string) => document.querySelector(`[data-tour-target="${id}"]`)

/** Scrolls the panel holding a DOM target (the legend) so the target sits at its top, with the rows under it in view. */
function scrollToPanelTop(el: Element) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) {
      p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top
      return
    }
  }
}

/** Ring around the element a tour step is about. Follows moving agents on every frame; never animated itself. */
export function TourHighlight({ target, getAgents }: { target: TourTarget; getAgents: () => ReadonlyMap<string, NamedPoint> }) {
  const { canvasToScreenRef } = useTourBridge()
  const [rect, setRect] = useState<RingRect | null>(null)

  useEffect(() => {
    let raf = 0
    // A DOM target can sit below the fold of a scrolling panel (the legend): bring it into view once, without animation
    let scrolled = target.kind !== 'dom'
    const tick = () => {
      if (!scrolled && target.kind === 'dom') {
        const el = queryTarget(target.id)
        if (el) { scrollToPanelTop(el); scrolled = true }
      }
      const next = ringRect(target, getAgents(), canvasToScreenRef.current, queryTarget)
      setRect(prev => (prev && next && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height) ? prev : next)
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [target, getAgents, canvasToScreenRef])

  if (!rect) return null
  return (
    <div
      data-tour-ring
      aria-hidden="true"
      className="pointer-events-none fixed rounded-lg"
      style={{
        left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8,
        zIndex: Z.detailCard - 1,
        border: `2px solid ${COLORS.textPrimary}`,
        boxShadow: `0 0 0 3px ${COLORS.panelBg}`,
      }}
    />
  )
}
