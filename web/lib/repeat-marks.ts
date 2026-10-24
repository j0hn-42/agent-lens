/**
 * Loop and repeat marks of the agent nodes (#377). Pure (no React, no path aliases: node:test imports it).
 * A node is marked only when the simulation proves it:
 * - `loop`: the loop verdict of the agent is "loop" (lib/loop-detection, its own thresholds); a loop stays
 *   proven even when the history is partial;
 * - `repeated`: the ledger of repeated reads and calls (lib/waste) holds at least one finding for the agent,
 *   i.e. a second identical call under its rules. No threshold is added on top of the ledger's own rule.
 * The loop wins: one mark per node. An agent with no proof gets no mark, and the absence of a mark proves
 * nothing (the ledger is bounded, a loop can be missed). Only agents of the drawn scene are marked.
 */
import { findingText, type HealthVerdict, type LoopFinding } from './loop-detection'
import { describeWaste, listWaste, type WasteItem, type WasteLedger } from './waste'
import { PANEL_NAMES } from './ui-glossary'

export type RepeatMarkKind = 'loop' | 'repeated'

export type RepeatMark =
  | { kind: 'loop'; findings: LoopFinding[] }
  | { kind: 'repeated'; items: WasteItem[] }

/** What the ledger proves for a repeat, per tool (lib/waste): the words of the legend and of the tour. */
export const REPEAT_RULE_TEXT =
  'a file read again with no edit seen in between, the same Glob run again with no write seen in between, or the same Bash command run again right after itself'

/** Findings named in the text of a loop mark; the others are counted ("and N more") */
const LOOP_FINDINGS_SPOKEN = 2

export function repeatMarks(
  healthByAgent: ReadonlyMap<string, HealthVerdict> | undefined,
  waste: WasteLedger | undefined,
  agentIds: Iterable<string>,
): Map<string, RepeatMark> {
  const scene = new Set(agentIds)
  const marks = new Map<string, RepeatMark>()
  if (healthByAgent) {
    for (const [agentId, v] of healthByAgent) {
      if (scene.has(agentId) && v.status === 'loop' && v.findings.length > 0) marks.set(agentId, { kind: 'loop', findings: v.findings })
    }
  }
  if (waste && waste.items.size > 0) {
    // Costliest first, the order of the Files & repeats panel
    for (const item of listWaste(waste)) {
      if (!scene.has(item.agentId) || item.repeats < 1) continue
      const mark = marks.get(item.agentId)
      if (mark === undefined) marks.set(item.agentId, { kind: 'repeated', items: [item] })
      else if (mark.kind === 'repeated') mark.items.push(item)
    }
  }
  return marks
}

/**
 * Words of a mark for the screen-reader outline: `short` follows the state on the agent button, `detail` gives
 * the evidence. Facts only ("repeated", never "wasted"). The words follow the evidence: reads, calls or both.
 * A repeat mark names no file path (the canvas has no text, presentation mode, long paths). A loop mark speaks
 * the text of its findings (`findingText`), which names the base name of the file for a read, edit, failure
 * cycle: the screen-reader outline is not masked by presentation mode (docs/reading-the-ui.md).
 */
export function repeatMarkText(mark: RepeatMark, filesPanel: string = PANEL_NAMES.files): { short: string; detail: string } {
  if (mark.kind === 'loop') {
    const spoken = mark.findings.slice(0, LOOP_FINDINGS_SPOKEN).map(f => findingText(f))
    const more = mark.findings.length - spoken.length
    const tail = more > 0 ? `; and ${more} more in the Health section of the agent card` : ''
    return { short: 'loop observed', detail: `Loop observed: ${spoken.join('; ')}${tail}.` }
  }
  const [top] = mark.items
  const more = mark.items.length - 1
  const tail = more > 0 ? `; and ${more} more in the ${filesPanel} panel` : ''
  const reads = mark.items.some(i => i.kind === 'reread')
  const calls = mark.items.some(i => i.kind !== 'reread')
  const what = reads && calls ? 'reads and calls' : reads ? 'reads' : 'calls'
  return { short: `repeated ${what} observed`, detail: `Repeated ${what} observed: ${describeWaste(top)}${tail}.` }
}
