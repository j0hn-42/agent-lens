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
import { layoutInfo, createClusterForce, createCentringForce, centredChildren, familyOf, constrainToClusters, phaseSignature, type ClusterNodeInfo, type SessionProjects } from './fleet-layout'

/** Ticks run synchronously when the node set changes, so a new cluster shows up near its place at once. */
export const SYNC_TICKS = 30
/** Alpha given to the simulation when the nodes change */
const SYNC_ALPHA = 0.3
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
  /** 'Hide inactive agents' (#151): hidden children do not count when a parent is centred on its children. */
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

  const layout: ForceLayout = {
    sync(agents, edges, teams, projects) {
      const nodes: ForceNode[] = Array.from(agents.values()).map(a => ({
        id: a.id,
        x: a.x, y: a.y,
        vx: a.vx, vy: a.vy,
        fx: a.pinned ? a.x : undefined,
        fy: a.pinned ? a.y : undefined,
      }))
      const links: ForceLink[] = edges
        .filter(e => e.type === 'parent-child' && agents.has(e.from) && agents.has(e.to))
        .map(e => ({ id: e.id, source: e.from, target: e.to }))
      lastTeams = teams
      lastProjects = projects
      info = layoutInfo(agents, teams, projects, hideInactive).info
      phasesKey = phaseSignature(agents as Map<string, Agent>, hideInactive, teams)
      refreshChildren(agents as Map<string, Agent>)
      sim.nodes(nodes)
      const linkForce = sim.force('link') as ReturnType<typeof forceLink> | undefined
      if (linkForce) linkForce.links(links)
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
    destroy() { sim.stop(); sim.nodes([]); info = new Map(); children = new Map(); family = new Map(); childrenKey = ''; phasesKey = ''; centringBudget = 0 },
  }
  return layout
}
