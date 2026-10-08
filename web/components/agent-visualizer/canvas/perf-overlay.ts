import { PERF_OVERLAY } from '@/lib/canvas-constants'

export interface PerfStats {
  frames: number
  lastFpsUpdate: number
  fps: number
  frameTimeMs: number
  frameTimes: number[]
  p95: number
}

export function createPerfStats(): PerfStats {
  return { frames: 0, lastFpsUpdate: 0, fps: 0, frameTimeMs: 0, frameTimes: [], p95: 0 }
}

export interface PerfCounts {
  agents: number
  toolCalls: number
  particles: number
  edges: number
  discoveries: number
}

/** Sample the frame time and paint the performance overlay (enabled via ?perf or ?stress). */
export function drawPerfOverlay(ctx: CanvasRenderingContext2D, perf: PerfStats, timestamp: number, counts: PerfCounts): void {
  const frameEnd = performance.now()
  const frameMs = frameEnd - (timestamp || frameEnd)
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
  ctx.fillText(`FPS: ${perf.fps}`, textX, textY); textY += po.lineHeight
  ctx.fillStyle = po.textColor
  ctx.fillText(`Frame: ${frameMs.toFixed(1)}ms  P95: ${perf.p95.toFixed(1)}ms`, textX, textY); textY += po.lineHeight
  ctx.fillText(`Agents: ${counts.agents}`, textX, textY); textY += po.lineHeight
  ctx.fillText(`Tool calls: ${counts.toolCalls}`, textX, textY); textY += po.lineHeight
  ctx.fillText(`Particles: ${counts.particles}`, textX, textY); textY += po.lineHeight
  ctx.fillText(`Edges: ${counts.edges}`, textX, textY); textY += po.lineHeight
  ctx.fillText(`Discoveries: ${counts.discoveries}`, textX, textY)
  ctx.restore()
}
