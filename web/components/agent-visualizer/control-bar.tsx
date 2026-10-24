'use client'

import { useState, useEffect, useLayoutEffect, useCallback, useRef, memo, useId } from 'react'
import { TimelineEvent, Z, POPUP } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { useThemeVersion } from '@/lib/theme'
import { formatDuration } from '@/lib/utils'
import { useLocale } from '@/lib/locale'
import { translate, type Locale, type MessageKey } from '@/lib/messages'
import type { ConnectionStatus } from '@/lib/bridge-types'
import { blurFlagAction, formatEventCount, formatSpeed, liveBadge, formatTruncatedHistory, formatMarkersLost, scrubberKeyTarget, scrubberTimeFromX, scrubberValueText } from '@/lib/chrome-utils'
import { FOCUS_RING } from '@/lib/focus-ring'
import { Button } from '@/components/ui/button'
import { TOUCH_TARGET } from '@/lib/mobile-view'
import { canvasControlsSlotRef } from './canvas-controls-slot'

interface ControlBarProps {
  isPlaying: boolean
  speed: number
  currentTime: number
  totalDuration: number
  onPlayPause: () => void
  /** Clears the scrubbable history (keeps active agents). Asks for confirmation first. */
  onRestart: () => void
  onSpeedChange: (speed: number) => void
  onSeek?: (time: number) => void
  timelineEvents: TimelineEvent[]
  isReviewing?: boolean
  eventCount?: number
  onResumeLive?: () => void
  onEnterReview?: () => void
  /** True while the visualizer shows demo data: the badge reads DEMO instead of LIVE */
  isDemo?: boolean
  /** Relay connection: the badge reads LIVE only while connected or watching (defaults to 'watching') */
  connectionStatus?: ConnectionStatus
  /** Events dropped from the start of the history (event log cap): shows a 'history truncated' marker */
  droppedEvents?: number
  /** Scrubber markers that could not be drawn (messages cut before they were seen, marker cap): says so instead of omitting them */
  lostMarkers?: number
}

/** Next to the scrubber: some older markers are missing, with their number. */
function MarkersLostMarker({ lost, locale }: { lost: number; locale: Locale }) {
  const text = formatMarkersLost(lost, locale)
  if (!text) return null
  return (
    <span
      data-markers-lost=""
      title={text}
      className="shrink-0 text-[11px] font-mono rounded px-1"
      style={{ color: COLORS.textMuted, border: `1px dashed ${COLORS.controlBorder}` }}
    >
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{translate(locale, "bar.markersLost", { n: lost })}</span>
    </span>
  )
}

/** Marker at the start of the scrubber: the oldest part of the history is gone. */
function TruncationMarker({ dropped, locale }: { dropped: number; locale: Locale }) {
  const text = formatTruncatedHistory(dropped, locale)
  if (!text) return null
  return (
    <span
      title={text}
      className="shrink-0 text-2xs font-mono rounded px-1"
      style={{ color: COLORS.textMuted, border: `1px dashed ${COLORS.controlBorder}` }}
    >
      <span aria-hidden="true">… </span>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{translate(locale, 'bar.truncated')}</span>
    </span>
  )
}

function getEventColor(type: TimelineEvent['type']): string {
  switch (type) {
    case 'thinking': return COLORS.thinking
    case 'tool_call': return COLORS.tool
    case 'tool_result': return COLORS.return
    case 'message': return COLORS.message
    case 'error': return COLORS.error
    default: return COLORS.idle
  }
}

/** Max event marker dots rendered on the scrubber (prevents DOM bloat) */
const MAX_SCRUBBER_DOTS = 120

/** Shared event marker dots on the scrubber track. Purely decorative (aria-hidden): the
 *  event count and the slider value text carry the information for assistive tech.
 *  Memoized to avoid re-rendering every frame when only currentTime changes in the parent. */
const EventMarkers = memo(function EventMarkers({ events, totalDuration, className = '' }: {
  events: TimelineEvent[]
  totalDuration: number
  className?: string
  /** Pass events.length to bust memo when array is mutated in place */
  eventCount?: number
}) {
  useThemeVersion() // memoized: repaint on a theme switch
  // Down-sample to MAX_SCRUBBER_DOTS evenly spaced events when list is large
  const visible = events.length > MAX_SCRUBBER_DOTS
    ? Array.from({ length: MAX_SCRUBBER_DOTS }, (_, i) => events[Math.floor(i * events.length / MAX_SCRUBBER_DOTS)])
    : events
  // Position dots relative to the last event so they always span the full bar,
  // rather than compressing into a fraction when currentTime runs ahead of events
  const lastEventTime = events.length > 0 ? events[events.length - 1].timestamp : 0
  const effectiveDuration = lastEventTime > 0 ? lastEventTime : totalDuration
  return (
    <div aria-hidden="true" className="absolute inset-0 pointer-events-none">
      {visible.map((event) => {
        const pos = effectiveDuration > 0 ? (event.timestamp / effectiveDuration) * 100 : 0
        if (!(pos >= 0 && pos <= 100)) return null
        return (
          <div
            key={event.id}
            className={`absolute top-1/2 -translate-y-1/2 w-2 h-2 -ml-1 rounded-full ${className}`}
            style={{ left: `${pos}%`, background: getEventColor(event.type) }}
          />
        )
      })}
    </div>
  )
})

/** Hook to cache the full set of timeline events (dots don't disappear when seeking backward) */
function useScrubberEvents(timelineEvents: TimelineEvent[], totalDuration: number) {
  const fullEventsRef = useRef<TimelineEvent[]>([])
  if (timelineEvents.length === 0 && totalDuration < 0.1) {
    fullEventsRef.current = []
  } else if (timelineEvents.length >= fullEventsRef.current.length) {
    fullEventsRef.current = timelineEvents
  }
  return fullEventsRef.current
}

/** Progress fill: opaque from the first pixel so it keeps >= 3:1 against COLORS.controlTrack
 *  (COLORS.scrubberFill starts at 30% alpha, which fails that ratio at the left end). */
const scrubberFill = () => `linear-gradient(90deg, ${COLORS.accent}, ${COLORS.focus})`

const BAR_CLASS = 'absolute bottom-4 left-4 right-4 mx-auto'
/** Same box as controlBarRect() in lib/panel-layout (which the docks keep clear of). */
const BAR_STYLE: import("react").CSSProperties = { pointerEvents: 'auto', maxWidth: `min(${POPUP.controlBarMaxWidth}px, calc(100vw - 32px))`, zIndex: Z.controlBar }

/**
 * Swaps between the live and review bars. The control that was just activated (Review, LIVE,
 * Confirm clear) unmounts with the swap, so focus is moved to the primary control of the new bar
 * when it would otherwise be dropped on <body>.
 */
export function ControlBar(props: ControlBarProps) {
  const { isReviewing = false } = props
  const wrapperRef = useRef<HTMLDivElement>(null)
  const hadFocusRef = useRef(false)
  const prevReviewingRef = useRef(isReviewing)

  useLayoutEffect(() => {
    if (prevReviewingRef.current === isReviewing) return
    prevReviewingRef.current = isReviewing
    const active = document.activeElement
    const dropped = !active || active === document.body
    if (hadFocusRef.current && dropped) {
      wrapperRef.current?.querySelector<HTMLElement>('[data-primary-control]')?.focus({ preventScroll: true })
    }
  }, [isReviewing])

  return (
    // Focus observer only (carries focus over a live/review swap): presentational, box-less
    <div
      ref={wrapperRef}
      role="presentation"
      style={{ display: 'contents' }}
      onFocus={() => { hadFocusRef.current = true }}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null
        const action = blurFlagAction(!!to && !!wrapperRef.current?.contains(to), to === null)
        if (action === 'clear') hadFocusRef.current = false
        else if (action === 'check') {
          // Focus went nowhere: a control that is still mounted next frame means the user clicked away;
          // one that unmounted is a mode swap, where focus must still be carried over.
          const blurred = e.target as Node
          requestAnimationFrame(() => { if (blurred.isConnected) hadFocusRef.current = false })
        }
      }}
    >
      {isReviewing ? <ReviewControlBar {...props} /> : <LiveControlBar {...props} />}
    </div>
  )
}

// ─── Live Mode Control Bar ───────────────────────────────────────────────────

function LiveControlBar({
  currentTime, totalDuration, timelineEvents,
  eventCount = 0, onEnterReview, isDemo = false, droppedEvents = 0, lostMarkers = 0, connectionStatus = 'watching',
}: ControlBarProps) {
  const { locale } = useLocale()
  const t = (key: MessageKey) => translate(locale, key)
  const scrubberEvents = useScrubberEvents(timelineEvents, totalDuration)
  const badge = liveBadge(connectionStatus, isDemo, locale)
  const badgeColor = badge.live ? COLORS.liveText : badge.tone === 'demo' ? COLORS.holoBright : badge.tone === 'error' ? COLORS.error : COLORS.textMuted
  const noEvents = eventCount === 0
  const reviewReasonId = useId()

  return (
    <div
      role="toolbar"
      lang={locale}
      aria-label={t('bar.toolbar')}
      data-control-bar
      className={BAR_CLASS}
      style={BAR_STYLE}
    >
      <div className="glass-card px-3 sm:px-5 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* LIVE / DEMO badge */}
        <div data-live-badge="" className="flex items-center gap-1.5 shrink-0">
          <span
            aria-hidden="true"
            className={`w-2 h-2 rounded-full ${badge.live ? 'motion-safe:animate-pulse' : ''}`}
            style={{
              background: badge.live ? COLORS.liveDot : 'transparent',
              border: badge.live ? undefined : `2px solid ${badgeColor}`,
              boxShadow: badge.live ? 'var(--lens-live-halo)' : undefined,
            }}
          />
          <span className="text-2xs font-mono font-semibold tracking-wider" style={{ color: badgeColor }}>
            {badge.label}
          </span>
        </div>

        {/* Time */}
        <span className="text-xs font-mono shrink-0" style={{ color: COLORS.textPrimary }}>
          {formatDuration(currentTime)}
        </span>

        <TruncationMarker dropped={droppedEvents} locale={locale} />
        <MarkersLostMarker lost={lostMarkers} locale={locale} />

        {/* Read-only event track */}
        <div className="flex-1 min-w-12 relative h-6 flex items-center">
          <div
            aria-hidden="true"
            className="w-full rounded-full relative"
            style={{ height: 4, background: COLORS.controlTrack }}
          >
            <EventMarkers events={scrubberEvents} totalDuration={totalDuration} eventCount={scrubberEvents.length} className="opacity-90" />
          </div>
        </div>

        {/* Event count */}
        <span className="text-2xs font-mono shrink-0" style={{ color: COLORS.textMuted }}>
          {formatEventCount(eventCount, locale)}
        </span>
        {noEvents && <span id={reviewReasonId} className="sr-only">{t('bar.review.empty')}</span>}

        {/* Review button */}
        <Button
          variant="bar"
          onClick={onEnterReview}
          data-primary-control=""
          aria-disabled={noEvents || undefined}
          aria-describedby={noEvents ? reviewReasonId : undefined}
          aria-label={t('bar.review.name')}
          aria-keyshortcuts="Space"
          className={`px-2.5 py-1 transition-all ${noEvents ? 'opacity-60 cursor-not-allowed' : 'motion-safe:hover:scale-105'}`}
          style={{
            background: COLORS.holoBg10,
            border: `1px solid ${COLORS.controlBorder}`,
            color: noEvents ? COLORS.textMuted : COLORS.textPrimary,
          }}
        >
          <span aria-hidden="true">⏸ </span>{t('bar.review')}
        </Button>
        <div ref={canvasControlsSlotRef} data-canvas-controls-slot="" className="contents" />
      </div>
    </div>
  )
}

// ─── Review Mode Control Bar ─────────────────────────────────────────────────

const SPEEDS = [0.5, 1, 2, 4] as const
const CONFIRM_TIMEOUT_MS = 5000

function ReviewControlBar({
  isPlaying, speed, currentTime, totalDuration,
  onPlayPause, onRestart, onSpeedChange, onSeek,
  timelineEvents, isReviewing, onResumeLive, droppedEvents = 0, lostMarkers = 0,
}: ControlBarProps) {
  const { locale } = useLocale()
  const t = (key: MessageKey) => translate(locale, key)
  const scrubberRef = useRef<HTMLDivElement>(null)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)
  const clearBtnRef = useRef<HTMLButtonElement>(null)
  const confirmGroupRef = useRef<HTMLSpanElement>(null)
  /** Set when the prompt closes while focus should land back on the Clear history button */
  const refocusClearRef = useRef(false)
  const scrubberEvents = useScrubberEvents(timelineEvents, totalDuration)
  const progress = totalDuration > 0 ? Math.max(0, Math.min(1, currentTime / totalDuration)) : 0

  const seekFromClientX = useCallback((clientX: number) => {
    const rect = scrubberRef.current?.getBoundingClientRect()
    if (!rect || !onSeek) return
    onSeek(scrubberTimeFromX(clientX, rect.left, rect.width, totalDuration))
  }, [onSeek, totalDuration])

  // The destructive action needs a second click; the prompt disarms itself after a few seconds.
  // Keyboard focus follows the prompt: onto "Confirm clear" when it opens, back to "Clear history" when it closes.
  useEffect(() => {
    if (!confirmingClear) {
      if (refocusClearRef.current) {
        refocusClearRef.current = false
        clearBtnRef.current?.focus({ preventScroll: true })
      }
      return
    }
    confirmBtnRef.current?.focus({ preventScroll: true })
    const t = setTimeout(() => {
      const active = document.activeElement
      refocusClearRef.current = !active || active === document.body || !!confirmGroupRef.current?.contains(active)
      setConfirmingClear(false)
    }, CONFIRM_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [confirmingClear])

  const cancelClear = () => { refocusClearRef.current = true; setConfirmingClear(false) }

  const handleScrubberKeyDown = (e: React.KeyboardEvent) => {
    const target = scrubberKeyTarget(e.key, e.shiftKey, currentTime, totalDuration)
    if (target === null || !onSeek) return
    e.preventDefault()
    onSeek(target)
  }

  return (
    <div
      role="toolbar"
      lang={locale}
      aria-label={t('bar.toolbar')}
      data-control-bar
      className={BAR_CLASS}
      style={BAR_STYLE}
    >
      <div className="glass-card px-3 sm:px-5 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* Play/Pause */}
        <Button
          variant="bar"
          onClick={onPlayPause}
          data-primary-control=""
          aria-label={isPlaying ? t('bar.pause') : t('bar.play')}
          aria-keyshortcuts="Space"
          className="w-9 h-9 rounded-full flex items-center justify-center transition-all shrink-0 motion-safe:hover:scale-110"
          style={{
            background: isPlaying ? COLORS.playBtnActiveBg : COLORS.playBtnBg,
            border: `1.5px solid ${COLORS.controlBorder}`,
            boxShadow: COLORS.playBtnGlow,
          }}
        >
          <span aria-hidden="true" style={{ color: COLORS.textPrimary, fontSize: 14, marginLeft: isPlaying ? 0 : 2 }}>
            {isPlaying ? '⏸' : '▶'}
          </span>
        </Button>

        {/* Time */}
        <span className="text-xs font-mono shrink-0" style={{ color: COLORS.textPrimary, minWidth: 42 }}>
          {formatDuration(currentTime)}
        </span>

        <TruncationMarker dropped={droppedEvents} locale={locale} />
        <MarkersLostMarker lost={lostMarkers} locale={locale} />

        {/* Playback position slider (the Timeline is the panel opened by T) */}
        <div
          ref={scrubberRef}
          role="slider"
          tabIndex={0}
          aria-label={t('bar.position')}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.round(totalDuration)}
          aria-valuenow={Math.round(Math.min(currentTime, totalDuration))}
          aria-valuetext={scrubberValueText(currentTime, totalDuration, locale)}
          className={`flex-1 min-w-12 relative h-8 ${TOUCH_TARGET} flex items-center group cursor-pointer rounded touch-none ${FOCUS_RING}`}
          onKeyDown={handleScrubberKeyDown}
          onPointerDown={(e) => {
            e.preventDefault()
            e.currentTarget.setPointerCapture?.(e.pointerId)
            setIsScrubbing(true)
            seekFromClientX(e.clientX)
          }}
          onPointerMove={(e) => { if (isScrubbing) seekFromClientX(e.clientX) }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture?.(e.pointerId)
            setIsScrubbing(false)
          }}
          onPointerCancel={() => setIsScrubbing(false)}
        >
          <div
            className="w-full rounded-full relative transition-all duration-150 group-hover:h-2"
            style={{ height: isScrubbing ? 8 : 4, background: COLORS.controlTrack }}
          >
            {/* Progress fill */}
            <div
              className="h-full rounded-full motion-safe:transition-[width]"
              style={{
                width: `${progress * 100}%`,
                background: scrubberFill(),
              }}
            />
            <EventMarkers
              events={scrubberEvents}
              totalDuration={totalDuration}
              eventCount={scrubberEvents.length}
              className="opacity-90"
            />
          </div>

          {/* Playhead (24px hit area around the visible head) */}
          <div
            aria-hidden="true"
            className="absolute top-1/2 -translate-y-1/2 w-6 h-6 -ml-3 flex items-center justify-center pointer-events-none"
            style={{ left: `${progress * 100}%` }}
          >
            <div
              className="rounded-full transition-all duration-150"
              style={{
                width: isScrubbing ? 16 : 12,
                height: isScrubbing ? 16 : 12,
                background: COLORS.textPrimary,
                boxShadow: COLORS.scrubberHeadGlow,
              }}
            />
          </div>
        </div>

        {/* Duration */}
        <span className="text-2xs font-mono shrink-0" style={{ color: COLORS.textMuted }}>
          <span className="sr-only">{t('bar.duration')} </span>{formatDuration(totalDuration)}
        </span>

        {/* Speed controls */}
        <div role="group" aria-label={t('bar.speed.group')} className="flex items-center gap-0.5 shrink-0">
          {SPEEDS.map((s) => (
            <Button
              variant="bar"
              key={s}
              onClick={() => onSpeedChange(s)}
              aria-pressed={speed === s}
              aria-label={translate(locale, 'bar.speed', { s: formatSpeed(s, locale) })}
              className={`px-2 py-1 transition-all ${speed === s ? 'font-bold underline underline-offset-4' : ''}`}
              style={{
                background: speed === s ? COLORS.playBtnActiveBg : 'transparent',
                color: speed === s ? COLORS.textPrimary : COLORS.textMuted,
              }}
            >
              {formatSpeed(s, locale)}x
            </Button>
          ))}
        </div>

        {/* Resume Live */}
        {isReviewing && (
          <Button
            variant="bar"
            onClick={onResumeLive}
            aria-label={t('bar.resumeLive')}
            className="px-2.5 py-1 font-semibold transition-all motion-safe:hover:scale-105 shrink-0"
            style={{
              // An action, like Review: the live red belongs to the badge that says the flux is live
              background: COLORS.holoBg10,
              border: `1px solid ${COLORS.controlBorder}`,
              color: COLORS.textPrimary,
            }}
          >
            <span aria-hidden="true">▶ </span>{t('topbar.connection.watching')}
          </Button>
        )}

        {/* Clear history (destructive: two-step confirmation) */}
        {isReviewing && (confirmingClear ? (
          // Escape boundary of the confirmation (keys from its buttons bubble here): presentational and
          // box-less, so the named group carries no handler
          <span
            role="presentation"
            style={{ display: 'contents' }}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelClear() } }}
          >
          <span
            ref={confirmGroupRef}
            role="group"
            aria-label={t('bar.confirmGroup')}
            className="flex items-center gap-1 shrink-0"
          >
            <Button
              variant="bar"
              ref={confirmBtnRef}
              onClick={() => { setConfirmingClear(false); onRestart() }}
              className="px-2 py-1 font-semibold"
              style={{ background: COLORS.liveResumeBg, border: `1px solid ${COLORS.liveResumeBorder}`, color: COLORS.liveText }}
            >
              {t('bar.confirmClear')}
            </Button>
            <Button
              variant="bar"
              onClick={cancelClear}
              className="px-2 py-1"
              style={{ color: COLORS.textMuted }}
            >
              {t('bar.cancel')}
            </Button>
          </span>
          </span>
        ) : (
          <Button
            variant="bar"
            ref={clearBtnRef}
            onClick={() => setConfirmingClear(true)}
            aria-label={t('bar.clear')}
            title={t('bar.clear.title')}
            className="px-2 py-1 transition-all motion-safe:hover:scale-105 shrink-0"
            style={{ color: COLORS.textMuted, border: `1px solid ${COLORS.controlBorder}` }}
          >
            <span aria-hidden="true">⟲ </span>{t('bar.clear')}
          </Button>
        ))}
        <div ref={canvasControlsSlotRef} data-canvas-controls-slot="" className="contents" />
      </div>
    </div>
  )
}
