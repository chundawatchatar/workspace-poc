# Agent integrations

Each agent has a folder in `src/` with what really differs per agent: its browser-safe `definition.ts` (name,
initials, title rules) and `icon.ts`, and its runtime `adapter.ts` (how its process is recognised, where its
conversations are and how one is resumed).

Status is not per agent. Every agent reports it through the Program Status Protocol (OSC 7501) in its own terminal
output, read by the one reader in `packages/terminal/src/program-status.ts` into the standard status defined here in
`src/status.ts`. An agent that doesn't speak the protocol shows no status, so supporting a new agent's status needs no
code. See `docs/agents.md`.

Import `@orch/agents` for definitions, the standard status, types and title handling. Import `@orch/agents/runtime`
only from host or daemon code: it reads the agents' files. Neither entry depends on the UI or shared wire contracts.

To add an agent:

1. Add its folder, implementing `AgentDefinition` and `AgentAdapter`. Artwork is optional; the UI uses distinct
   initials without it.
2. Register the definition in `src/registry.ts` and its adapter in `src/runtime.ts`. The registry test checks that
   both registries agree.
3. Test the agent-specific behaviour and run the repository checks. The daemon fingerprint includes nested agent
   sources, so development daemons running older code are detected.
