/** A file an agent needs under `<runtime>/agent/`, beside its shim. */
export interface AgentTrackerFile {
  name: string
  contents: string
  mode: number
}

/**
 * Everything tracking needs from one agent. `AgentAdapter.tracking` holds it, so
 * setting that field is all it takes to track another agent. See "Adding an
 * agent" in `docs/agents.md`.
 */
export interface AgentTracker {
  /** The name on `PATH` and the file in `bin/`. It can differ from the agent's kind, which is what events name. */
  program: string
  /** The shim's script, which starts with `shimStart`. */
  shim: string
  /**
   * The `case` arm of `orch-agent-hook`, named after the kind. It sets `agent`, `state` and `reason` to values from
   * fixed lists, never to free text, and leaves in the arguments only a program to run after the report.
   */
  hookBranch: string
  /** Files written with the shim. */
  files?: AgentTrackerFile[]
  /** The agent only reports that a turn ended, so the baseline says what happens during one. */
  turnEndOnly?: boolean
}
