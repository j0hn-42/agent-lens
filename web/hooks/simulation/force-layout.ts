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
import { layoutInfo, createClusterForce, createCentringForce, centredChildren, familyOf, constrainToClusters, phaseSignature, spawnPosition, type ClusterNodeInfo, type SessionProjects } from './fleet-layout'
import { visibleAgents } from '../../lib/inactive-agents'

/** Ticks run synchronously when the node set changes, so a new cluster shows up near its place at once. */
export const SYNC_TICKS = 30
/** Alpha given to the simulation when the nodes change */
const SYNC_ALPHA = 0.3
/** Alpha given when agents only leave the simulation (#554): the ones left relax to the forces that remain */
const RESIZE_ALPHA = 0.1
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
  /** Agents in the simulation (the drawn ones) and agents left out of it at the last build */
  let simIds = new Set<string>()
  let leftOut = new Set<string>()
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
      if (!agent || agent.pinned || node.x === undefined || node.y === undefined) continue
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue
      if (Math.abs(agent.x - node.x) <= POSITION_EPSILON && Math.abs(agent.y - node.y) <= POSITION_EPSILON) continue
      if (out === agents) out = new Map(agents)
      out.set(node.id, { ...agent, x: node.x, y: node.y })
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

  /** True when the drawn agents are not exactly the ones in the simulation */
  const drawnChanged = (shown: ReadonlyMap<string, Agent>): boolean => {
    if (shown.size !== simIds.size) return true
    for (const id of shown.keys()) if (!simIds.has(id)) return true
    return false
  }

  /**
   * Put the drawn agents (and only them) in the simulation (#554). `keep` reuses the nodes already there (position,
   * velocity, held drag) rather than reading the agents. An agent that was left out and is drawn again comes back next
   * to its parent (as when it appeared), not at its last position, which the moves of its cluster may have left far away.
   * An agent the user pinned stays where it was put. Returns true when an agent was re-placed so.
   */
  const build = (agents: Map<string, Agent>, edges: readonly Edge[], keep: boolean): boolean => {
    const shown = visibleAgents(agents, hideInactive)
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
    info = layoutInfo(agents, lastTeams, lastProjects, hideInactive).info
    phasesKey = phaseSignature(agents, hideInactive, lastTeams)
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
      build(agents as Map<string, Agent>, edges, false)
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
      // An agent hidden or drawn again (it finished, the button was toggled): the simulation holds the drawn agents
      // only and the discs are resized to them (#554). Not a sync: no burst of ticks, everything is eased. Agents that
      // left warm it up a little (the ones left relax without the forces of the hidden ones); an agent drawn again is
      // re-placed next to its parent and warmed up like one that just appeared (see sync)
      if (drawnChanged(visibleAgents(state.agents, hideInactive))) {
        lastTeams = state.teams
        const warm = build(state.agents, state.edges, true) ? SYNC_ALPHA : RESIZE_ALPHA
        sim.alpha(Math.max(sim.alpha(), warm))
        centringBudget = CENTRING_TICKS
        active = true
      }
      // Not a sync: no reheating of the simulation, the centring alone eases the parent to its new middle
      if (refreshChildren(state.agents)) active = true
      // A phase of a workflow appearing in or leaving the display (its agents finish, get hidden) re-places the phases
      const phases = phaseSignature(state.agents, hideInactive, lastTeams)
      if (phases !== phasesKey) {
        phasesKey = phases
        info = layoutInfo(state.agents, lastTeams, lastProjects, hideInactive).info
        centringBudget = CENTRING_TICKS
        active = true
      }
      if (!active) return state
      tick()
      const agents = apply(state.agents)
      return agents === state.agents ? state : { ...state, agents }
    },
    setHideInactive(hide) { hideInactive = hide },
    pin(id, x, y) {
      const node = sim.nodes().find(n => n.id === id)
      if (!node) return
      node.fx = x
      node.fy = y
      node.x = x
      node.y = y
      active = true
    },
    get active() { return active },
    destroy() { sim.stop(); sim.nodes([]); info = new Map(); children = new Map(); family = new Map(); childrenKey = ''; phasesKey = ''; centringBudget = 0; simIds = new Set(); leftOut = new Set() },
  }
  return layout
}
