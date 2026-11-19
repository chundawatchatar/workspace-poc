# Agent integrations

Each agent has a folder in `src/` containing its browser-safe `definition.ts` and `icon.ts`, its runtime `adapter.ts`,
and optional `tracking.ts`. Definitions describe identity, artwork, title rules and capabilities. Adapters handle
process detection, conversation metadata and resume commands; tracking translates native hooks into fixed events.

Import `@orch/agents` for definitions, types and title handling. Import `@orch/agents/runtime` only from host or daemon
code: it includes filesystem access and hook scripts. Neither entry depends on the UI or shared wire contracts.

To add an agent:

1. Add its folder, implementing `AgentDefinition` and `AgentAdapter`. Set its capabilities accurately and keep its
   native title, session and hook details there. Artwork is optional; the UI uses distinct initials without it.
2. Register the definition in `src/registry.ts` and its adapter in `src/runtime.ts`. Labels, kinds and tracking
   contracts follow the registry; registry tests enforce that both registries agree.
3. Test the agent-specific behaviour and run the repository checks. The daemon fingerprint includes nested agent
   sources, so development daemons running older code are detected.

The terminal package owns event transport, trust enforcement and common state precedence. Hook payloads remain
limited to fixed agent, state and reason fields; prompts and transcript contents never enter status events.
