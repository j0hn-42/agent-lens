/**
 * Per-session registry of subagents.
 *
 * Subagents are identified by the tool_use_id of the Agent/Task call that
 * spawned them (and by the agent_id / transcript file name when only the file
 * watcher has seen them). The human-readable description is only a label:
 * two parallel "Explore codebase" subagents must produce two distinct agents,
 * so the unique agent name is the label plus a ` #n` suffix on collision.
 */

import { ORCHESTRATOR_NAME } from './constants'

export interface SubagentRecord {
  /** Unique agent name used in events (label, or label + ' #n' on collision) */
  name: string
  /** Human-readable label (the Agent/Task description) */
  label: string
  /** Name of the agent that dispatched this subagent */
  parentName: string
  /** tool_use_id of the dispatching Agent/Task call, when known */
  toolUseId?: string
  /** Key of the subagent transcript file (agent_id) once matched */
  fileKey?: string
  /** True once agent_spawn has been emitted for this record */
  spawned: boolean
}

export class SubagentRegistry {
  private records: SubagentRecord[] = []
  private byToolUseId = new Map<string, SubagentRecord>()
  private byFileKey = new Map<string, SubagentRecord>()
  private nameUses = new Map<string, number>()

  private allocateName(label: string): string {
    const used = this.nameUses.get(label) ?? 0
    this.nameUses.set(label, used + 1)
    return used === 0 ? label : `${label} #${used + 1}`
  }

  private create(label: string, parentName: string): SubagentRecord {
    const record: SubagentRecord = { name: this.allocateName(label), label, parentName, spawned: false }
    this.records.push(record)
    return record
  }

  /** Register a dispatch (idempotent per toolUseId). Binds to a record created earlier
   *  by the file watcher for the same label when the dispatch was seen late. */
  registerDispatch(toolUseId: string, label: string, parentName: string): SubagentRecord {
    const existing = this.byToolUseId.get(toolUseId)
    if (existing) return existing
    const orphan = this.records.find(r => !r.toolUseId && r.label === label)
    const record = orphan ?? this.create(label, parentName)
    record.toolUseId = toolUseId
    this.byToolUseId.set(toolUseId, record)
    return record
  }

  getByToolUseId(toolUseId: string): SubagentRecord | undefined {
    return this.byToolUseId.get(toolUseId)
  }

  getByFileKey(fileKey: string): SubagentRecord | undefined {
    return this.byFileKey.get(fileKey)
  }

  /** Match a subagent transcript file to a record.
   *  Order: file key already claimed, explicit tool_use_id hint, first unclaimed
   *  dispatch with the same label, else a new file-only record. */
  claimForFile(fileKey: string, label: string, opts: { toolUseId?: string; parentName?: string } = {}): SubagentRecord {
    const claimed = this.byFileKey.get(fileKey)
    if (claimed) return claimed
    let record = opts.toolUseId ? this.byToolUseId.get(opts.toolUseId) : undefined
    if (record && record.fileKey) record = undefined
    if (!record) record = this.records.find(r => !r.fileKey && r.toolUseId && r.label === label)
    if (!record) record = this.create(label, opts.parentName ?? ORCHESTRATOR_NAME)
    record.fileKey = fileKey
    this.byFileKey.set(fileKey, record)
    return record
  }
}
