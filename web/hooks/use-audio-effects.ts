import { useRef, useEffect, useCallback } from 'react'
import { useUiPreferences } from '@/hooks/use-ui-preferences'
import { AudioEngine } from '@/lib/audio-engine'
import type { Agent, ToolCallNode } from '@/lib/agent-types'
import { detectStateChanges } from '@/components/agent-visualizer/canvas/detect-state-changes'

export function useAudioEffects(
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  isReviewing: boolean,
) {
  const audioRef = useRef<AudioEngine | null>(null)
  // The sound choice lives in the preference blob (#372): 'Reset preferences' mutes it again
  const { prefs, setPref } = useUiPreferences()
  const isMuted = !prefs.soundOn
  const isMutedRef = useRef(isMuted)
  isMutedRef.current = isMuted
  const seekingRef = useRef(false)
  const prevToolStatesRef = useRef<Map<string, string>>(new Map())
  const prevAgentStatesRef = useRef<Map<string, string>>(new Map())

  // Audio engine lifecycle
  useEffect(() => {
    const engine = new AudioEngine()
    engine.setMuted(isMutedRef.current)
    audioRef.current = engine
    return () => { audioRef.current?.dispose(); audioRef.current = null }
  }, [])
  // The engine follows the stored choice (a toggle, a reset, another tab)
  useEffect(() => { audioRef.current?.setMuted(isMuted) }, [isMuted])

  // Detect tool/agent state transitions and play sounds (live mode only)
  useEffect(() => {
    if (seekingRef.current || !audioRef.current || isReviewing) return
    const audio = audioRef.current

    const { transitions, newAgentStates, newToolStates } = detectStateChanges(
      agents, toolCalls,
      prevAgentStatesRef.current, prevToolStatesRef.current,
    )
    prevAgentStatesRef.current = newAgentStates
    prevToolStatesRef.current = newToolStates

    for (const t of transitions) {
      switch (t.kind) {
        case 'agent_spawn':   audio.playAgentSpawn(); break
        case 'agent_complete': audio.playAgentComplete(); break
        case 'tool_start':    audio.playToolStart(); break
        case 'tool_complete': audio.playToolEnd(); break
        case 'tool_error':    audio.playError(); break
      }
    }
  }, [agents, toolCalls, isReviewing])

  const handleToggleMute = useCallback(() => {
    // The engine is set right away: its audio context must start inside the user's gesture
    const nowMuted = !isMutedRef.current
    audioRef.current?.setMuted(nowMuted)
    setPref('soundOn', !nowMuted)
  }, [setPref])

  return { isMuted, seekingRef, handleToggleMute }
}
