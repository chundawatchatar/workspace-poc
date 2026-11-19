import { flagValue } from '../runtime/helpers'
import type { AgentAdapter } from '../runtime-types'
import { definition } from './definition'

/** The runtime integration for Cursor Agent. */
export const adapter = {
  kind: definition.kind,
  exact: false,
  matches: (name, command) => name === 'cursor-agent' || (name === 'agent' && command.includes('cursor')),
  idFromArgs: (argv) => flagValue(argv, ['--resume']),
  // Cursor's undocumented chat store changes between releases, so only its command-line id is used.
  findSessionId: () => undefined,
  resumeCommand: (id) => (id ? `cursor-agent --resume ${id}` : 'cursor-agent resume'),
} satisfies AgentAdapter
