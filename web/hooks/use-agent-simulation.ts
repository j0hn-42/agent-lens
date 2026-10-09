'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Agent,
  Edge,
  SimulationEvent,
  type TimelineEntry,
} from '@/lib/agent-types'
import { isUnionSelection } from '@/lib/bridge-types'
import { MOCK_SCENARIO } from '@/lib/mock-scenario'
import { MODEL_FAMILY_CONTEXT, DEFAULT_CONTEXT_SIZE, FALLBACK_CONTEXT_SIZE, ANIM_SPEED, toolExpiryConfig, loadToolExpiryS } from '@/lib/canvas-constants'
import { createForceLayout, type ForceLayout } from './simulation/force-layout'

import type { SimulationState, UseAgentSimulationOptions } from './simulation/types'
import { createEmptyState, MAX_EVENT_LOG } from './simulation/types'
import { processEventBatch, eventSessionId, type ProcessEventContext } from './simulation/process-event'
import { findToolSlot } from './simulation/tool-slot'
import {
  createCatchUp, enqueueCatchUp, runCatchUpSlice, catchUpProgress, clearCatchUp, copyCatchUp,
  CATCH_UP_FRAME_BUDGET_MS, type CatchUpQueue, type CatchUpProgress,
} from './simulation/catch-up'
import { stampEventTimes, droppedFromLog, effectiveSpeed, applySessionOffsets } from './simulation/stamp-time'
import { agentKeyOf } from './simulation/types'
import { computeNextFrame } from './simulation/animate'
import { snapVisualState } from './simulation/snap-visual-state'
import { carryFreshness } from './simulation/freshness'
import { carryActiveTime } from './simulation/track-active-time'
import { observedSessions } from '@/lib/session-model'
import { trackForeignAttention, type ForeignAttention } from '@/lib/attention'
import { sameSessionProjects } from '@/lib/chrome-utils'

const EMPTY_PROJECTS: ReadonlyMap<string, { projectId: string; projectName: string }> = new Map()

/** ms between React state updates — canvas uses frameRef for smooth 60fps */
const UI_THROTTLE_MS = 250

export function useAgentSimulation(options: UseAgentSimulationOptions = {}) {
  const { useMockData = true, externalEvents, onExternalEventsConsumed, sessionFilter, sessionFilterRef: externalFilterRef, disable1MContext = false, isReviewing = false, sessionOffsetsRef, sessionProjects, hideInactive = false, catchUpFrameBudgetMs = CATCH_UP_FRAME_BUDGET_MS } = options
  const catchUpBudgetRef = useRef(catchUpFrameBudgetMs)
  catchUpBudgetRef.current = catchUpFrameBudgetMs
  const reviewingRef = useRef(isReviewing)
  reviewingRef.current = isReviewing
  const internalFilterRef = useRef(sessionFilter)
  internalFilterRef.current = sessionFilter
  const sessionFilterRef = externalFilterRef ?? internalFilterRef
  const foreignAttentionRef = useRef<ForeignAttention>(new Map())
  const [foreignAttention, setForeignAttention] = useState<ForeignAttention>(foreignAttentionRef.current)
  // The stored orphan-call expiry delay is read once after mount (server and first client render match)
  useEffect(() => { loadToolExpiryS() }, [])

  // ─── State management ──────────────────────────────────────────────────────
  // frameRef: source of truth, updated every animation frame (no React render).
  // state: React state for UI components, updated only on structural data changes
  //        (new events, play/pause, seek) — NOT on every animation tick.
  // Canvas reads from frameRef directly for 60fps rendering.
  const [state, setState] = useState<SimulationState>(createEmptyState)
  const frameRef = useRef<SimulationState>(createEmptyState())
  /** Throttle React UI updates to ~4/sec — canvas stays smooth via frameRef */
  const lastUIUpdateRef = useRef(0)
  /** frameRef holds events the React state does not show yet: published as soon as the throttle allows (#213) */
  const uiDirtyRef = useRef(false)

  /** Update both frameRef and React state (triggers UI re-render) */
  const commitState = useCallback((next: SimulationState) => {
    frameRef.current = next
    uiDirtyRef.current = false
    setState(next)
  }, [])

  const animationRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)
  /** d3-force cluster layout: positions are copied into frameRef after every tick (see force-layout.ts) */
  const layoutRef = useRef<ForceLayout | null>(null)
  const blockIdCounter = useRef(0)
  const skipForceSyncRef = useRef(false)
  const animateRef = useRef<(timestamp: number) => void>(() => {})

  // ─── d3-force simulation ─────────────────────────────────────────────────
  useEffect(() => {
    const layout = createForceLayout()
    layoutRef.current = layout
    return () => { layout.destroy(); layoutRef.current = null }
  }, [])

  // The layout centres a parent on the children that are drawn: it follows 'Hide inactive agents'
  useEffect(() => { layoutRef.current?.setHideInactive(hideInactive) }, [hideInactive])

  // ─── Force simulation sync ───────────────────────────────────────────────
  // Rebuilds the nodes and anchors, runs the initial ticks and writes the positions into frameRef.
  // It reads frameRef (current positions), not the snapshot it is called with: syncs are deferred
  // (setTimeout) and the snapshot may be older than the frames that ran in between.
  const sessionProjectsRef = useRef(sessionProjects)
  sessionProjectsRef.current = sessionProjects
  const syncForceSimulation = useCallback((_agents: Map<string, Agent>, _edges: Edge[]) => {
    const layout = layoutRef.current
    if (!layout) return
    frameRef.current = layout.syncState(frameRef.current, sessionProjectsRef.current)
  }, [])
  // A session learns its project after its agents appeared: lay the clusters out again. A new Map with the
  // same content (the session list changes on every start / end / label) must not: the sync rebuilds every
  // node, runs its ticks on the main thread and shakes a layout that had settled (#105).
  const syncedProjectsRef = useRef(sessionProjects)
  useEffect(() => {
    if (sameSessionProjects(syncedProjectsRef.current ?? EMPTY_PROJECTS, sessionProjects ?? EMPTY_PROJECTS)) return
    syncedProjectsRef.current = sessionProjects
    syncForceSimulation(frameRef.current.agents, frameRef.current.edges)
  }, [sessionProjects, syncForceSimulation])

  const getContextWindowSize = useCallback((modelId?: string): number => {
    if (!modelId) return disable1MContext ? DEFAULT_CONTEXT_SIZE : FALLBACK_CONTEXT_SIZE
    const id = modelId.toLowerCase()
    for (const { pattern, size } of MODEL_FAMILY_CONTEXT) {
      if (pattern.test(id)) return disable1MContext ? Math.min(size, DEFAULT_CONTEXT_SIZE) : size
    }
    return DEFAULT_CONTEXT_SIZE
  }, [disable1MContext])

  // A burst of spawns schedules one deferred layout sync per agent: the first one runs, the others queued
  // behind it are skipped (each sync rebuilds every node, and it reads frameRef, so one sees every spawn)
  const forceSyncDoneRef = useRef(false)
  const requestForceSync = useCallback((agents: Map<string, Agent>, edges: Edge[]) => {
    if (forceSyncDoneRef.current) return
    forceSyncDoneRef.current = true
    setTimeout(() => { forceSyncDoneRef.current = false }, 0)
    syncForceSimulation(agents, edges)
  }, [syncForceSimulation])

  const makeContext = useCallback((): ProcessEventContext => ({
    syncForceSimulation: requestForceSync,
    findToolSlot,
    getContextWindowSize,
    blockIdCounter,
    skipForceSync: skipForceSyncRef.current,
  }), [requestForceSync, getContextWindowSize])

  // ─── History catch-up (#210) ─────────────────────────────────────────────
  // Received events wait in this queue and are reduced a frame budget at a time, so a burst (switch to
  // 'All', relay replay) never blocks the page; its progress is published for the loading indicator.
  const catchUpRef = useRef<CatchUpQueue>(createCatchUp())
  const [catchUp, setCatchUp] = useState<CatchUpProgress | null>(null)
  const publishedCatchUpRef = useRef<CatchUpProgress | null>(null)
  /** Publish the progress: always when a backlog starts or ends, otherwise only when `refresh` */
  const publishCatchUp = useCallback((refresh: boolean) => {
    const next = catchUpProgress(catchUpRef.current)
    const prev = publishedCatchUpRef.current
    if ((next === null) !== (prev === null) || (refresh && next && (next.done !== prev?.done || next.total !== prev?.total))) {
      publishedCatchUpRef.current = next
      setCatchUp(next)
    }
  }, [])

  // ─── Animation loop ──────────────────────────────────────────────────────
  // Reads/writes frameRef directly. Only calls commitState when new events
  // are processed, so React only re-renders UI on structural data changes.
  const animate = useCallback((timestamp: number) => {
    // Cap at 60fps to reduce CPU/GPU load
    const elapsed = timestamp - lastTimeRef.current
    if (lastTimeRef.current && elapsed < ANIM_SPEED.minFrameInterval) {
      animationRef.current = requestAnimationFrame(animateRef.current)
      return
    }

    if (!lastTimeRef.current) lastTimeRef.current = timestamp
    const deltaTime = Math.min((timestamp - lastTimeRef.current) / 1000, ANIM_SPEED.maxDeltaTime)
    lastTimeRef.current = timestamp

    const prev = frameRef.current
    if (!prev.isPlaying) {
      // Paused (review): leave external events queued so none are lost and the
      // resume toast can report the real count.
      animationRef.current = requestAnimationFrame(animateRef.current)
      return
    }

    // Snapshot and consume external events OUTSIDE the main processing
    // to avoid React strict mode double-invocation clearing them
    let capturedEvents: SimulationEvent[] | null = null
    if (externalEvents && externalEvents.length > 0 && !useMockData) {
      capturedEvents = externalEvents.slice()
      onExternalEventsConsumed?.()
    }

    // Speed only applies in review: outside it the clock runs at 1x
    const speed = effectiveSpeed(prev.speed, reviewingRef.current)
    let newTime = prev.currentTime + deltaTime * speed
    let maxT = Math.max(prev.maxTimeReached, newTime)
    let newEventIndex = prev.eventIndex

    // Process events — thread state through each event
    let currentState = prev
    const newEvents: SimulationEvent[] = []

    const ctx = makeContext()
    if (useMockData) {
      while (newEventIndex < MOCK_SCENARIO.length && MOCK_SCENARIO[newEventIndex].time <= newTime) {
        observedSessions.mark(MOCK_SCENARIO[newEventIndex].sessionId)
        newEvents.push(MOCK_SCENARIO[newEventIndex])
        newEventIndex++
      }
      currentState = processEventBatch(newEvents, currentState, ctx).state
    } else {
      const log = currentState.eventLog
      const from = newEventIndex
      while (newEventIndex < log.length && log[newEventIndex].time <= newTime) newEventIndex++
      currentState = processEventBatch(log.slice(from, newEventIndex), currentState, ctx).state
    }

    // Process captured external events (snapshotted outside the main
    // processing to avoid React strict mode double-invocation issues)
    if (capturedEvents) {
      // No filter, the 'All' pseudo session or a team pseudo selection (union modes: the bridge already
      // delivers only the right sessions) accept events of every delivered session
      const activeFilter = sessionFilterRef.current
      const union = !activeFilter || isUnionSelection(activeFilter)
      const accepted = capturedEvents.filter(e => union || !e.sessionId || e.sessionId === activeFilter)
      // Union views put every session on one wall-clock axis (events are relative to their own session start)
      const offsetEvents = activeFilter && union ? applySessionOffsets(accepted, sessionOffsetsRef?.current) : accepted
      const lastLogged = currentState.eventLog[currentState.eventLog.length - 1]
      // Real event times, kept monotonic so the log stays seekable
      const stamped = stampEventTimes(offsetEvents, lastLogged ? lastLogged.time : 0, newTime)
      // Every received event proves its session is heard from, even when the view filters it out
      for (const e of capturedEvents) observedSessions.mark(e.sessionId)
      // Blocked agents of the sessions this view filters out still count in the attention counter (every event is
      // followed so a request answered while its session was in view does not linger)
      const tracked = trackForeignAttention(foreignAttentionRef.current, capturedEvents, Date.now())
      if (tracked !== foreignAttentionRef.current) { foreignAttentionRef.current = tracked; setForeignAttention(tracked) }
      // Queued with their reception time: the agents an event touches are heard from then (freshness), and a
      // non-replayed event moves their active span (a replayed one carries no wall-clock proof of work)
      enqueueCatchUp(catchUpRef.current, stamped, Date.now())
    }

    // Catch up the received events within the frame budget; the rest waits for the next frames
    if (catchUpProgress(catchUpRef.current)) {
      const slice = runCatchUpSlice(catchUpRef.current, currentState, ctx, { budgetMs: catchUpBudgetRef.current, now: () => performance.now() })
      currentState = slice.state
      for (const e of slice.processed) newEvents.push(e)
      // Sync simulation clock to latest event so active state renders correctly
      newTime = Math.max(newTime, currentState.currentTime)
      maxT = Math.max(maxT, newTime)
    }

    // Append new events to log
    if (newEvents.length > 0) {
      let newLog = currentState.eventLog.concat(newEvents)
      const dropped = droppedFromLog(currentState.eventLog.length, newEvents.length, MAX_EVENT_LOG)
      if (dropped > 0) {
        newLog = newLog.slice(dropped)
        currentState = { ...currentState, droppedEvents: currentState.droppedEvents + dropped }
      }
      // In mock mode, eventIndex tracks position in MOCK_SCENARIO (not the log).
      // In live mode, eventIndex tracks position in the event log.
      if (!useMockData) {
        newEventIndex = newLog.length
      }
      currentState = { ...currentState, eventLog: newLog }
    }

    currentState = { ...currentState, eventIndex: newEventIndex }

    const result = computeNextFrame(prev, deltaTime, newTime, maxT, currentState, {
      useMockData,
      mockScenarioLength: MOCK_SCENARIO.length,
      mockScenarioEndTime: MOCK_SCENARIO.length > 0 ? MOCK_SCENARIO[MOCK_SCENARIO.length - 1].time : 0,
      speed,
      toolExpiryS: toolExpiryConfig.seconds,
    })

    // Write to frameRef (canvas reads this every frame)
    frameRef.current = result

    // Force tick: copies the simulation positions into the agents of frameRef (no-op once settled)
    if (layoutRef.current) frameRef.current = layoutRef.current.stepState(frameRef.current)

    // Throttle React re-renders — UI updates at ~4/sec, canvas stays smooth via frameRef
    // A commit the throttle skips is not lost: the flag is checked on every frame, so the React state catches up
    // with frameRef at most UI_THROTTLE_MS later even when no further event arrives
    if (newEvents.length > 0) uiDirtyRef.current = true
    let uiRefresh = false
    if (uiDirtyRef.current && (!lastUIUpdateRef.current || timestamp - lastUIUpdateRef.current >= UI_THROTTLE_MS)) {
      setState(frameRef.current)
      lastUIUpdateRef.current = timestamp
      uiDirtyRef.current = false
      uiRefresh = true
    }
    publishCatchUp(uiRefresh)

    animationRef.current = requestAnimationFrame(animateRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionFilter intentionally omitted; we read sessionFilterRef.current
  }, [makeContext, publishCatchUp, useMockData, externalEvents, onExternalEventsConsumed])

  animateRef.current = animate

  useEffect(() => {
    const loop = (timestamp: number) => animateRef.current(timestamp)
    if (state.isPlaying) {
      lastTimeRef.current = 0
      animationRef.current = requestAnimationFrame(loop)
    } else if (animationRef.current) {
      cancelAnimationFrame(animationRef.current)
    }
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current) }
  }, [state.isPlaying])

  // ─── Playback controls ───────────────────────────────────────────────────
  const play = useCallback(() => {
    const next = { ...frameRef.current, isPlaying: true }
    commitState(next)
  }, [commitState])

  const pause = useCallback(() => {
    const next = { ...frameRef.current, isPlaying: false }
    commitState(next)
  }, [commitState])

  const setSpeed = useCallback((speed: number) => {
    frameRef.current = { ...frameRef.current, speed }
    setState(prev => ({ ...prev, speed }))
  }, [])

  const restart = useCallback((keepActive = false) => {
    blockIdCounter.current = 0
    // The backlog belongs to the view being left
    clearCatchUp(catchUpRef.current)
    publishCatchUp(true)
    if (!keepActive) {
      commitState(createEmptyState({ isPlaying: true, speed: frameRef.current.speed }))
      return
    }
    // Keep active agents but clear completed state and visual history
    const prev = frameRef.current
    const agents = new Map<string, Agent>()
    for (const [id, agent] of prev.agents) {
      if (agent.state !== 'complete') {
        agents.set(id, { ...agent, toolCalls: 0, toolErrors: 0, messageBubbles: [], timeAlive: 0 })
      }
    }

    const edges = prev.edges.filter(e =>
      e.type === 'parent-child' && agents.has(e.from) && agents.has(e.to)
    )

    const timelineEntries = new Map<string, TimelineEntry>()
    for (const [id, entry] of prev.timelineEntries) {
      if (agents.has(id)) {
        timelineEntries.set(id, { ...entry, blocks: [] })
      }
    }

    const conversations: SimulationState['conversations'] = new Map()
    for (const id of agents.keys()) conversations.set(id, [])

    const keptLocalIds = new Set(Array.from(agents.values()).map(a => a.id))
    const eventLog = prev.eventLog.filter(e =>
      e.type === 'agent_spawn' && typeof e.payload?.name === 'string'
      && keptLocalIds.has(agentKeyOf(eventSessionId(e), e.payload.name))
    )

    const next = {
      ...createEmptyState({ isPlaying: true, speed: prev.speed }),
      agents, edges, timelineEntries, conversations,
      eventLog, eventIndex: eventLog.length,
    }
    commitState(next)
    setTimeout(() => syncForceSimulation(next.agents, next.edges), 0)
  }, [syncForceSimulation, commitState, publishCatchUp])

  const updateAgentPosition = useCallback((agentId: string, x: number, y: number) => {
    // Drag updates — write to frameRef only (canvas reads it, no React render)
    const prev = frameRef.current
    const newAgents = new Map(prev.agents)
    const agent = newAgents.get(agentId)
    if (agent) newAgents.set(agentId, { ...agent, x, y, pinned: true })
    frameRef.current = { ...prev, agents: newAgents }

    layoutRef.current?.pin(agentId, x, y)
  }, [])

  /** Seek to a specific time — replays events from scratch up to targetTime */
  const seekToTime = useCallback((targetTime: number) => {
    const prev = frameRef.current
    const events = useMockData ? MOCK_SCENARIO : prev.eventLog

    let replayState = createEmptyState({
      speed: prev.speed,
      eventLog: prev.eventLog,
      maxTimeReached: prev.maxTimeReached,
      droppedEvents: prev.droppedEvents,
    })

    skipForceSyncRef.current = true
    blockIdCounter.current = 0
    let newEventIndex = 0
    while (newEventIndex < events.length && events[newEventIndex].time <= targetTime) newEventIndex++
    // One batch: the collections are copied once for the whole replay (#210)
    replayState = processEventBatch(events.slice(0, newEventIndex), replayState, makeContext(), { advanceClock: true }).state
    skipForceSyncRef.current = false

    // The replay rebuilt the agents from the log: keep the wall-clock freshness they had
    replayState = { ...replayState, agents: carryActiveTime(prev.agents, carryFreshness(prev.agents, replayState.agents)) }
    replayState = snapVisualState(replayState, targetTime, toolExpiryConfig.seconds)
    replayState.currentTime = targetTime
    replayState.eventIndex = newEventIndex

    commitState(replayState)
    setTimeout(() => syncForceSimulation(replayState.agents, replayState.edges), 0)
  }, [makeContext, useMockData, syncForceSimulation, commitState])

  // ─── Session state save/restore ──────────────────────────────────────────
  // A snapshot keeps the events still waiting to be caught up: they were already handed over by the bridge
  const saveSnapshot = useCallback((): { simState: SimulationState; blockId: number; catchUp: CatchUpQueue } => ({
    simState: frameRef.current,
    blockId: blockIdCounter.current,
    catchUp: copyCatchUp(catchUpRef.current),
  }), [])

  const restoreSnapshot = useCallback((snapshot: { simState: SimulationState; blockId: number; catchUp?: CatchUpQueue }) => {
    blockIdCounter.current = snapshot.blockId
    catchUpRef.current = snapshot.catchUp ? copyCatchUp(snapshot.catchUp) : createCatchUp()
    publishCatchUp(true)
    commitState({ ...snapshot.simState, isPlaying: true })
    setTimeout(() => syncForceSimulation(snapshot.simState.agents, snapshot.simState.edges), 0)
  }, [syncForceSimulation, commitState, publishCatchUp])

  return {
    // Canvas reads frameRef directly for 60fps rendering
    frameRef,
    // UI components use React state (updated only on events/user actions)
    agents: state.agents, toolCalls: state.toolCalls,
    particles: state.particles, edges: state.edges,
    discoveries: state.discoveries,
    fileAttention: state.fileAttention,
    timelineEntries: state.timelineEntries,
    currentTime: state.currentTime, isPlaying: state.isPlaying, speed: state.speed,
    maxTimeReached: state.maxTimeReached,
    conversations: state.conversations,
    links: state.links,
    /** Agent Teams seen in this view (team_info events), by team name */
    teams: state.teams,
    /** Events dropped from the start of the history (MAX_EVENT_LOG) */
    droppedEvents: state.droppedEvents,
    /** Conversation messages dropped per agentKey (MAX_CONVERSATION_MESSAGES) */
    droppedMessages: state.droppedMessages,
    /** Usage that belongs to no single agent (orphan / ambiguous), see lib/attribution */
    unattributed: state.unattributed,
    /** Agents of other sessions blocked on a permission (see lib/attention) */
    foreignAttention,
    /** Received events still being caught up (#210), null when none wait */
    catchUp,
    play, pause, restart, setSpeed, seekToTime,
    updateAgentPosition,
    saveSnapshot, restoreSnapshot,
  }
}
