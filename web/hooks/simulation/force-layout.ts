/**
 * Force layout controller (#36): owns the d3-force simulation that places agents inside their
 * cluster discs. It never relies on d3's 'tick' event (simulation.tick() does not dispatch it):
 * positions are read straight from the simulation nodes after every tick and copied into the
 * agents. No React and no DOM: the hook and the integration tests drive it the same way.
 */
import { forceSimulation, forceLink, forceManyBody, forceCollide, type Simulation } from 'd3-force'
import type { Agent, Edge } from '../../lib/agent-types'
import { FORCE } from '../../lib/canvas-constants'
import type { ForceNode, ForceLink, SimulationState } from './types'
import { layoutInfo, createClusterForce, createCentringForce, centredChildren, familyOf, constrainToClusters, phaseSignature, spawnPosition, clusterRadius, type ClusterNodeInfo, type SessionProjects, type WorkspacePlacements } from './fleet-layout'
import { visibleAgents } from '../../lib/inactive-agents'

/** Ticks run synchronously when the node set changes, so a new cluster shows up near its place at once. */
export const SYNC_TICKS = 30
/** Alpha given to the simulation when the nodes change */
const SYNC_ALPHA = 0.3
/** Alpha given when the agents no longer drawn leave the simulation, or drawn agents enter it without being re-placed (#554) */
const RESIZE_ALPHA = 0.1
/**
 * An agent that stops being drawn (it finished, was deselected) stays in the simulation, undrawn, until its disc would
 * lose more than this share of its radius without the agents so kept (#554, review of #564). One agent finishing then
 * moves nothing, as before #554; the discs shrink in batches, or at the next rebuild (an agent appears, the filter is
 * toggled). 0.2: an orchestrator with 4 drawn children keeps up to 3 such agents (disc 460 instead of 370).
 */
const TRIM_SHARE = 0.2
/** Positions closer than this to the previous ones are not written back (no churn) */
const POSITION_EPSILON = 0.01
/** Ticks the centring may keep the layout awake once the simulation has cooled (children against the disc edge can leave a small gap for good) */
const CENTRING_TICKS = 600

export interface ForceLayout {
  /** Rebuild the nodes from the agents/edges, recompute the cluster anchors and run the initial ticks. */
  sync(agents: ReadonlyMap<string, Agent>, edges: readonly Edge[], teams: SimulationState['teams'], projects?: SessionProjects): void
  /** One simulation step; false when nothing moves any more (settled). */
  tick(): boolean
  /** Copy the simulation positions into the agents (same Map when nothing moved; pinned agents are never moved). */
  apply(agents: Map<string, Agent>): Map<string, Agent>
  /** sync + apply on a whole state */
  syncState(state: SimulationState, projects?: SessionProjects): SimulationState
  /** tick + apply on a whole state (one animation frame) */
  stepState(state: SimulationState): SimulationState
  /** Hold a node at a position (user drag): the simulation keeps it there and moves the others around it. */
  pin(id: string, x: number, y: number): void
  /**
   * 'Hide inactive agents': hidden children do not count when a parent is centred on its children (#151), and hidden
   * agents leave the simulation, their discs shrinking to the drawn agents (#554). Taken into account on the next step.
   */
  setHideInactive(hide: boolean): void
  /**
   * Agents the canvas draws although 'Hide inactive agents' hides them: the selected, hovered and keyboard-focused ones
   * (the same ids as sceneAgents). They are laid out like drawn agents: one that was out of the simulation comes back
   * next to its parent rather than at its last position. Taken into account on the next step.
   */
  setKeepIds(ids: ReadonlyArray<string | null | undefined>): void
  /**
   * Put a workspace zone with its centre at (x, y) (user drag): its agents are carried along at once, pinned ones
   * included, and the other workspaces keep their place or step aside to the nearest free one. Kept until reset.
   */
  moveWorkspace(projectId: string, x: number, y: number): void
  /** Centre of a workspace zone as laid out now; undefined when the project has no zone */
  workspaceCentre(projectId: string): { x: number; y: number } | undefined
  /** Every workspace moved by hand goes back to its automatic place */
  resetWorkspaces(): void
  /** Workspaces moved by hand (projectId -> centre), the last one moved last */
  readonly placements: WorkspacePlacements
  /** True while the layout still moves */
  readonly active: boolean
  destroy(): void
}

export function createForceLayout(): ForceLayout {
  let info = new Map<string, ClusterNodeInfo>()
  let active = false
  let hideInactive = false
  let children: Map<string, string[]> = new Map()
  let family: Map<string, string[]> = new Map()
  let childrenKey = ''
  let lastTeams: SimulationState['teams'] | undefined
  let lastProjects: SessionProjects | undefined
  let phasesKey = ''
  let centringBudget = 0
  /** Agents in the simulation (the drawn ones, and the ones no longer drawn not trimmed yet) and agents left out of it at the last build */
  let simIds = new Set<string>()
  let leftOut = new Set<string>()
  /** Agents of the simulation the discs are sized on (not the ones only a selection keeps drawn) */
  let countedIds = new Set<string>()
  /** Hidden agents the canvas still draws (see setKeepIds) */
  let keepIds: ReadonlyArray<string | null | undefined> = []
  /** The filter was toggled since the last step: the agents no longer drawn leave at once */
  let filterChanged = false
  /** Workspaces moved by hand, the agents the anchors were last computed from, and the centre of every zone */
  const placements = new Map<string, { x: number; y: number }>()
  let laidOut = new Map<string, Agent>()
  let centres = new Map<string, { x: number; y: number }>()
  const relayout = (agents: Map<string, Agent>): void => {
    laidOut = agents
    const r = layoutInfo(agents, lastTeams, lastProjects, false, placements)
    info = r.info
    centres = r.centres
  }
  const centring = createCentringForce(() => children, () => family, id => info.get(id))
  const sim: Simulation<ForceNode, ForceLink> = forceSimulation<ForceNode, ForceLink>([])
    .force('charge', forceManyBody().strength(FORCE.chargeStrength))
    .force('collide', forceCollide(FORCE.collideRadius))
    .force('link', forceLink<ForceNode, ForceLink>([]).id(d => d.id).distance(FORCE.linkDistance).strength(FORCE.linkStrength))
    // Last: it overrides the velocity of the held leads after the other forces added theirs
    .force('cluster', createClusterForce(id => info.get(id)))
    .force('centre', centring)
    .alphaDecay(FORCE.alphaDecay)
    .velocityDecay(FORCE.velocityDecay)
  // Stepped by hand only: never let d3's own timer run
  sim.stop()

  const tick = (): boolean => {
    sim.tick()
    const moving = constrainToClusters(sim.nodes(), id => info.get(id))
    const cooled = sim.alpha() < sim.alphaMin()
    if (cooled && centring.residual() > 0 && centringBudget > 0) centringBudget--
    active = moving || (centring.residual() > 0 && centringBudget > 0) || sim.alpha() >= sim.alphaMin()
    return active
  }

  const apply = (agents: Map<string, Agent>): Map<string, Agent> => {
    let out = agents
    for (const node of sim.nodes()) {
      const agent = agents.get(node.id)
      if (!agent) continue
      // A pinned agent is where it is held (it moves only with its workspace, see moveWorkspace)
      const x = agent.pinned ? node.fx : node.x
      const y = agent.pinned ? node.fy : node.y
      if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue
      if (Math.abs(agent.x - x) <= POSITION_EPSILON && Math.abs(agent.y - y) <= POSITION_EPSILON) continue
      if (out === agents) out = new Map(agents)
      out.set(node.id, { ...agent, x, y })
    }
    return out
  }

  /** Parents and the children they are centred on; true when that changed (a child appeared, finished or got hidden). */
  const refreshChildren = (agents: Map<string, Agent>): boolean => {
    children = centredChildren(agents, hideInactive)
    family = familyOf(agents)
    let key = ''
    for (const [parent, list] of children) key += `${parent}>${list.join(',')};`
    const changed = key !== childrenKey
    childrenKey = key
    if (changed) centringBudget = CENTRING_TICKS
    return changed
  }

  /**
   * Agents the filter draws (they size the discs) and agents the canvas draws: the same plus the hidden ones it keeps
   * (selection, hover, keyboard focus). A kept agent is laid out (collisions, link to its parent) but sizes nothing:
   * hovering or selecting a hidden agent must not move the clusters.
   */
  const drawnOf = (agents: Map<string, Agent>): { byFilter: Map<string, Agent>; drawn: Map<string, Agent> } => {
    const byFilter = visibleAgents(agents, hideInactive)
    return { byFilter, drawn: keepIds.some(Boolean) ? visibleAgents(agents, hideInactive, keepIds) : byFilter }
  }

  /** The agents of `members`, in the order of `agents` */
  const subset = (agents: Map<string, Agent>, members: ReadonlySet<string>): Map<string, Agent> => {
    const out = new Map<string, Agent>()
    for (const [id, a] of agents) if (members.has(id)) out.set(id, a)
    return out
  }

  /**
   * True when a disc held by agents no longer drawn would lose more than TRIM_SHARE of its radius without them. A
   * cluster none of whose agents is drawn any more does not count: it waits for the next rebuild, as before #554.
   */
  const undrawnTooMany = (drawn: ReadonlyMap<string, Agent>): boolean => {
    const held = new Map<string, number>()
    const shown = new Map<string, number>()
    for (const id of simIds) {
      const key = info.get(id)?.key
      if (key === undefined) continue
      held.set(key, (held.get(key) ?? 0) + 1)
      if (drawn.has(id)) shown.set(key, (shown.get(key) ?? 0) + 1)
    }
    for (const [key, n] of held) {
      const m = shown.get(key) ?? 0
      if (m === 0 || m === n) continue
      const r = clusterRadius(n)
      if (r - clusterRadius(m) > TRIM_SHARE * r) return true
    }
    return false
  }

  /**
   * Put `members` (the drawn agents, and the ones no longer drawn kept for now) in the simulation (#554); the discs and
   * the ring of the phases are sized on `counted` (the same less the agents only a selection keeps drawn). `keep`
   * reuses the nodes already there (position, velocity, held drag) rather than reading the agents. An agent that was left out and is drawn again comes back next to its parent (as
   * when it appeared), not at its last position, which the moves of its cluster may have left far away. An agent the
   * user pinned stays where it was put. Returns true when an agent was re-placed so.
   */
  const build = (
    agents: Map<string, Agent>, edges: readonly Edge[], members: ReadonlySet<string>, counted: ReadonlySet<string>, keep: boolean,
  ): boolean => {
    const shown = subset(agents, members)
    const previous = keep ? new Map(sim.nodes().map(n => [n.id, n])) : new Map<string, ForceNode>()
    let placed = shown
    let replaced = false
    const nodes: ForceNode[] = []
    for (const a of shown.values()) {
      const old = previous.get(a.id)
      if (old) { nodes.push(old); continue }
      let { x, y, vx, vy } = a
      if (leftOut.has(a.id) && a.parentId && !a.pinned) {
        ({ x, y } = spawnPosition(placed, { ...a, parentId: a.parentId }, lastTeams))
        vx = 0; vy = 0
        replaced = true
        // The next one re-placed around the same parent takes another free angle
        if (placed === shown) placed = new Map(shown)
        placed.set(a.id, { ...a, x, y })
      }
      nodes.push({ id: a.id, x, y, vx, vy, fx: a.pinned ? x : undefined, fy: a.pinned ? y : undefined })
    }
    const links: ForceLink[] = edges
      .filter(e => e.type === 'parent-child' && shown.has(e.from) && shown.has(e.to))
      .map(e => ({ id: e.id, source: e.from, target: e.to }))
    simIds = new Set(shown.keys())
    leftOut = new Set()
    for (const id of agents.keys()) if (!simIds.has(id)) leftOut.add(id)
    countedIds = new Set(counted)
    relayout(subset(agents, countedIds))
    phasesKey = phaseSignature(agents, false, lastTeams, countedIds)
    refreshChildren(agents)
    sim.nodes(nodes)
    const linkForce = sim.force('link') as ReturnType<typeof forceLink> | undefined
    if (linkForce) linkForce.links(links)
    return replaced
  }

  const layout: ForceLayout = {
    sync(agents, edges, teams, projects) {
      lastTeams = teams
      lastProjects = projects
      filterChanged = false
      const { byFilter, drawn } = drawnOf(agents as Map<string, Agent>)
      build(agents as Map<string, Agent>, edges, new Set(drawn.keys()), new Set(byFilter.keys()), false)
      sim.alpha(SYNC_ALPHA)
      active = true
      for (let i = 0; i < SYNC_TICKS; i++) tick()
    },
    tick,
    apply,
    syncState(state, projects) {
      layout.sync(state.agents, state.edges, state.teams, projects)
      const agents = apply(state.agents)
      return agents === state.agents ? state : { ...state, agents }
    },
    stepState(state) {
      // The simulation holds the drawn agents and the discs are sized on them (#554). Not a sync: no burst of ticks,
      // everything is eased. An agent drawn again that was out of the simulation is re-placed next to its parent and
      // warmed up like one that just appeared (see sync). An agent only a selection, the hover or the keyboard focus
      // keeps drawn is re-placed so too, but sizes nothing and warms nothing up: the clusters do not move for it. An
      // agent that stops being drawn (it finished, was deselected) stays in the simulation undrawn: nothing moves, as
      // before #554 (review of #564). Those agents leave when the filter is toggled or when a disc would lose more than
      // TRIM_SHARE of its radius without them: the discs are resized and the clusters move once for the whole batch
      const { byFilter, drawn } = drawnOf(state.agents)
      let counts = false
      for (const id of byFilter.keys()) if (!countedIds.has(id)) { counts = true; break }
      let enters = counts
      if (!enters) for (const id of drawn.keys()) if (!simIds.has(id)) { enters = true; break }
      let gone = false
      for (const id of simIds) if (!state.agents.has(id)) { gone = true; break }
      const undrawn = !enters && !gone ? simIds.size - drawn.size : 1
      const trim = undrawn > 0 && (filterChanged || undrawnTooMany(drawn))
      filterChanged = false
      if (enters || gone || trim) {
        lastTeams = state.teams
        const members = new Set(drawn.keys())
        if (!trim) for (const id of simIds) if (state.agents.has(id)) members.add(id)
        const counted = new Set<string>()
        for (const id of members) if (byFilter.has(id) || countedIds.has(id)) counted.add(id)
        const replaced = build(state.agents, state.edges, members, counted, true)
        // A trim warms up a little: the agents left relax into their smaller disc. An agent only kept drawn (selection,
        // hover, focus) or removed from the state warms nothing up
        if (counts || trim) sim.alpha(Math.max(sim.alpha(), counts && replaced ? SYNC_ALPHA : RESIZE_ALPHA))
        centringBudget = CENTRING_TICKS
        active = true
      }
      // Not a sync: no reheating of the simulation, the centring alone eases the parent to its new middle
      if (refreshChildren(state.agents)) active = true
      // A phase of a workflow appearing in or leaving the simulation re-places the phases
      const phases = phaseSignature(state.agents, false, lastTeams, countedIds)
      if (phases !== phasesKey) {
        phasesKey = phases
        relayout(subset(state.agents, countedIds))
        centringBudget = CENTRING_TICKS
        active = true
      }
      if (!active) return state
      tick()
      const agents = apply(state.agents)
      return agents === state.agents ? state : { ...state, agents }
    },
    setHideInactive(hide) {
      if (hide !== hideInactive) filterChanged = true
      hideInactive = hide
    },
    setKeepIds(ids) { keepIds = ids },
    pin(id, x, y) {
      const node = sim.nodes().find(n => n.id === id)
      if (!node) return
      node.fx = x
      node.fy = y
      node.x = x
      node.y = y
      active = true
    },
    moveWorkspace(projectId, x, y) {
      if (!centres.has(projectId) || !Number.isFinite(x) || !Number.isFinite(y)) return
      const before = info
      // Moved last: it keeps its place over the others
      placements.delete(projectId)
      placements.set(projectId, { x, y })
      relayout(laidOut)
      // The dragged workspace follows the pointer: each of its agents is carried by the shift of its cluster anchor
      for (const node of sim.nodes()) {
        const was = before.get(node.id)
        const now = info.get(node.id)
        if (!was || !now || now.projectId !== projectId || node.x === undefined || node.y === undefined) continue
        const dx = now.anchor.x - was.anchor.x
        const dy = now.anchor.y - was.anchor.y
        node.x += dx
        node.y += dy
        if (node.fx != null) node.fx += dx
        if (node.fy != null) node.fy += dy
      }
      // The workspaces that step aside are eased to their new place
      sim.alpha(Math.max(sim.alpha(), SYNC_ALPHA))
      centringBudget = CENTRING_TICKS
      active = true
    },
    workspaceCentre(projectId) {
      const c = centres.get(projectId)
      return c ? { x: c.x, y: c.y } : undefined
    },
    resetWorkspaces() {
      if (placements.size === 0) return
      placements.clear()
      relayout(laidOut)
      sim.alpha(Math.max(sim.alpha(), SYNC_ALPHA))
      centringBudget = CENTRING_TICKS
      active = true
    },
    get placements() { return placements },
    get active() { return active },
    destroy() { sim.stop(); sim.nodes([]); info = new Map(); placements.clear(); laidOut = new Map(); centres = new Map(); children = new Map(); family = new Map(); childrenKey = ''; phasesKey = ''; centringBudget = 0; simIds = new Set(); leftOut = new Set(); countedIds = new Set(); keepIds = []; filterChanged = false },
  }
  return layout
}
