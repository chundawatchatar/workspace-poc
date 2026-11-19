import { basename, join } from 'node:path'
import { flagValue, recentTranscripts } from '../runtime/helpers'
import type { AgentAdapter } from '../runtime-types'
import { definition } from './definition'

/** The runtime integration for pi. */
export const adapter = {
  kind: definition.kind,
  exact: false,
  matches: (name) => name === 'pi',
  idFromArgs: (argv) => flagValue(argv, ['--session']),
  // Conversations are `agent/sessions/--<cwd with dashes>--/<timestamp>_<uuid>.jsonl`.
  findSessionId({ cwd, startedAt }, home) {
    const dir = join(home, '.pi', 'agent', 'sessions', `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`)
    const file = recentTranscripts([dir], startedAt)[0]
    return (file && basename(file, '.jsonl').split('_').pop()) || undefined
  },
  resumeCommand: (id) => (id ? `pi --session ${id}` : 'pi'),
} satisfies AgentAdapter
