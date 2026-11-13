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
import { BurrowLegend } from './burrow-legend'
import { createBurrowEngine, type BurrowEngine } from '@/lib/burrow/burrow-engine'
import { createBurrowLoop } from '@/lib/burrow/burrow-loop'
import { createBurrowRenderer, type BurrowRenderer, type BurrowLetter, type BurrowThread } from '@/lib/burrow/burrow-render'
import { createMailState, linksSignature, newMail, openDelegations, relativesOf, type MailKind } from '@/lib/burrow/burrow-links'
import { isDoneAgent } from '@/lib/inactive-agents'
import { BURROW_DATA } from '@/lib/burrow/burrow-data'
import { BURROW_ROOM_ORDER } from '@/lib/burrow/burrow-model'
import type { BurrowBubble } from '@/lib/burrow/burrow-model'
import { createBurrowSyncState, syncBurrow, syncDue, simFingerprint, BURROW_MAX_ANIMALS, type BurrowRow, type BurrowSyncState } from '@/lib/burrow/burrow-sync'
import { burrowRowLabel } from '@/lib/burrow/burrow-row-label'
import { fillTag } from './burrow-tag'
import type { HealthVerdict } from '@/lib/loop-detection'
import { cullTags, nextTagNames, showsTag, truncateName, type Box, type TagBox } from '@/lib/burrow/burrow-labels'
import { fitStage, type StageInsets } from '@/lib/burrow/burrow-fit'
import { measureOverlayInsets } from './canvas/overlay-insets'

export interface BurrowViewProps {
  simulationRef: React.RefObject<SimulationState>
  selectedAgentId: string | null
  /** The agent under the pointer or on the focused list row: ringed like the selected one, dashed */
  hoveredAgentId?: string | null
  /** Same switch as the graph: idle and finished agents are not drawn (the selected one is) */
  hideInactive?: boolean
  onAgentClick: (agentId: string | null, modifiers?: { shiftKey: boolean }) => void
  onAgentHover: (agentId: string | null) => void
  /** Right click on an animal: the agent's context menu, at the pointer. Absent = the browser's own menu stays */
  onAgentContextMenu?: (agentId: string, at: { clientX: number; clientY: number }) => void
  /** Verbosity of the live announcements, the same preference as the graph (#379) */
  announceLevel?: AnnounceLevel
  /** Links between agents, for the team announcements ("<from> sent a message to <to>"); the simulation's otherwise */
  links?: Map<string, AgentLink>
  /** Element that takes the focus when *Back to the graph* removes the burrow (and the button with it) */
  focusTargetId?: string
  /** Loop verdict per agent id, the graph's `health.byAgent`: a proven loop gets the graph's badge, beside the name tag */
  health?: ReadonlyMap<string, HealthVerdict>
  /** Events the relay could not replay, per session (#366): the list rows of that session's agents say it */
  replayLost?: ReadonlyMap<string, number>
  /** The Cost totals (CostTotalsText, visible) while the Cost panel is on: the burrow draws no panel, it shows them in its corner */
  costTotals?: React.ReactNode
}

// The speech bubbles keep the paper and ink of the picture they sit on, whatever the theme.
const BUBBLE_PAPER = '#fbefd2'
const BUBBLE_INK = '#3b2013'
const BUBBLE_SHADOW = 'rgba(20, 8, 4, 0.45)'
/** Seconds a letter takes from one animal to the other; at most this many letters fly at once */
const LETTER_SECONDS = 1.6
const MAX_LETTERS = 12
/** The panels over the scene (dock opened or closed, control bar folded) are measured again this often, like the graph's fit */
const INSETS_MS = 1000

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

/** Name tag under an animal: the same paper and ink as the bubbles, smaller */
function styleTag(el: HTMLDivElement, u: number): void {
  const s = el.style
  s.position = 'absolute'; s.insetBlockStart = '0'; s.insetInlineStart = '0'
  s.inlineSize = 'max-content'; s.whiteSpace = 'nowrap'
  s.background = BUBBLE_PAPER; s.color = BUBBLE_INK
  s.border = `${Math.max(1, u / 2)}px solid ${BUBBLE_INK}`; s.borderRadius = `${u}px`
  s.padding = `0 ${u}px`
  s.fontSize = `${u * 3.4}px`; s.fontWeight = '700'; s.lineHeight = '1.3'
  s.fontFamily = 'inherit'; s.pointerEvents = 'none'; s.willChange = 'transform'
}

export function BurrowView({ simulationRef, selectedAgentId, hoveredAgentId = null, hideInactive = false, onAgentClick, onAgentHover, onAgentContextMenu, announceLevel = 'all', links, focusTargetId, health, replayLost, costTotals }: BurrowViewProps) {
  const t = useT()
  const { locale } = useLocale()
  const { prefs, setPref } = useUiPreferences()
  const announcements = useBurrowAnnouncements({ simulationRef, announceLevel, hideInactive, selectedAgentId, links })
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const hoverRingRef = useRef<HTMLDivElement>(null)
  const dirtyRef = useRef(true)
  /** The scene must follow the agents at the next frame, whatever syncDue says (selection, filter, motion setting) */
  const resyncRef = useRef(true)
  /** Tells the frame loop something changed: under reduced motion it follows and draws soon instead of at its next slow tick */
  const wakeRef = useRef<() => void>(() => {})
  const [assets, setAssets] = useState<Assets | null>(null)
  const [failed, setFailed] = useState(false)
  const [rows, setRows] = useState<BurrowRow[]>([])
  const [hidden, setHidden] = useState(0)
  /** Width of the panel docked on the right: the burrow's own controls stay left of it */
  const [dockRight, setDockRight] = useState(0)
  /** The area the top bar, the control bar and the docked panels leave free (the graph's measure): the picture is fitted to it */
  const insetsRef = useRef<StageInsets>({ top: 0, right: 0, bottom: 0, left: 0 })
  /** Fits the stage again (set by the scene once its pictures are loaded) */
  const refitRef = useRef<() => void>(() => {})
  const showTitles = prefs.burrowTitles
  const [osReduced, setOsReduced] = useState(false)
  const reduced = osReduced || prefs.freezeMotion

  // live values for the frame loop (it never restarts for them)
  const live = useRef({ selectedAgentId, hoveredAgentId, hideInactive, reduced, showTitles, onAgentClick, onAgentHover, onAgentContextMenu, t, health, replayLost })
  live.current = { selectedAgentId, hoveredAgentId, hideInactive, reduced, showTitles, onAgentClick, onAgentHover, onAgentContextMenu, t, health, replayLost }
  // what the scene follows depends on these too: the selected agent stays drawn under Show: active, reduced motion places
  // newcomers at once, a new loop verdict or replay loss changes the rows
  useEffect(() => { resyncRef.current = true; wakeRef.current() }, [selectedAgentId, hideInactive, reduced, health, replayLost])
  // reduced motion draws again only when something changed (selection, hover, titles, hiding, motion setting); a motion
  // setting change also switches the loop between animation frames and the slow timer
  useEffect(() => { dirtyRef.current = true; wakeRef.current() }, [selectedAgentId, hoveredAgentId, hideInactive, reduced, showTitles])

  // a panel opening or closing does not resize the scene: the edges are read again every INSETS_MS and on a resize
  // (layout reads, so never per frame)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const same = (a: StageInsets, b: StageInsets): boolean =>
      Math.round(a.top) === Math.round(b.top) && Math.round(a.right) === Math.round(b.right)
      && Math.round(a.bottom) === Math.round(b.bottom) && Math.round(a.left) === Math.round(b.left)
    const measure = (): void => {
      const next = measureOverlayInsets(container)
      if (same(insetsRef.current, next)) return
      insetsRef.current = next
      setDockRight(Math.round(next.right))
      refitRef.current()
    }
    measure()
    const timer = window.setInterval(measure, INSETS_MS)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    ro?.observe(container)
    return () => { window.clearInterval(timer); ro?.disconnect() }
  }, [])

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
    const tags = new Map<string, HTMLDivElement>()
    let names = new Map<string, string>()
    /** Agents with a proven loop: their tag carries the graph's loop badge */
    let loops = new Set<string>()
    let shownTags = new Set<string>()
    let scale = 1
    let rowsSig = ''
    let hiddenShown = -1

    const resize = (): void => {
      const fit = fitStage({ w: container.clientWidth, h: container.clientHeight }, insetsRef.current, { w: W, h: H })
      if (!fit) return
      scale = fit.scale
      stage.style.width = `${fit.width}px`
      stage.style.height = `${fit.height}px`
      stage.style.left = `${fit.left}px`
      stage.style.top = `${fit.top}px`
      backing()
      for (const el of bubbles.values()) styleBubble(el, Math.max(2.4, scale))
      for (const el of tags.values()) styleTag(el, Math.max(2.4, scale))
      dirtyRef.current = true
      wakeRef.current()
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
    refitRef.current = resize

    const bubbleText = (b: BurrowBubble): string => {
      const tr = live.current.t
      if (b.kind === 'tool') return b.tool
      if (b.kind === 'waiting') return b.n === 1 ? tr('burrow.bubble.waiting.one') : tr('burrow.bubble.waiting.many', { n: b.n })
      const state = tr(`state.${b.state}` as 'state.idle')
      return b.kind === 'stale' ? tr('burrow.bubble.stale', { state }) : state
    }
    // Delegation: letters fly between two animals when a dispatch, a return or a teammate message is received (never
    // replayed from the history), and the orchestrators' open delegations are counted from the same link messages.
    const mail = createMailState()
    let linksSig = ''
    let delegations = new Map<string, number>()
    const flights: Array<{ kind: MailKind; from: string; to: string; t0: number }> = []
    // following the agents (freshness, filter, placements, rows) is not redone every frame: only when an event arrived,
    // an agent or a link message appeared, a setting changed, or SYNC_INTERVAL_MS went by (what the clock alone changes)
    let lastSync: { at: number; fingerprint: string } | null = null
    const follow = (): void => {
      const sim = simulationRef.current
      const now = Date.now()
      const fingerprint = simFingerprint(sim)
      if (!resyncRef.current && !syncDue(lastSync, now, fingerprint)) return
      resyncRef.current = false
      lastSync = { at: now, fingerprint }
      const agents = sim ? sim.agents : new Map()
      const nextLinksSig = linksSignature(sim?.links)
      if (nextLinksSig !== linksSig) {
        linksSig = nextLinksSig
        for (const m of newMail(sim?.links, mail)) {
          if (live.current.reduced) continue
          flights.push({ kind: m.kind, from: m.from, to: m.to, t0: engine.clock })
          if (flights.length > MAX_LETTERS) flights.shift()
        }
      }
      delegations = openDelegations(sim?.links, (key) => { const ag = agents.get(key); return ag !== undefined && !isDoneAgent(ag) })
      const { rows: next, hidden: extra, changed } = syncBurrow(engine, sync, agents, {
        hideInactive: live.current.hideInactive, selectedId: live.current.selectedAgentId, bubbleText, instant: live.current.reduced, now, delegations,
        health: live.current.health, replayLost: live.current.replayLost,
      })
      if (changed) dirtyRef.current = true
      const sig = next.map((r) => `${r.id}|${r.name}|${r.presence}|${r.room}|${r.state}|${r.tool ?? ''}|${r.stale}|${r.parentId ?? ''}|${r.depth}|${r.delegating ?? 0}|${r.loop ? 1 : 0}|${r.replayLost ?? 0}`).join('\n')
      if (sig !== rowsSig) {
        rowsSig = sig
        setRows(next)
        // a renamed agent must redraw its tag, also under reduced motion where only a dirty scene is placed again
        const tagNames = nextTagNames(names, next)
        names = tagNames.names
        if (tagNames.changed) dirtyRef.current = true
        // a loop proven or gone changes a tag too: redrawn under reduced motion and Freeze motion as well
        const nextLoops = new Set(next.filter((r) => r.loop).map((r) => r.id))
        if (nextLoops.size !== loops.size || [...nextLoops].some((id) => !loops.has(id))) dirtyRef.current = true
        loops = nextLoops
      }
      if (extra !== hiddenShown) { hiddenShown = extra; setHidden(extra) }
    }

    const placeOverlays = (): void => {
      const stageW = W * scale
      const u = Math.max(2.4, scale)
      const seen = new Set<string>()
      const bubbleBoxes: Box[] = []
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
        bubbleBoxes.push({ x: cx - half, y: y - el.offsetHeight, w: el.offsetWidth, h: el.offsetHeight })
      }
      for (const [key, el] of bubbles) if (!seen.has(key)) { el.remove(); bubbles.delete(key) }
      // name tags under the feet (the bubble is above the head): hidden when they would cover another tag or a bubble
      const stageH = H * scale
      const boxes: TagBox[] = []
      const tagged = new Set<string>()
      for (const a of engine.actors) {
        const name = names.get(a.key)
        if (!name || !showsTag(a.mode)) continue
        tagged.add(a.key)
        let el = tags.get(a.key)
        if (!el) { el = document.createElement('div'); el.setAttribute('aria-hidden', 'true'); styleTag(el, u); overlay.appendChild(el); tags.set(a.key, el) }
        fillTag(el, truncateName(name), loops.has(a.key) ? live.current.t('card.health.loop') : null, u)
        const w = el.offsetWidth
        const h = el.offsetHeight
        const left = Math.max(4, Math.min(stageW - w - 4, a.x * scale - w / 2))
        const top = Math.max(0, Math.min(stageH - h - 2, (a.y + 4.5) * scale))
        el.style.transform = `translate(${left.toFixed(1)}px,${top.toFixed(1)}px)`
        boxes.push({ key: a.key, x: left, y: top, w, h })
      }
      for (const [key, el] of tags) if (!tagged.has(key)) { el.remove(); tags.delete(key) }
      shownTags = cullTags(boxes, bubbleBoxes, { always: [live.current.selectedAgentId, live.current.hoveredAgentId], previous: shownTags })
      for (const [key, el] of tags) el.style.visibility = shownTags.has(key) ? 'visible' : 'hidden'
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
    const inScene = (key: string) => engine.actors.find((a) => a.key === key && a.mode !== 'home')
    const letters = (): BurrowLetter[] => {
      const out: BurrowLetter[] = []
      for (let i = flights.length - 1; i >= 0; i--) {
        const f = flights[i]
        const k = (engine.clock - f.t0) / LETTER_SECONDS
        const from = inScene(f.from)
        const to = inScene(f.to)
        if (k >= 1 || !from || !to) { flights.splice(i, 1); continue }   // delivered, or one end is not drawn
        const e = k < 0 ? 0 : k * k * (3 - 2 * k)
        const y1 = from.y - from.meta.h * 0.6
        const y2 = to.y - to.meta.h * 0.6
        out.push({ kind: f.kind, x: from.x + (to.x - from.x) * e, y: y1 + (y2 - y1) * e - 14 * Math.sin(Math.PI * e) })
      }
      return out
    }
    const threads = (): BurrowThread[] => {
      const sel = live.current.selectedAgentId
      const sim = simulationRef.current
      const me = sel ? inScene(sel) : undefined
      if (!sel || !sim || !me) return []
      const out: BurrowThread[] = []
      for (const key of relativesOf(sel, sim.agents, (k) => inScene(k) !== undefined)) {
        const o = inScene(key)
        if (o) out.push({ x1: me.x, y1: me.y - 2, x2: o.x, y2: o.y - 2 })
      }
      return out
    }
    const draw = (): void => {
      renderer.render({ showTitles: live.current.showTitles, threads: threads(), letters: live.current.reduced ? [] : letters() })
      placeOverlays()
    }

    // reduced motion: no continuous animation and no animation frame. A slow timer follows the agents; the scene is
    // brought to its resting state when something changed, then drawn once.
    const settle = (): void => { engine.fastForward(40); draw() }
    const loop = createBurrowLoop({
      host: {
        requestFrame: (cb) => window.requestAnimationFrame(cb),
        cancelFrame: (id) => window.cancelAnimationFrame(id),
        setTimer: (cb, ms) => window.setTimeout(cb, ms),
        clearTimer: (id) => window.clearTimeout(id),
      },
      reduced: () => live.current.reduced,
      frame: (dt) => {
        follow()
        backing()
        dirtyRef.current = true
        engine.update(dt)
        draw()
      },
      calm: () => {
        follow()
        backing()
        if (dirtyRef.current) { dirtyRef.current = false; settle() }
      },
    })
    wakeRef.current = loop.wake

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
    // a right click on an animal opens its agent menu; on the empty floor the browser's menu is left alone
    const onMenu = (e: MouseEvent): void => {
      const open = live.current.onAgentContextMenu
      if (!open) return
      const p = toScene(e as PointerEvent)
      const key = engine.actorAt(p.x, p.y)?.key ?? null
      if (!key) return
      e.preventDefault()
      open(key, { clientX: e.clientX, clientY: e.clientY })
    }
    const onCancel = (): void => { pressed = null; onLeave() }
    view.addEventListener('contextmenu', onMenu)
    view.addEventListener('pointermove', onMove)
    view.addEventListener('pointerleave', onLeave)
    view.addEventListener('pointerdown', onDown)
    view.addEventListener('pointerup', onUp)
    view.addEventListener('pointercancel', onCancel)

    return () => {
      loop.stop()
      wakeRef.current = () => {}
      ro?.disconnect()
      refitRef.current = () => {}
      view.removeEventListener('pointermove', onMove)
      view.removeEventListener('pointerleave', onLeave)
      view.removeEventListener('contextmenu', onMenu)
      view.removeEventListener('pointerup', onUp)
      view.removeEventListener('pointerdown', onDown)
      view.removeEventListener('pointercancel', onCancel)
      for (const el of bubbles.values()) el.remove()
      for (const el of tags.values()) el.remove()
      live.current.onAgentHover(null)
    }
  }, [assets, titles, simulationRef])

  const onTitles = useCallback(() => setPref('burrowTitles', !prefs.burrowTitles), [setPref, prefs.burrowTitles])
  const rowLabel = (r: BurrowRow): string => burrowRowLabel(r, rows, t)

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={t('burrow.region')}
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      style={{ background: 'var(--lens-void)' }}
    >
      <div ref={stageRef} className="absolute" style={{ width: 560, height: 315 }}>
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
        <div className="absolute flex flex-col items-center gap-2 text-xs font-mono" style={{ color: 'var(--lens-ink-muted)' }}>
          <p role="status" className="m-0">{failed ? t('burrow.failed') : t('burrow.loading')}</p>
          {failed && (
            <button
              type="button"
              onClick={() => {
                // the button leaves with the burrow: focus goes to the stable scene region, not back to <body>
                if (focusTargetId) document.getElementById(focusTargetId)?.focus()
                setPref('sceneStyle', 'graph')
              }}
              className={`min-h-6 cursor-pointer rounded px-2 py-1 ${FOCUS_RING}`}
              style={{ background: 'var(--lens-surface-raised)', border: '1px solid var(--lens-control-border)', color: 'var(--lens-ink)' }}
            >
              {t('burrow.failed.back')}
            </button>
          )}
        </div>
      )}
      {/* Below the top bar (drawn over the top of <main>), on the right but left of a docked panel: the collapsed Conversation pill holds the left */}
      <div className="absolute flex max-w-[calc(100%-1rem)] flex-col items-end gap-1 text-2xs font-mono" style={{ top: 'calc(var(--topbar-h, 60px) + 8px)', right: dockRight + 8, color: 'var(--lens-ink-muted)' }}>
        {hidden > 0 && <p role="status" className="m-0">{t('burrow.hidden', { n: hidden, max: BURROW_MAX_ANIMALS })}</p>}
        {costTotals}
        <button
          type="button"
          aria-pressed={showTitles}
          onClick={onTitles}
          className={`min-h-6 cursor-pointer rounded px-1.5 py-0.5 ${FOCUS_RING}`}
          style={{ background: 'var(--lens-surface-raised)', border: '1px solid var(--lens-control-border)', color: 'var(--lens-ink)' }}
        >
          {t('burrow.titles')}
        </button>
        <BurrowLegend />
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
      </div>
      <p className="sr-only">{t('burrow.rooms.help')} {t('burrow.hint')}</p>
      <LiveAnnouncements announcements={announcements} />
    </div>
  )
}
