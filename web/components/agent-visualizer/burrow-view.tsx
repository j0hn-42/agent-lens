'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SimulationState, AgentLink } from '@/hooks/simulation/types'
import { useUiPreferences } from '@/hooks/use-ui-preferences'
import { useBurrowAnnouncements } from '@/hooks/use-burrow-announcements'
import type { AnnounceLevel } from '@/lib/ui-preferences'
import { LiveAnnouncements } from './live-announcements'
import { useLocale, useT } from '@/lib/locale'
import { FOCUS_RING } from '@/lib/focus-ring'
import { BurrowAgentList } from './burrow-agent-list'
import { createBurrowEngine, type BurrowEngine } from '@/lib/burrow/burrow-engine'
import { createBurrowRenderer, type BurrowRenderer } from '@/lib/burrow/burrow-render'
import { BURROW_DATA } from '@/lib/burrow/burrow-data'
import { BURROW_ROOM_ORDER } from '@/lib/burrow/burrow-model'
import type { BurrowBubble } from '@/lib/burrow/burrow-model'
import { createBurrowSyncState, syncBurrow, BURROW_MAX_ANIMALS, type BurrowRow, type BurrowSyncState } from '@/lib/burrow/burrow-sync'
import type { BurrowRoomId } from '@/lib/burrow/burrow-types'

export interface BurrowViewProps {
  simulationRef: React.RefObject<SimulationState>
  selectedAgentId: string | null
  /** The agent under the pointer or on the focused list row: ringed like the selected one, dashed */
  hoveredAgentId?: string | null
  /** Same switch as the graph: idle and finished agents are not drawn (the selected one is) */
  hideInactive?: boolean
  onAgentClick: (agentId: string | null, modifiers?: { shiftKey: boolean }) => void
  onAgentHover: (agentId: string | null) => void
  /** Verbosity of the live announcements, the same preference as the graph (#379) */
  announceLevel?: AnnounceLevel
  /** Links between agents, for the team announcements ("<from> sent a message to <to>"); the simulation's otherwise */
  links?: Map<string, AgentLink>
}

// The speech bubbles keep the paper and ink of the picture they sit on, whatever the theme.
const BUBBLE_PAPER = '#fbefd2'
const BUBBLE_INK = '#3b2013'
const BUBBLE_SHADOW = 'rgba(20, 8, 4, 0.45)'

type Assets = { images: Record<string, HTMLImageElement> }

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, ko) => {
    const im = new Image()
    im.onload = () => ok(im)
    im.onerror = () => ko(new Error('image'))
    im.src = src
  })
}

/** The pictures are a separate chunk: nothing of the burrow is loaded until the view is shown */
async function loadAssets(): Promise<Assets> {
  const { BURROW_IMAGES } = await import('@/lib/burrow/burrow-images')
  const names = Object.keys(BURROW_IMAGES)
  const list = await Promise.all(names.map((n) => loadImage(BURROW_IMAGES[n])))
  const images: Record<string, HTMLImageElement> = {}
  names.forEach((n, i) => { images[n] = list[i] })
  return { images }
}

function styleBubble(el: HTMLDivElement, u: number): void {
  const s = el.style
  s.position = 'absolute'; s.insetBlockStart = '0'; s.insetInlineStart = '0'
  s.inlineSize = 'max-content'; s.maxInlineSize = `${u * 78}px`
  s.background = BUBBLE_PAPER; s.color = BUBBLE_INK
  s.border = `${u}px solid ${BUBBLE_INK}`; s.borderRadius = `${u * 2}px`
  s.boxShadow = `0 ${u}px 0 ${BUBBLE_SHADOW}`
  s.padding = `${u * 1.5}px ${u * 2.5}px`
  s.fontSize = `${u * 4.2}px`; s.fontWeight = '700'; s.lineHeight = '1.25'; s.textAlign = 'center'
  s.fontFamily = 'inherit'; s.pointerEvents = 'none'; s.willChange = 'transform'
}

export function BurrowView({ simulationRef, selectedAgentId, hoveredAgentId = null, hideInactive = false, onAgentClick, onAgentHover, announceLevel = 'all', links }: BurrowViewProps) {
  const t = useT()
  const { locale } = useLocale()
  const { prefs } = useUiPreferences()
  const announcements = useBurrowAnnouncements({ simulationRef, announceLevel, hideInactive, selectedAgentId, links })
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const hoverRingRef = useRef<HTMLDivElement>(null)
  const dirtyRef = useRef(true)
  const [assets, setAssets] = useState<Assets | null>(null)
  const [failed, setFailed] = useState(false)
  const [rows, setRows] = useState<BurrowRow[]>([])
  const [hidden, setHidden] = useState(0)
  const [showTitles, setShowTitles] = useState(true)
  const [osReduced, setOsReduced] = useState(false)
  const reduced = osReduced || prefs.freezeMotion

  // live values for the frame loop (it never restarts for them)
  const live = useRef({ selectedAgentId, hoveredAgentId, hideInactive, reduced, showTitles, onAgentClick, onAgentHover, t })
  live.current = { selectedAgentId, hoveredAgentId, hideInactive, reduced, showTitles, onAgentClick, onAgentHover, t }
  // reduced motion draws again only when something changed (selection, hover, titles, hiding, motion setting)
  useEffect(() => { dirtyRef.current = true }, [selectedAgentId, hoveredAgentId, hideInactive, reduced, showTitles])

  useEffect(() => {
    let alive = true
    loadAssets().then((a) => { if (alive) setAssets(a) }, () => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    setOsReduced(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setOsReduced(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  // the room titles are woven into the picture: a new language builds a new scene (the agents are put back where they were)
  const titles = useMemo(() => {
    const out: Record<string, string> = {}
    for (const r of [...BURROW_ROOM_ORDER, 'home']) out[r] = t(`burrow.room.${r}` as 'burrow.room.lounge')
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t changes with the locale
  }, [locale])

  useEffect(() => {
    const view = canvasRef.current
    const container = containerRef.current
    const stage = stageRef.current
    const overlay = overlayRef.current
    const ring = ringRef.current
    const hoverRing = hoverRingRef.current
    if (!assets || !view || !container || !stage || !overlay || !ring || !hoverRing) return
    const { w: W, h: H } = BURROW_DATA.map
    const engine: BurrowEngine = createBurrowEngine({ data: BURROW_DATA, titles })
    const renderer: BurrowRenderer | null = createBurrowRenderer(BURROW_DATA, assets.images, engine, view)
    if (!renderer) { setFailed(true); return }
    setFailed(false)
    const sync: BurrowSyncState = createBurrowSyncState()
    const bubbles = new Map<string, HTMLDivElement>()
    let scale = 1
    let rowsSig = ''
    let hiddenShown = -1
    let stopped = false
    let raf = 0
    let last = 0

    const resize = (): void => {
      const cw = container.clientWidth
      const ch = container.clientHeight
      if (cw <= 0 || ch <= 0) return
      scale = Math.max(0.5, Math.min(cw / W, ch / H))
      stage.style.width = `${Math.floor(W * scale)}px`
      stage.style.height = `${Math.floor(H * scale)}px`
      backing()
      for (const el of bubbles.values()) styleBubble(el, Math.max(2.4, scale))
      dirtyRef.current = true
    }
    // the backing store follows the device pixel ratio too (window moved to another screen, browser zoom)
    let K = 0
    const backing = (): void => {
      const k = Math.max(1, Math.min(8, Math.ceil(scale * (window.devicePixelRatio || 1) - 0.001)))
      if (k !== K) { K = k; renderer.resize(W * K, H * K); dirtyRef.current = true }
    }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
    ro?.observe(container)
    resize()

    const bubbleText = (b: BurrowBubble): string => {
      const tr = live.current.t
      if (b.kind === 'tool') return b.tool
      const state = tr(`state.${b.state}` as 'state.idle')
      return b.kind === 'stale' ? tr('burrow.bubble.stale', { state }) : state
    }
    const follow = (): void => {
      const sim = simulationRef.current
      const { rows: next, hidden: extra, changed } = syncBurrow(engine, sync, sim ? sim.agents : new Map(), {
        hideInactive: live.current.hideInactive, selectedId: live.current.selectedAgentId, bubbleText, instant: live.current.reduced, now: Date.now(),
      })
      if (changed) dirtyRef.current = true
      const sig = next.map((r) => `${r.id}|${r.name}|${r.presence}|${r.room}|${r.state}|${r.tool ?? ''}|${r.stale}`).join('\n')
      if (sig !== rowsSig) { rowsSig = sig; setRows(next) }
      if (extra !== hiddenShown) { hiddenShown = extra; setHidden(extra) }
    }

    const placeOverlays = (): void => {
      const stageW = W * scale
      const u = Math.max(2.4, scale)
      const seen = new Set<string>()
      for (const a of engine.actors) {
        if (a.said === null || a.mode === 'home') continue
        seen.add(a.key)
        let el = bubbles.get(a.key)
        if (!el) { el = document.createElement('div'); el.setAttribute('aria-hidden', 'true'); styleBubble(el, u); overlay.appendChild(el); bubbles.set(a.key, el) }
        if (el.textContent !== a.said) el.textContent = a.said
        const half = el.offsetWidth / 2
        const x = a.x * scale
        const tall = (a.pose && a.meta.poses[a.pose]?.h) || a.meta.h
        const y = (a.y - tall - 4) * scale
        const cx = Math.max(half + 4, Math.min(stageW - half - 4, x))
        el.style.transform = `translate(${cx.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%)`
      }
      for (const [key, el] of bubbles) if (!seen.has(key)) { el.remove(); bubbles.delete(key) }
      const place = (el: HTMLDivElement, key: string | null): void => {
        const picked = key ? engine.actors.find((a) => a.key === key && a.mode !== 'home') : undefined
        if (!picked) { el.style.display = 'none'; return }
        el.style.display = 'block'
        el.style.transform = `translate(${(picked.x * scale).toFixed(1)}px,${(picked.y * scale).toFixed(1)}px) translate(-50%,-60%)`
        el.style.width = `${Math.round(24 * scale)}px`; el.style.height = `${Math.round(10 * scale)}px`
      }
      const { selectedAgentId: sel, hoveredAgentId: hov } = live.current
      place(ring, sel)
      place(hoverRing, hov && hov !== sel ? hov : null)
    }
    const draw = (): void => {
      renderer.render({ showTitles: live.current.showTitles })
      placeOverlays()
    }

    // reduced motion: no continuous animation. The scene is brought to its resting state when something changes, then drawn once.
    let calmTimer = 0
    const settle = (): void => { engine.fastForward(40); draw() }
    const frame = (ts: number): void => {
      if (stopped) return
      const dt = Math.min(0.1, Math.max(0, (ts - last) / 1000))
      last = ts
      follow()
      backing()
      if (live.current.reduced) {
        if (dirtyRef.current && !calmTimer) calmTimer = window.setTimeout(() => { calmTimer = 0; dirtyRef.current = false; settle() }, 120)
      } else {
        dirtyRef.current = true
        engine.update(dt)
        draw()
      }
      raf = window.requestAnimationFrame(frame)
    }
    raf = window.requestAnimationFrame((ts) => { last = ts; raf = window.requestAnimationFrame(frame) })

    const toScene = (e: PointerEvent): { x: number; y: number } => {
      const r = view.getBoundingClientRect()
      return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
    }
    let hovered: string | null = null
    const onMove = (e: PointerEvent): void => {
      const p = toScene(e)
      const hit = engine.actorAt(p.x, p.y)?.key ?? null
      view.style.cursor = hit ? 'pointer' : 'default'
      if (hit !== hovered) { hovered = hit; live.current.onAgentHover(hit) }
    }
    const onLeave = (): void => { if (hovered !== null) { hovered = null; live.current.onAgentHover(null) } }
    // a click is a press and a release on the same animal (or on the empty floor), with the main button
    let pressed: { key: string | null } | null = null
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) { pressed = null; return }
      const p = toScene(e)
      pressed = { key: engine.actorAt(p.x, p.y)?.key ?? null }
    }
    const onUp = (e: PointerEvent): void => {
      const start = pressed
      pressed = null
      if (!start || e.button !== 0) return
      const p = toScene(e)
      const key = engine.actorAt(p.x, p.y)?.key ?? null
      if (key === start.key) live.current.onAgentClick(key, { shiftKey: e.shiftKey })
    }
    const onCancel = (): void => { pressed = null; onLeave() }
    view.addEventListener('pointermove', onMove)
    view.addEventListener('pointerleave', onLeave)
    view.addEventListener('pointerdown', onDown)
    view.addEventListener('pointerup', onUp)
    view.addEventListener('pointercancel', onCancel)

    return () => {
      stopped = true
      window.cancelAnimationFrame(raf)
      window.clearTimeout(calmTimer)
      ro?.disconnect()
      view.removeEventListener('pointermove', onMove)
      view.removeEventListener('pointerleave', onLeave)
      view.removeEventListener('pointerup', onUp)
      view.removeEventListener('pointerdown', onDown)
      view.removeEventListener('pointercancel', onCancel)
      for (const el of bubbles.values()) el.remove()
      live.current.onAgentHover(null)
    }
  }, [assets, titles, simulationRef])

  const onTitles = useCallback(() => setShowTitles((v) => !v), [])
  const roomName = (r: BurrowRoomId): string => t(`burrow.room.${r}` as 'burrow.room.lounge')
  const rowLabel = (r: BurrowRow): string => {
    if (r.presence === 'finished') return t('burrow.agent.done', { name: r.name })
    const state = t(`state.${r.state}` as 'state.idle')
    if (r.stale) return t('burrow.agent.stale', { name: r.name, state })
    return r.tool
      ? t('burrow.agent.tool', { name: r.name, state, room: roomName(r.room), tool: r.tool })
      : t('burrow.agent', { name: r.name, state, room: roomName(r.room) })
  }

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={t('burrow.region')}
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      style={{ background: 'var(--lens-void)' }}
    >
      <div ref={stageRef} className="relative" style={{ width: 560, height: 315 }}>
        <canvas ref={canvasRef} width={560} height={315} aria-hidden="true" className="block size-full" style={{ imageRendering: 'pixelated' }} />
        <div ref={overlayRef} aria-hidden="true" className="pointer-events-none absolute inset-0" />
        <div
          ref={hoverRingRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 hidden rounded-[50%]"
          style={{ border: '2px dashed var(--lens-focus)' }}
        />
        <div
          ref={ringRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 hidden rounded-[50%]"
          style={{ border: '2px solid var(--lens-focus)' }}
        />
      </div>
      {(!assets || failed) && (
        <p role="status" className="absolute m-0 text-xs font-mono" style={{ color: 'var(--lens-ink-muted)' }}>
          {failed ? t('burrow.failed') : t('burrow.loading')}
        </p>
      )}
      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] flex-col items-start gap-1 text-2xs font-mono" style={{ color: 'var(--lens-ink-muted)' }}>
        {hidden > 0 && <p role="status" className="m-0">{t('burrow.hidden', { n: hidden, max: BURROW_MAX_ANIMALS })}</p>}
        <button
          type="button"
          aria-pressed={showTitles}
          onClick={onTitles}
          className={`min-h-6 cursor-pointer rounded px-1.5 py-0.5 ${FOCUS_RING}`}
          style={{ background: 'var(--lens-surface-raised)', border: '1px solid var(--lens-control-border)', color: 'var(--lens-ink)' }}
        >
          {t('burrow.titles')}
        </button>
      </div>
      {rows.length > 0 && (
        <BurrowAgentList
          label={t('burrow.list')}
          rows={rows}
          selectedAgentId={selectedAgentId}
          rowLabel={rowLabel}
          onAgentClick={(id) => onAgentClick(id)}
          onAgentHover={onAgentHover}
        />
      )}
      <p className="sr-only">{t('burrow.rooms.help')} {t('burrow.hint')}</p>
      <LiveAnnouncements announcements={announcements} />
    </div>
  )
}
