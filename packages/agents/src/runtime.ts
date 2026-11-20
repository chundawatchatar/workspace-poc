import { adapter as claude } from './claude/adapter'
import { adapter as codex } from './codex/adapter'
import { adapter as commandcode } from './commandcode/adapter'
import { adapter as cursor } from './cursor/adapter'
import { adapter as opencode } from './opencode/adapter'
import { adapter as pi } from './pi/adapter'
import type { AgentKind } from './registry'
import type { AgentAdapter } from './runtime-types'

/** How each registered agent's process is recognised and its conversation resumed. */
export const AGENTS = [claude, codex, opencode, cursor, pi, commandcode] as const satisfies readonly AgentAdapter[]

/** The runtime adapter for a registered agent, or undefined if none was supplied. */
export function agentAdapter(kind: AgentKind): AgentAdapter | undefined {
  return AGENTS.find((agent) => agent.kind === kind)
}

/**
 * The source root used for development fingerprints. Packaged builds return
 * their embedded build id before reading any source directory.
 */
export const agentSourceDirectory = import.meta.dir

export type * from './runtime-types'
export * from './status'
