import { definition as claude } from './claude/definition'
import { definition as codex } from './codex/definition'
import { definition as commandcode } from './commandcode/definition'
import { definition as cursor } from './cursor/definition'
import { definition as opencode } from './opencode/definition'
import { definition as pi } from './pi/definition'
import type { AgentDefinition } from './types'

/** The registered agents, available to both the browser and the host. */
export const AGENT_DEFINITIONS = { claude, codex, opencode, cursor, pi, commandcode } as const

/** The agent identifiers used on the wire and in saved sessions. */
export type AgentKind = keyof typeof AGENT_DEFINITIONS

/** The agent kinds in their registration order. */
export const AGENT_KINDS = Object.keys(AGENT_DEFINITIONS) as AgentKind[]

/** The definition a renderer or title parser needs, including optional artwork. */
export function agentDefinition(kind: AgentKind): AgentDefinition {
  return AGENT_DEFINITIONS[kind]
}

/** The display name for each registered agent. */
export const AGENT_LABELS = Object.fromEntries(
  AGENT_KINDS.map((kind) => [kind, AGENT_DEFINITIONS[kind].label]),
) as Record<AgentKind, string>

/** The agents whose per-session hooks can report status. */
export type HookAgentKind = {
  [K in AgentKind]: (typeof AGENT_DEFINITIONS)[K]['capabilities']['hooks'] extends true ? K : never
}[AgentKind]

/** The kinds whose definitions advertise hook tracking. */
export const HOOK_AGENT_KINDS = AGENT_KINDS.filter(
  (kind): kind is HookAgentKind => AGENT_DEFINITIONS[kind].capabilities.hooks,
)
