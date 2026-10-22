import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The terminal backends the host can be started with: in-process Bun, or a persistent Bun daemon. */
export type TerminalBackend = 'memory' | 'bun'

/** Reads the selected terminal backend; the environment overrides the local prototype setting. */
export function terminalBackend(hostRoot: string): TerminalBackend {
  const file = join(hostRoot, '.data', 'terminal-backend.json')
  const backend: unknown =
    process.env.ORCH_TERMINAL_BACKEND ?? (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).backend : 'memory')
  if (backend !== 'memory' && backend !== 'bun') throw new Error('Terminal backend must be memory or bun')
  return backend
}
