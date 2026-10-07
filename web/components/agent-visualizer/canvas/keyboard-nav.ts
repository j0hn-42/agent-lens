/**
 * Pure keyboard-navigation logic for the graph (WCAG 2.1.1, 2.4.3, 2.4.7).
 * The canvas wrapper maps keys to actions with `keyToAction`, and traverses
 * agents, then tool calls, then discoveries with `stepFocus`.
 * Runtime imports are relative so this file is unit-testable with node:test.
 */
import type { Agent, ToolCallNode, Discovery } from '../../../lib/agent-types'
import { CAMERA, MIN_VISIBLE_OPACITY } from '../../../lib/canvas-constants'

export type NavNodeType = 'agent' | 'tool' | 'discovery'
export interface NavNode { type: NavNodeType; id: string }

export function sameNode(a: NavNode | null, b: NavNode | null): boolean {
  return a === b || (!!a && !!b && a.type === b.type && a.id === b.id)
}

/** Focusable nodes in reading order: agents, then visible tool calls, then visible discoveries. */
export function buildNodeOrder(
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  discoveries: Discovery[],
): NavNode[] {
  const order: NavNode[] = []
  for (const [id, a] of agents) if (a.opacity >= MIN_VISIBLE_OPACITY) order.push({ type: 'agent', id })
  for (const [id, t] of toolCalls) if (t.opacity >= MIN_VISIBLE_OPACITY) order.push({ type: 'tool', id })
  for (const d of discoveries) if (d.opacity >= MIN_VISIBLE_OPACITY) order.push({ type: 'discovery', id: d.id })
  return order
}

/** Next/previous node with wrap-around. With no (or a stale) current node, start at the first/last one. */
export function stepFocus(order: NavNode[], current: NavNode | null, dir: 1 | -1): NavNode | null {
  if (order.length === 0) return null
  const idx = current ? order.findIndex(n => sameNode(n, current)) : -1
  if (idx === -1) return dir === 1 ? order[0] : order[order.length - 1]
  return order[(idx + dir + order.length) % order.length]
}

/** World position of a node, or null when it no longer exists. */
export function locateNode(
  node: NavNode,
  scene: { agents: Map<string, Agent>; toolCalls: Map<string, ToolCallNode>; discoveries: Discovery[] },
): { x: number; y: number } | null {
  if (node.type === 'agent') {
    const a = scene.agents.get(node.id)
    return a ? { x: a.x, y: a.y } : null
  }
  if (node.type === 'tool') {
    const t = scene.toolCalls.get(node.id)
    return t ? { x: t.x, y: t.y } : null
  }
  const d = scene.discoveries.find(x => x.id === node.id)
  return d ? { x: d.x, y: d.y } : null
}

export type KeyAction =
  | { kind: 'step'; dir: 1 | -1 }
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom'; factor: number }
  | { kind: 'fit' }
  | { kind: 'activate' }
  | { kind: 'contextmenu' }

export interface KeyLike {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/**
 * Map a key press to a graph action, or null to leave the event alone.
 * Delete (and any other unmapped key) deliberately does nothing.
 */
export function keyToAction(e: KeyLike): KeyAction | null {
  // Browser / OS shortcuts are never ours (also avoids clashing with Ctrl +/- page zoom)
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  const step = CAMERA.keyboardPanStep
  switch (e.key) {
    case 'ArrowRight':
      return e.shiftKey ? { kind: 'pan', dx: -step, dy: 0 } : { kind: 'step', dir: 1 }
    case 'ArrowDown':
      return e.shiftKey ? { kind: 'pan', dx: 0, dy: -step } : { kind: 'step', dir: 1 }
    case 'ArrowLeft':
      return e.shiftKey ? { kind: 'pan', dx: step, dy: 0 } : { kind: 'step', dir: -1 }
    case 'ArrowUp':
      return e.shiftKey ? { kind: 'pan', dx: 0, dy: step } : { kind: 'step', dir: -1 }
    case '+':
    case '=':
      return { kind: 'zoom', factor: CAMERA.keyboardZoomStep }
    case '-':
    case '_':
      return { kind: 'zoom', factor: 1 / CAMERA.keyboardZoomStep }
    case '0':
      return { kind: 'fit' }
    case 'Enter':
    case ' ':
      return { kind: 'activate' }
    case 'ContextMenu':
      return { kind: 'contextmenu' }
    case 'F10':
      return e.shiftKey ? { kind: 'contextmenu' } : null
    default:
      return null
  }
}
