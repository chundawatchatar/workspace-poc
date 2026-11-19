import { homedir } from 'node:os'
import { basename } from 'node:path'
import { AGENTS, agentAdapter } from '@orch/agents/runtime'
import type { AgentKind, AgentRef, ProcessInfo } from '@orch/shared'

export {
  AGENTS,
  type AgentAdapter,
  type AgentProcess,
  agentAdapter,
  type TrackedAgentKind,
  trackedKinds,
} from '@orch/agents/runtime'

/** Session ids are typed into a shell, so anything beyond these characters is refused. */
const SAFE_ID = /^[\w.:-]{1,128}$/

/** The command that resumes `ref`. An id that is unsafe to type into a shell is treated as no id. */
export function resumeCommand(ref: AgentRef): string | null {
  const adapter = agentAdapter(ref.kind)
  if (!adapter?.resumeCommand) return null
  return adapter.resumeCommand(ref.sessionId && SAFE_ID.test(ref.sessionId) ? ref.sessionId : null)
}

const RUNTIMES = new Set(['node', 'bun', 'deno'])

/** The program and its arguments. A script run by a runtime, as in `node /usr/local/bin/claude`, is named after it. */
function program({ name, command }: ProcessInfo): { name: string; argv: string[] } {
  const argv = command.split(/\s+/).slice(1)
  const script = RUNTIMES.has(name) ? argv.findIndex((word) => !word.startsWith('-')) : -1
  if (script === -1) return { name, argv }
  return { name: basename(argv[script]).replace(/\.[cm]?js$/, ''), argv: argv.slice(script + 1) }
}

function adapterFor(process: ProcessInfo) {
  const { name, argv } = program(process)
  const adapter = AGENTS.find((agent) => agent.matches(name, process.command))
  return adapter && { adapter, argv }
}

/** The agent `process` is, if any. */
export function agentKind(process: ProcessInfo): AgentKind | null {
  return adapterFor(process)?.adapter.kind ?? null
}

/**
 * Identifies the agent a terminal is running and, when it can be found, the conversation it is in. Pass
 * `guess: false` when another process of the same agent runs in the same folder, so neither takes the other's.
 */
export function detectAgent(process: ProcessInfo, cwd: string | null, home = homedir(), guess = true): AgentRef | null {
  const found = adapterFor(process)
  if (!found || !cwd) return null
  const { adapter, argv } = found
  let current: string | null | undefined
  if (adapter.exact || guess) {
    try {
      current = adapter.findSessionId({ pid: process.pid, cwd, startedAt: process.startedAt }, home)
    } catch {
      current = undefined
    }
  }
  // The arguments only name the conversation the process began in, so they count when its files don't tell.
  const sessionId = current === undefined ? adapter.idFromArgs(argv) : current
  return { kind: adapter.kind, sessionId: sessionId && SAFE_ID.test(sessionId) ? sessionId : null, cwd }
}
