'use client'

import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { useAgentSimulation } from '@/hooks/use-agent-simulation'
import type { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import type { ToastInput } from '@/hooks/use-toasts'
import { TIMING } from '@/lib/agent-types'
import { formatMissedEvents } from '@/lib/chrome-utils'

type Simulation = ReturnType<typeof useAgentSimulation>
type Bridge = ReturnType<typeof useVSCodeBridge>

interface ReviewControlsInput {
  sim: Pick<Simulation, 'isPlaying' | 'maxTimeReached' | 'play' | 'pause' | 'restart' | 'setSpeed' | 'seekToTime' | 'saveSnapshot' | 'restoreSnapshot'>
  bridge: Pick<Bridge, 'pendingEvents' | 'selectedSessionIdRef' | 'flushSessionEvents'>
  isReviewing: boolean
  setIsReviewing: (reviewing: boolean) => void
  pushToast: (toast: ToastInput) => void
  /** Set while a seek settles, so audio effects do not replay what the scrub skipped over */
  seekingRef: MutableRefObject<boolean>
  /** Ask the canvas to fit the scene again */
  zoomToFit: () => void
  /** Start playing shortly after mount (not in the guided demo: the tour holds the scenario at each step's time) */
  autoPlay: boolean
  /** Events on the timeline: with none there is nothing to review (undefined = not known, no guard) */
  eventCount?: number
}

/** Live / review mode of the control bar: play-pause, resume live, seek, clear history, reload the session view */
export function useReviewControls({ sim, bridge, isReviewing, setIsReviewing, pushToast, seekingRef, zoomToFit, autoPlay, eventCount }: ReviewControlsInput) {
  const { isPlaying, maxTimeReached, play, pause, restart, setSpeed, seekToTime, saveSnapshot, restoreSnapshot } = sim

  useEffect(() => {
    if (!autoPlay) return
    const timer = setTimeout(() => play(), TIMING.autoPlayDelayMs)
    return () => clearTimeout(timer)
  }, [play, autoPlay])

  const announceReview = useCallback(() => {
    pushToast({ message: 'Review mode - press LIVE to resume', durationMs: 4000 })
  }, [pushToast])

  const nothingToReview = eventCount === 0
  const refuseEmptyReview = useCallback(() => {
    pushToast({ message: 'No events to review yet', durationMs: 4000 })
  }, [pushToast])

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      if (nothingToReview) { refuseEmptyReview(); return }
      pause()
      setIsReviewing(true)
      announceReview()
    } else {
      play()
    }
  }, [isPlaying, play, pause, announceReview, setIsReviewing, nothingToReview, refuseEmptyReview])

  const handleEnterReview = useCallback(() => {
    if (nothingToReview) { refuseEmptyReview(); return }
    pause()
    setIsReviewing(true)
    announceReview()
  }, [pause, announceReview, setIsReviewing, nothingToReview, refuseEmptyReview])

  // Speed only applies in review mode: in live mode it would silently distort the time axis.
  // The keys 1 to 4 are not silent there: a toast says why nothing changed (#411).
  const setSpeedInReview = useCallback((value: number) => {
    if (isReviewing) setSpeed(value)
    else pushToast({ message: 'Speed applies in review mode - pause to review first', durationMs: 4000 })
  }, [isReviewing, setSpeed, pushToast])

  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleResumeLive = useCallback(() => {
    // Events that arrived while paused are still queued: report them instead of silently compressing them
    const missed = formatMissedEvents(bridge.pendingEvents.length)
    if (missed) pushToast({ message: `Resumed live: ${missed.replace(' while reviewing', '')}`, durationMs: 5000 })
    setIsReviewing(false)
    // Speed chosen in review must not leak into live playback (no speed control there)
    setSpeed(1)
    seekToTime(maxTimeReached)
    zoomToFit()
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
    resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; play() }, TIMING.resumeLiveDelayMs)
  }, [seekToTime, setSpeed, maxTimeReached, play, bridge.pendingEvents, pushToast, setIsReviewing, zoomToFit])
  useEffect(() => () => { if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current) }, [])

  // "Clear history": keeps active agents, drops the scrubbable history. Undo restores a snapshot.
  const handleClearHistory = useCallback(() => {
    const snapshot = saveSnapshot()
    setIsReviewing(false)
    restart(true)
    pushToast({
      message: 'History cleared',
      actionLabel: 'Undo',
      onAction: () => restoreSnapshot(snapshot),
    })
  }, [restart, saveSnapshot, restoreSnapshot, pushToast, setIsReviewing])

  // Rebuild the canvas from the buffered events of the selected session (live mode)
  const handleReloadSessionEvents = useCallback(() => {
    const id = bridge.selectedSessionIdRef.current
    restart()
    if (id) bridge.flushSessionEvents(id)
  }, [restart, bridge.selectedSessionIdRef, bridge.flushSessionEvents])

  const handleSeek = (time: number) => {
    seekingRef.current = true
    pause()
    seekToTime(time)
    zoomToFit()
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
    resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; seekingRef.current = false }, TIMING.seekCompleteDelayMs)
  }

  return { handlePlayPause, handleEnterReview, setSpeedInReview, handleResumeLive, handleClearHistory, handleReloadSessionEvents, handleSeek }
}
