'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Agent,
  ToolCallNode,
  Edge,
  SimulationEvent,
  type TimelineEntry,
} from '@/lib/agent-types'
import { isUnionSelection } from '@/lib/bridge-types'
import { MOCK_SCENARIO } from '@/lib/mock-scenario'
import { TOOL_CARD_W, TOOL_CARD_H, TOOL_SLOT, BUBBLE_VISIBLE_S, MODEL_FAMILY_CONTEXT, DEFAULT_CONTEXT_SIZE, FALLBACK_CONTEXT_SIZE, ANIM_SPEED } from '@/lib/canvas-constants'
import { createForceLayout, type ForceLayout } from './simulation/force-layout'

import type { SimulationState, UseAgentSimulationOptions } from './simulation/types'
import { createEmptyState, MAX_EVENT_LOG } from './simulation/types'
import { processEvent, eventSessionId, type ProcessEventContext } from './simulation/process-event'
import { stampEventTimes, droppedFromLog, effectiveSpeed, applySessionOffsets } from './simulation/stamp-time'
import { agentKeyOf } from './simulation/types'
import { computeNextFrame } from './simulation/animate'
import { snapVisualState } from './simulation/snap-visual-state'
import { stampTouchedAgents, carryFreshness } from './simulation/freshness'
import { observedSessions } from '@/lib/session-model'

/** ms between React state updates — canvas uses frameRef for smooth 60fps */
const UI_THROTTLE_MS = 250

export function useAgentSimulation(options: UseAgentSimulationOptions = {}) {
  const { useMockData = true, externalEvents, onExternalEventsConsumed, sessionFilter, sessionFilterRef: externalFilterRef, disable1MContext = false, isReviewing = false, sessionOffsetsRef } = options
  const reviewingRef = useRef(isReviewing)
  reviewingRef.current = isReviewing
  const internalFilterRef = useRef(sessionFilter)
  internalFilterRef.current = sessionFilter
  const sessionFilterRef = externalFilterRef ?? internalFilterRef

  // ─── State management ──────────────────────────────────────────────────────
  // frameRef: source of truth, updated every animation frame (no React render).
  // state: React state for UI components, updated only on structural data changes
  //        (new events, play/pause, seek) — NOT on every animation tick.
  // Canvas reads from frameRef directly for 60fps rendering.
  const [state, setState] = useState<SimulationState>(createEmptyState)
  const frameRef = useRef<SimulationState>(createEmptyState())

  /** Update both frameRef and React state (triggers UI re-render) */
  const commitState = useCallback((next: SimulationState) => {
    frameRef.current = next
    setState(next)
  }, [])

  const animationRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)
  /** d3-force cluster layout: positions are copied into frameRef after every tick (see force-layout.ts) */
  const layoutRef = useRef<ForceLayout | null>(null)
  const blockIdCounter = useRef(0)
  const skipForceSyncRef = useRef(false)
  const animateRef = useRef<(timestamp: number) => void>(() => {})
  /** Throttle React UI updates to ~4/sec — canvas stays smooth via frameRef */
  const lastUIUpdateRef = useRef(0)

  // ─── d3-force simulation ─────────────────────────────────────────────────
  useEffect(() => {
    const layout = createForceLayout()
    layoutRef.current = layout
    return () => { layout.destroy(); layoutRef.current = null }
  }, [])

  // ─── Force simulation sync ───────────────────────────────────────────────
  // Rebuilds the nodes and anchors, runs the initial ticks and writes the positions into frameRef.
  // It reads frameRef (current positions), not the snapshot it is called with: syncs are deferred
  // (setTimeout) and the snapshot may be older than the frames that ran in between.
  const syncForceSimulation = useCallback((_agents: Map<string, Agent>, _edges: Edge[]) => {
    const layout = layoutRef.current
    if (!layout) return
    frameRef.current = layout.syncState(frameRef.current)
  }, [])

  // ─── Tool slot placement ─────────────────────────────────────────────────
  const findToolSlot = useCallback((
    agent: Agent, agents: Map<string, Agent>,
    toolCalls: Map<string, ToolCallNode>, currentTime: number,
  ): { x: number; y: number } => {
    const visibleBubbles = agent.messageBubbles.filter(b => currentTime - b.time <= BUBBLE_VISIBLE_S)
    const bubbleRect = visibleBubbles.length > 0 ? {
      x1: agent.x + 30, y1: agent.y - 30,
      x2: agent.x + 300, y2: agent.y - 20 + visibleBubbles.length * 60 + 20,
    } : null

    const overlaps = (cx: number, cy: number) => {
      if (bubbleRect && cx + TOOL_CARD_W / 2 > bubbleRect.x1 && cx - TOOL_CARD_W / 2 < bubbleRect.x2
        && cy + TOOL_CARD_H / 2 > bubbleRect.y1 && cy - TOOL_CARD_H / 2 < bubbleRect.y2) return true
      for (const tc of toolCalls.values()) {
        if (Math.abs(cx - tc.x) < TOOL_CARD_W && Math.abs(cy - tc.y) < TOOL_CARD_H) return true
      }
      return false
    }

    let outAngle = -Math.PI / 2
    if (agent.parentId) {
      const parent = agents.get(agent.parentId)
      if (parent) {
        outAngle = Math.atan2(agent.y - parent.y, agent.x - parent.x)
      }
    }

    for (let ring = 1; ring <= TOOL_SLOT.maxRings; ring++) {
      const dist = TOOL_SLOT.baseDistance + ring * TOOL_SLOT.ringIncrement
      const steps = TOOL_SLOT.baseSteps + ring * TOOL_SLOT.stepsPerRing
      for (let i = 0; i < steps; i++) {
        const sweep = (i / (steps - 1) - 0.5) * Math.PI
        const angle = outAngle + sweep
        const cx = agent.x + Math.cos(angle) * dist
        const cy = agent.y + Math.sin(angle) * dist
        if (!overlaps(cx, cy)) return { x: cx, y: cy }
      }
    }
    return { x: agent.x + Math.cos(outAngle) * TOOL_SLOT.fallbackDistance, y: agent.y + Math.sin(outAngle) * TOOL_SLOT.fallbackDistance }
  }, [])

  const getContextWindowSize = useCallback((modelId?: string): number => {
    if (!modelId) return disable1MContext ? DEFAULT_CONTEXT_SIZE : FALLBACK_CONTEXT_SIZE
    const id = modelId.toLowerCase()
    for (const { pattern, size } of MODEL_FAMILY_CONTEXT) {
      if (pattern.test(id)) return disable1MContext ? Math.min(size, DEFAULT_CONTEXT_SIZE) : size
    }
    return DEFAULT_CONTEXT_SIZE
  }, [disable1MContext])

  const processEventWithContext = useCallback((event: SimulationEvent, prev: SimulationState): SimulationState => {
    const ctx: ProcessEventContext = {
      syncForceSimulation,
      findToolSlot,
      getContextWindowSize,
      blockIdCounter,
      skipForceSync: skipForceSyncRef.current,
    }
    return processEvent(event, prev, ctx)
  }, [syncForceSimulation, findToolSlot, getContextWindowSize])

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

    if (useMockData) {
      while (newEventIndex < MOCK_SCENARIO.length && MOCK_SCENARIO[newEventIndex].time <= newTime) {
        const evt = MOCK_SCENARIO[newEventIndex]
        currentState = processEventWithContext(evt, currentState)
        newEvents.push(evt)
        newEventIndex++
      }
    } else {
      while (newEventIndex < currentState.eventLog.length && currentState.eventLog[newEventIndex].time <= newTime) {
        const evt = currentState.eventLog[newEventIndex]
        currentState = processEventWithContext(evt, currentState)
        newEventIndex++
      }
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
      const receivedAt = Date.now()
      for (const timedEvent of stamped) {
        currentState = { ...currentState, currentTime: timedEvent.time }
        const before = currentState
        currentState = processEventWithContext(timedEvent, currentState)
        // Freshness: the agents this event touched are heard from now (wall clock)
        currentState = { ...currentState, agents: stampTouchedAgents(before.agents, currentState.agents, receivedAt) }
        newEvents.push(timedEvent)
      }
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
    })

    // Write to frameRef (canvas reads this every frame)
    frameRef.current = result

    // Force tick: copies the simulation positions into the agents of frameRef (no-op once settled)
    if (layoutRef.current) frameRef.current = layoutRef.current.stepState(frameRef.current)

    // Throttle React re-renders — UI updates at ~4/sec, canvas stays smooth via frameRef
    if (newEvents.length > 0) {
      if (!lastUIUpdateRef.current || timestamp - lastUIUpdateRef.current >= UI_THROTTLE_MS) {
        setState(frameRef.current)
        lastUIUpdateRef.current = timestamp
      }
    }

    animationRef.current = requestAnimationFrame(animateRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionFilter intentionally omitted; we read sessionFilterRef.current
  }, [processEventWithContext, useMockData, externalEvents, onExternalEventsConsumed])

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
    if (!keepActive) {
      commitState(createEmptyState({ isPlaying: true, speed: frameRef.current.speed }))
      return
    }
    // Keep active agents but clear completed state and visual history
    const prev = frameRef.current
    const agents = new Map<string, Agent>()
    for (const [id, agent] of prev.agents) {
      if (agent.state !== 'complete') {
        agents.set(id, { ...agent, toolCalls: 0, messageBubbles: [], timeAlive: 0 })
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
  }, [syncForceSimulation, commitState])

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
    for (const event of events) {
      if (event.time > targetTime) break
      replayState.currentTime = event.time
      replayState = { ...processEventWithContext(event, replayState), currentTime: event.time }
      newEventIndex++
    }
    skipForceSyncRef.current = false

    // The replay rebuilt the agents from the log: keep the wall-clock freshness they had
    replayState = { ...replayState, agents: carryFreshness(prev.agents, replayState.agents) }
    replayState = snapVisualState(replayState, targetTime)
    replayState.currentTime = targetTime
    replayState.eventIndex = newEventIndex

    commitState(replayState)
    setTimeout(() => syncForceSimulation(replayState.agents, replayState.edges), 0)
  }, [processEventWithContext, useMockData, syncForceSimulation, commitState])

  // ─── Session state save/restore ──────────────────────────────────────────
  const saveSnapshot = useCallback((): { simState: SimulationState; blockId: number } => ({
    simState: frameRef.current,
    blockId: blockIdCounter.current,
  }), [])

  const restoreSnapshot = useCallback((snapshot: { simState: SimulationState; blockId: number }) => {
    blockIdCounter.current = snapshot.blockId
    commitState({ ...snapshot.simState, isPlaying: true })
    setTimeout(() => syncForceSimulation(snapshot.simState.agents, snapshot.simState.edges), 0)
  }, [syncForceSimulation, commitState])

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
    play, pause, restart, setSpeed, seekToTime,
    updateAgentPosition,
    saveSnapshot, restoreSnapshot,
  }
}
