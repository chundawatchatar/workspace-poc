import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { firstLine, flagValue, recentTranscripts, safeJson } from '../runtime/helpers'
import type { AgentAdapter } from '../runtime-types'
import { definition } from './definition'

/** The runtime integration for Command Code. */
export const adapter = {
  kind: definition.kind,
  exact: false,
  matches: (name) => name === 'cmd' || name === 'commandcode',
  idFromArgs: (argv) => flagValue(argv, ['--session', '--resume', '-r']),
  // Conversations are `projects/<slug>/<id>.jsonl`; the slug's rule is undocumented, so each project is checked.
  findSessionId({ cwd, startedAt }, home) {
    const root = join(home, '.commandcode', 'projects')
    let projects: string[]
    try {
      projects = readdirSync(root)
    } catch {
      return undefined
    }
    for (const file of recentTranscripts(
      projects.map((project) => join(root, project)),
      startedAt,
    )) {
      if (/\.(checkpoints|prompts)\.jsonl$/.test(file)) continue
      const header = safeJson(firstLine(file))
      if (header && Object.values(header).includes(cwd)) return basename(file, '.jsonl')
    }
    return undefined
  },
  resumeCommand: (id) => (id ? `cmd --session ${id}` : 'cmd'),
} satisfies AgentAdapter
