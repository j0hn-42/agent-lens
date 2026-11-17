'use client'

/**
 * Procedural audio engine using Web Audio API.
 * All sounds are synthesized — no audio files needed.
 */

export class AudioEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private _muted = true  // default muted
  private _volume = 0.5

  /**
   * Lazily creates the context. Returns without one while muted or before any
   * user gesture: the browser would refuse to start it and log a warning per call.
   */
  private ensureContext() {
    if (this._muted) return
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume()
      return
    }
    const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined
    if (activation && !activation.hasBeenActive) return
    this.ctx = new AudioContext()
    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.value = this._muted ? 0 : this._volume
    this.masterGain.connect(this.ctx.destination)
  }

  get muted() { return this._muted }

  setMuted(muted: boolean) {
    this._muted = muted
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : this._volume, this.ctx.currentTime, 0.05)
    }
  }

  toggleMute() {
    this.setMuted(!this._muted)
    return this._muted
  }

  /** Soft click — tool starts executing */
  private playClick(freq: number, vol: number) {
    this.ensureContext()
    if (!this.ctx || !this.masterGain) return

    const now = this.ctx.currentTime
    // Use a short noise-like burst via high-freq oscillator that decays instantly
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    const filter = this.ctx.createBiquadFilter()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, now)
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, now + 0.025)
    filter.type = 'lowpass'
    filter.frequency.value = 800
    filter.Q.value = 0.5
    gain.gain.setValueAtTime(vol, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.025)
    osc.connect(filter)
    filter.connect(gain)
    gain.connect(this.masterGain)
    osc.start(now)
    osc.stop(now + 0.025)
  }

  playToolStart() { this.playClick(480, 0.06) }
  playToolEnd() { this.playClick(600, 0.08) }

  /** Soft rising shimmer — new agent spawned */
  playAgentSpawn() {
    this.ensureContext()
    if (!this.ctx || !this.masterGain) return

    const now = this.ctx.currentTime
    // Two-note rising fifth (G5 → D6), very soft and brief
    const notes = [784, 1175]
    for (let i = 0; i < notes.length; i++) {
      const osc = this.ctx.createOscillator()
      const gain = this.ctx.createGain()
      const start = now + i * 0.06
      osc.type = 'sine'
      osc.frequency.value = notes[i]
      gain.gain.setValueAtTime(0.001, start)
      gain.gain.linearRampToValueAtTime(0.03, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2)
      osc.connect(gain)
      gain.connect(this.masterGain!)
      osc.start(start)
      osc.stop(start + 0.2)
    }
  }

  /** Gentle arpeggiated chord — agent completes its task */
  playAgentComplete() {
    this.ensureContext()
    if (!this.ctx || !this.masterGain) return

    const notes = [261.63, 329.63, 392.00, 493.88] // Cmaj7: C4, E4, G4, B4
    const now = this.ctx.currentTime
    const stagger = 0.07 // arpeggiate notes slightly

    for (let i = 0; i < notes.length; i++) {
      const osc = this.ctx.createOscillator()
      const gain = this.ctx.createGain()
      const start = now + i * stagger
      osc.type = 'sine'
      osc.frequency.value = notes[i]
      // Soft attack per note, gentle sustain, smooth fade
      gain.gain.setValueAtTime(0.001, start)
      gain.gain.linearRampToValueAtTime(0.022, start + 0.03)
      gain.gain.setValueAtTime(0.022, start + 0.25)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5)
      osc.connect(gain)
      gain.connect(this.masterGain!)
      osc.start(start)
      osc.stop(start + 0.5)
    }
  }

  /** Soft low tone — error occurred */
  playError() {
    this.ensureContext()
    if (!this.ctx || !this.masterGain) return

    const now = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = 'triangle' // much softer than sawtooth
    osc.frequency.setValueAtTime(220, now)
    osc.frequency.exponentialRampToValueAtTime(165, now + 0.25)
    // Soft attack, gentle decay
    gain.gain.setValueAtTime(0.001, now)
    gain.gain.linearRampToValueAtTime(0.08, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25)
    osc.connect(gain)
    gain.connect(this.masterGain)
    osc.start(now)
    osc.stop(now + 0.25)
  }

  /**
   * The Burrow view's close-up at the glass (Agents' Burrow's own little sounds): a dull knock on glass, a hard one, the
   * glass giving a little, a gentle press. Quieter than the source, at the level of the other sounds here.
   */
  playKnock(kind: 'knock' | 'thud' | 'crack' | 'pat') {
    this.ensureContext()
    if (!this.ctx || !this.masterGain) return
    const now = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    const [type, from, to, slide, peak, len]: [OscillatorType, number, number, number, number, number] =
      kind === 'knock' ? ['triangle', 210, 75, 0.07, 0.1, 0.11]
        : kind === 'thud' ? ['triangle', 150, 48, 0.12, 0.12, 0.18]
          : kind === 'crack' ? ['sawtooth', 1500, 260, 0.13, 0.045, 0.17]
            : ['sine', 300, 300, 0, 0.03, 0.08]
    osc.type = type
    osc.frequency.setValueAtTime(from, now)
    if (slide > 0) osc.frequency.exponentialRampToValueAtTime(to, now + slide)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + len)
    osc.connect(gain)
    gain.connect(this.masterGain)
    osc.start(now)
    osc.stop(now + len + 0.03)
  }

  dispose() {
    if (this.ctx) {
      this.ctx.close()
      this.ctx = null
      this.masterGain = null
    }
  }
}
