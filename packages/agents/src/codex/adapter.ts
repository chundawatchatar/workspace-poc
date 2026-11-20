import { join } from 'node:path'
import { firstLine, recentTranscripts, safeJson } from '../runtime/helpers'
import type { AgentAdapter } from '../runtime-types'
import { definition } from './definition'

/** The word after a subcommand, as in `codex resume <id>`. */
function subcommandValue(argv: string[], subcommand: string): string | null {
  const index = argv.indexOf(subcommand)
  const value = index === -1 ? undefined : argv[index + 1]
  return value && !value.startsWith('-') ? value : null
}

/** `YYYY/MM/DD` for each of the last 30 local days, newest first: Codex files sessions by the day they began. */
function recentDays(): string[] {
  const days: string[] = []
  const day = new Date()
  for (let i = 0; i < 30; i++) {
    const pad = (n: number) => String(n).padStart(2, '0')
    days.push(`${day.getFullYear()}/${pad(day.getMonth() + 1)}/${pad(day.getDate())}`)
    day.setDate(day.getDate() - 1)
  }
  return days
}

/** The runtime integration for Codex. */
export const adapter = {
  kind: definition.kind,
  exact: false,
  matches: (name) => name === 'codex',
  idFromArgs: (argv) => subcommandValue(argv, 'resume'),
  // Each conversation is `sessions/YYYY/MM/DD/rollout-*.jsonl`, whose first line names its id and cwd. The file is
  // written with the first message, so before that there is nothing to resume. A resumed conversation keeps
  // appending to the file of the day it began, so older days are searched for files written since the start.
  findSessionId({ cwd, startedAt }, home) {
    const days = recentDays().map((day) => join(home, '.codex', 'sessions', day))
    for (const file of recentTranscripts(days, startedAt)) {
      const meta = safeJson(firstLine(file))
      const payload = meta?.type === 'session_meta' ? (meta.payload as Record<string, unknown>) : null
      if (payload?.cwd === cwd && typeof payload.id === 'string') return payload.id
    }
    return undefined
  },
  resumeCommand: (id) => (id ? `codex resume ${id}` : 'codex'),
} satisfies AgentAdapter
