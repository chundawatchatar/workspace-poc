import { adapter as claude } from './claude/adapter'
import { adapter as codex } from './codex/adapter'
import { adapter as commandcode } from './commandcode/adapter'
import { adapter as cursor } from './cursor/adapter'
import { adapter as opencode } from './opencode/adapter'
import { adapter as pi } from './pi/adapter'
import type { AgentKind } from './registry'
import type { AgentAdapter, AgentTracker } from './runtime-types'

export const AGENTS = [claude, codex, opencode, cursor, pi, commandcode] as const satisfies readonly AgentAdapter[]

type TrackedAgent = Extract<(typeof AGENTS)[number], { tracking: AgentTracker }>

/** The kinds that have `tracking`. Exact, so anything keyed by it fails to compile when it misses one. */
export type TrackedAgentKind = TrackedAgent['kind']

/** The kinds in `agents` that have `tracking`, in list order. */
export function trackedKinds(agents: readonly AgentAdapter[] = AGENTS): TrackedAgentKind[] {
  return agents.filter((agent): agent is TrackedAgent => agent.tracking !== undefined).map((agent) => agent.kind)
}

/** The runtime adapter for a registered agent, or undefined if none was supplied. */
export function agentAdapter(kind: AgentKind): AgentAdapter | undefined {
  return AGENTS.find((agent) => agent.kind === kind)
}

/**
 * The source root used for development fingerprints. Packaged builds return
 * their embedded build id before reading any source directory.
 */
export const agentSourceDirectory = import.meta.dir

export * from './claude/tracking'
export * from './codex/tracking'
export * from './runtime/events'
export * from './runtime/shim'
export type * from './runtime-types'
