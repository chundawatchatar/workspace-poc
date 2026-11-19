import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flagValue, safeJson } from '../runtime/helpers'
import type { AgentAdapter } from '../runtime-types'
import { definition } from './definition'
import { claudeTracking } from './tracking'

/** The runtime integration for Claude Code. */
export const adapter = {
  kind: definition.kind,
  exact: true,
  matches: (name) => name === 'claude',
  idFromArgs: (argv) => flagValue(argv, ['--resume', '-r']),
  // Claude Code keeps `sessions/<pid>.json` up to date, including after `/clear` or `/resume` change the conversation.
  // It names the id at startup, but the transcript, which `--resume` needs, is only written with the first message.
  findSessionId({ pid, cwd }, home) {
    try {
      const value = safeJson(readFileSync(join(home, '.claude', 'sessions', `${pid}.json`), 'utf8'))
      if (typeof value?.sessionId !== 'string') return undefined
      const project = (typeof value.cwd === 'string' ? value.cwd : cwd).replace(/[^a-zA-Z0-9]/g, '-')
      return existsSync(join(home, '.claude', 'projects', project, `${value.sessionId}.jsonl`)) ? value.sessionId : null
    } catch {
      return undefined
    }
  },
  resumeCommand: (id) => (id ? `claude --resume ${id}` : 'claude'),
  tracking: claudeTracking,
} satisfies AgentAdapter
