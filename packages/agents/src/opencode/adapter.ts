import { flagValue } from '../runtime/helpers'
import type { AgentAdapter } from '../runtime-types'
import { definition } from './definition'

/** The runtime integration for OpenCode. */
export const adapter = {
  kind: definition.kind,
  exact: false,
  matches: (name) => name === 'opencode',
  idFromArgs: (argv) => flagValue(argv, ['--session', '-s']),
  // OpenCode stores conversations in SQLite, so only an id from its command line is used.
  findSessionId: () => undefined,
  resumeCommand: (id) => (id ? `opencode --session ${id}` : 'opencode --continue'),
} satisfies AgentAdapter
