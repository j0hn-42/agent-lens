/**
 * Bloom post-processing for holographic glow effect.
 * Takes the main canvas, extracts bright areas, blurs them,
 * and composites back with additive blending.
 */

export class BloomRenderer {
  private bloomCanvas: HTMLCanvasElement
  private bloomCtx: CanvasRenderingContext2D
  private tempCanvas: HTMLCanvasElement
  private tempCtx: CanvasRenderingContext2D
  private intensity: number

  private enabled: boolean
  /** Frames since the blurred layer was last recomputed */
  private frame = 0
  /** The blur is recomputed every Nth frame; the cached layer is composited on the others */
  static readonly RECOMPUTE_EVERY = 2
  /** Bloom resolution relative to the main canvas (it is blurred anyway, so quarter resolution is invisible) */
  static readonly SCALE = 0.25

  constructor(intensity: number = 0.6) {
    this.intensity = intensity
    this.bloomCanvas = document.createElement('canvas')
    this.tempCanvas = document.createElement('canvas')
    const bCtx = this.bloomCanvas.getContext('2d')
    const tCtx = this.tempCanvas.getContext('2d')
    this.enabled = !!(bCtx && tCtx)
    this.bloomCtx = bCtx!
    this.tempCtx = tCtx!
  }

  resize(width: number, height: number): void {
    // Bloom at quarter resolution: the CSS blur filter is the most expensive part of a frame without
    // GPU acceleration, and its cost scales with the pixel count.
    const scale = BloomRenderer.SCALE
    this.bloomCanvas.width = Math.max(1, Math.round(width * scale))
    this.bloomCanvas.height = Math.max(1, Math.round(height * scale))
    this.tempCanvas.width = this.bloomCanvas.width
    this.tempCanvas.height = this.bloomCanvas.height
    this.frame = 0
  }

  apply(sourceCanvas: HTMLCanvasElement, targetCtx: CanvasRenderingContext2D): void {
    const w = this.bloomCanvas.width
    const h = this.bloomCanvas.height

    if (w === 0 || h === 0 || !this.enabled) return

    // Recompute the blurred layer every Nth frame; the glow moves slowly enough that the cached
    // layer is indistinguishable on the frames in between.
    if (this.frame % BloomRenderer.RECOMPUTE_EVERY === 0) {
      // Draw source at reduced resolution
      this.bloomCtx.clearRect(0, 0, w, h)
      this.bloomCtx.drawImage(sourceCanvas, 0, 0, w, h)

      // Blur passes (box blur approximation of gaussian); radii are halved with the resolution
      this.boxBlur(this.bloomCtx, this.tempCtx, w, h, 4)
      this.boxBlur(this.bloomCtx, this.tempCtx, w, h, 3)
      this.boxBlur(this.bloomCtx, this.tempCtx, w, h, 2)
    }
    this.frame++

    // Composite bloom over the target with additive blending
    targetCtx.save()
    targetCtx.globalCompositeOperation = 'lighter'
    targetCtx.globalAlpha = this.intensity
    targetCtx.drawImage(this.bloomCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height)
    targetCtx.restore()
  }

  private boxBlur(
    srcCtx: CanvasRenderingContext2D,
    tmpCtx: CanvasRenderingContext2D,
    w: number,
    h: number,
    radius: number,
  ): void {
    // Use CSS filter for fast blur
    tmpCtx.clearRect(0, 0, w, h)
    tmpCtx.filter = `blur(${radius}px)`
    tmpCtx.drawImage(srcCtx.canvas, 0, 0)
    tmpCtx.filter = 'none'

    srcCtx.clearRect(0, 0, w, h)
    srcCtx.drawImage(tmpCtx.canvas, 0, 0)
  }

  setIntensity(intensity: number): void {
    this.intensity = Math.max(0, Math.min(1, intensity))
  }
}
