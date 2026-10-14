import { PERF_OVERLAY } from '@/lib/canvas-constants'

export interface PerfStats {
  frames: number
  lastFpsUpdate: number
  fps: number
  frameTimeMs: number
  frameTimes: number[]
  p95: number
  /** Paint calls (fill, stroke, text, image, rect) of the last drawn frame, counted while ?perf is on */
  drawCalls: number
  /** Frames drawn / skipped by the idle gate since the start */
  drawnFrames: number
  skippedFrames: number
}

export function createPerfStats(): PerfStats {
  return { frames: 0, lastFpsUpdate: 0, fps: 0, frameTimeMs: 0, frameTimes: [], p95: 0, drawCalls: 0, drawnFrames: 0, skippedFrames: 0 }
}

export interface PerfCounts {
  agents: number
  toolCalls: number
  particles: number
  edges: number
  discoveries: number
}

const PAINT_METHODS = ['fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'fillRect', 'strokeRect', 'clearRect'] as const
const counted = new WeakSet<object>()

/** Wrap the paint methods of the context so each call increments `perf.drawCalls` (debug only, ?perf). */
export function countPaintCalls(ctx: CanvasRenderingContext2D, perf: PerfStats): void {
  if (counted.has(ctx)) return
  counted.add(ctx)
  const target = ctx as unknown as Record<string, (...a: unknown[]) => unknown>
  for (const m of PAINT_METHODS) {
    const original = target[m].bind(ctx)
    target[m] = (...args: unknown[]) => { perf.drawCalls++; return original(...args) }
  }
}

/** Last measurement, readable from the console or a browser test: `window.__agentLensPerf` */
export interface PerfSnapshot {
  fps: number
  frameMs: number
  p95Ms: number
  drawCalls: number
  drawnFrames: number
  skippedFrames: number
  agents: number
  toolCalls: number
  particles: number
  edges: number
  baseline: boolean
}

/** Sample the frame time and paint the performance overlay (enabled via ?perf or ?stress). */
export function drawPerfOverlay(ctx: CanvasRenderingContext2D, perf: PerfStats, frameStart: number, counts: PerfCounts, baseline = false): void {
  const frameEnd = performance.now()
  // Taken before the overlay paints itself
  const drawCalls = perf.drawCalls
  // Work time of the frame (scene sync, planning, every draw pass), not the wait for the next vsync
  const frameMs = frameEnd - frameStart
  perf.frameTimes.push(frameMs)
  if (perf.frameTimes.length > PERF_OVERLAY.maxFrameSamples) perf.frameTimes.shift()
  perf.frames++
  perf.frameTimeMs = frameMs
  if (frameEnd - perf.lastFpsUpdate >= PERF_OVERLAY.updateIntervalMs) {
    perf.fps = perf.frames
    perf.frames = 0
    perf.lastFpsUpdate = frameEnd
    const sorted = [...perf.frameTimes].sort((a, b) => a - b)
    perf.p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
  }
  const po = PERF_OVERLAY
  const textX = po.x + po.padding
  let textY = po.y + po.lineHeight + 2
  ctx.save()
  ctx.fillStyle = po.bgColor
  ctx.fillRect(po.x, po.y, po.width, po.height)
  ctx.font = po.font
  ctx.fillStyle = perf.fps < po.fpsWarning ? po.fpsWarningColor : perf.fps < po.fpsCaution ? po.fpsCautionColor : po.fpsGoodColor
  const skipped = perf.skippedFrames
  ctx.fillText(`FPS drawn: ${perf.fps}${baseline ? '  (baseline)' : ''}`, textX, textY); textY += po.lineHeight
  ctx.fillStyle = po.textColor
  ctx.fillText(`Frame: ${frameMs.toFixed(1)}ms  P95: ${perf.p95.toFixed(1)}ms`, textX, textY); textY += po.lineHeight
  ctx.fillText(`Draw calls: ${drawCalls}  Skipped: ${skipped}`, textX, textY); textY += po.lineHeight
  ctx.fillText(`Agents: ${counts.agents}`, textX, textY); textY += po.lineHeight
  ctx.fillText(`Tool calls: ${counts.toolCalls}`, textX, textY); textY += po.lineHeight
  ctx.fillText(`Particles: ${counts.particles}`, textX, textY); textY += po.lineHeight
  ctx.fillText(`Edges: ${counts.edges}`, textX, textY); textY += po.lineHeight
  ctx.fillText(`Discoveries: ${counts.discoveries}`, textX, textY)
  ctx.restore()
  const snapshot: PerfSnapshot = {
    fps: perf.fps, frameMs, p95Ms: perf.p95, drawCalls, drawnFrames: perf.drawnFrames, skippedFrames: perf.skippedFrames,
    agents: counts.agents, toolCalls: counts.toolCalls, particles: counts.particles, edges: counts.edges, baseline,
  }
  ;(window as unknown as { __agentLensPerf?: PerfSnapshot }).__agentLensPerf = snapshot
}
